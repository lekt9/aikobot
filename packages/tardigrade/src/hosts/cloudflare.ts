/**
 * Cloudflare Workers host for the Eliza actor: each thread is a SQLite-backed
 * Durable Object whose event log is the durable execution history, and the
 * Worker resumes unfinished turns through alarms. One deployment serves many
 * owners: a verified owner token scopes every actor route to
 * `user.<owner>.<instance>`, the ACTORS/THREADS namespaces handed to the
 * Durable Objects refuse another owner's coordinates, and the per-thread
 * layer carries the owner as `ElizaOwner`. The static `TARDIGRADE_TOKEN`
 * bearer, when configured, still reaches unscoped instances for operators.
 */

import { Layer } from "effect";
import type { KeyValueStore } from "effect/unstable/persistence";
import {
  type CloudflareWorkerLayerContext,
  defineWorkerHost,
  type Env,
  type WorkerHost,
  workerHttp,
  type workerModelServices,
} from "tardie/cloudflare";
import type { HostPorts } from "tardie/host/ports";
import type { ElizaActor, ElizaTurnServices } from "../actor";
import {
  type Authenticate,
  type AuthenticatedOwner,
  bearerOf,
  type OwnerTokenEnv,
  ownerTokenAuthenticate,
} from "./auth";
import {
  ElizaOwner,
  instanceOwner,
  isScopedInstance,
  isScopedObject,
  objectOwner,
  ownerOfInstance,
  scopedNamespace,
  userInstance,
  validateOwner,
} from "./identity";

export interface ElizaWorkerEnv extends Env, OwnerTokenEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly ELIZA_TARDIGRADE_MODEL?: string;
  readonly ELIZA_TARDIGRADE_MODEL_PROVIDER?: string;
  readonly ELIZA_TARDIGRADE_AGENT_KEY?: string;
  readonly TARDIGRADE_TOKEN?: string;
}

export type ElizaWorkerLayer = Layer.Layer<
  ElizaTurnServices,
  never,
  HostPorts | KeyValueStore.KeyValueStore
>;

export interface ElizaWorkerLayerContext
  extends CloudflareWorkerLayerContext<ElizaWorkerEnv> {
  /** The owner the thread belongs to: the token scope or the plain instance. */
  readonly owner: string;
}

export type ElizaIdentityMode = "owner-token" | "operator";

export interface ElizaWorkerOptions {
  readonly actor: ElizaActor;
  readonly layersFor: (context: ElizaWorkerLayerContext) => ElizaWorkerLayer;
  /** Defaults to owner tokens from `ELIZA_OWNER_TOKEN_SECRET`. */
  readonly authenticate?: Authenticate<ElizaWorkerEnv>;
  /**
   * Model adapters and an optional deployment catalog. An actor that calls
   * the model through Tardigrade's own `Infer` needs these; one that brings
   * its own model port does not.
   */
  readonly services?: ReturnType<typeof workerModelServices>;
}

export interface ElizaWorkerHost {
  readonly host: WorkerHost<ElizaWorkerEnv>;
  readonly ActorDO: WorkerHost<ElizaWorkerEnv>["ActorDO"];
  readonly ThreadDO: WorkerHost<ElizaWorkerEnv>["ThreadDO"];
  readonly fetch: NonNullable<ExportedHandler<ElizaWorkerEnv>["fetch"]>;
  /** The identity modes a deployment's environment enables. */
  readonly modes: (env: ElizaWorkerEnv) => ReadonlyArray<ElizaIdentityMode>;
}

/** Routes that need no owner scope once the caller is authenticated. */
const UNSCOPED_PATHS = new Set([
  "/healthz",
  "/v1/metadata",
  "/v1/models",
  "/v1/providers",
]);
const ACTOR_ROUTE = /^\/v1\/actors\/([^/]+)(.*)$/;

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Authorization");
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  return new Response(response.body, { status: response.status, headers });
}

function failure(status: 401 | 403 | 404 | 503, code: string): Response {
  return privateResponse(
    Response.json(
      {
        error:
          status === 401
            ? "unauthorized"
            : status === 403
              ? "forbidden"
              : status === 404
                ? "not found"
                : "unavailable",
        code,
      },
      { status },
    ),
  );
}

function scopedEnv(env: ElizaWorkerEnv, owner: string): ElizaWorkerEnv {
  return {
    ...env,
    ACTORS: scopedNamespace(env.ACTORS, owner),
    THREADS: scopedNamespace(env.THREADS, owner),
  };
}

/** Env for a Durable Object: scoped to its owner when its coordinate is scoped. */
function objectEnv(
  env: ElizaWorkerEnv,
  name: string | undefined,
): ElizaWorkerEnv {
  return isScopedObject(name) ? scopedEnv(env, objectOwner(name)) : env;
}

function identityModes(env: ElizaWorkerEnv): ReadonlyArray<ElizaIdentityMode> {
  const modes: ElizaIdentityMode[] = [];
  if (env.ELIZA_OWNER_TOKEN_SECRET) modes.push("owner-token");
  if (env.TARDIGRADE_TOKEN) modes.push("operator");
  return modes;
}

/**
 * Mounts the actor once per Worker module. Export the returned `ActorDO`,
 * `ThreadDO`, and `fetch` from the Worker entry.
 */
export function defineElizaWorker(
  options: ElizaWorkerOptions,
): ElizaWorkerHost {
  const authenticate =
    options.authenticate ?? ownerTokenAuthenticate<ElizaWorkerEnv>();
  const host = defineWorkerHost<
    Parameters<
      (typeof options.actor.components)[number]["machine"]["output"]
    >[0] extends never
      ? never
      : ElizaTurnServices | ElizaOwner | HostPorts,
    ElizaActor["methods"],
    ElizaWorkerEnv
  >(
    options.actor as never,
    {
      layersFor: ((context: CloudflareWorkerLayerContext<ElizaWorkerEnv>) => {
        const owner = ownerOfInstance(context.actorInstance);
        return Layer.mergeAll(
          Layer.succeed(ElizaOwner, {
            owner,
            scoped: isScopedInstance(context.actorInstance),
          }),
          options.layersFor({ ...context, owner }),
        );
      }) as never,
      ...(options.services === undefined ? {} : { services: options.services }),
    } as never,
  );
  const native = workerHttp(host);

  class ActorDO extends host.ActorDO {
    constructor(ctx: DurableObjectState, env: ElizaWorkerEnv) {
      super(ctx, objectEnv(env, ctx.id.name));
    }
  }
  class ThreadDO extends host.ThreadDO {
    constructor(ctx: DurableObjectState, env: ElizaWorkerEnv) {
      super(ctx, objectEnv(env, ctx.id.name));
    }
  }

  const scopedFetch = async (
    request: Request,
    env: ElizaWorkerEnv,
    context: ExecutionContext,
    auth: AuthenticatedOwner,
  ): Promise<Response> => {
    const owner = validateOwner(auth.ownerId);
    const url = new URL(request.url);
    const match = ACTOR_ROUTE.exec(url.pathname);
    if (match) {
      // Clients echo the scoped name back from earlier responses (thread
      // coordinates, method targets); keep it when it is this owner's, scope a
      // plain name, and refuse another owner's scope outright.
      const requested = decodeURIComponent(match[1] as string);
      let instance: string;
      if (isScopedInstance(requested)) {
        if (instanceOwner(requested) !== owner) {
          return failure(403, "TARDIGRADE_FOREIGN_OWNER");
        }
        instance = requested;
      } else {
        instance = userInstance(owner, requested);
      }
      url.pathname = `/v1/actors/${encodeURIComponent(instance)}${match[2] ?? ""}`;
    } else if (
      !UNSCOPED_PATHS.has(url.pathname) &&
      !url.pathname.startsWith("/v1/models/") &&
      !url.pathname.startsWith("/v1/providers/")
    ) {
      return failure(404, "TARDIGRADE_ROUTE_UNSCOPED");
    }
    // Tardigrade's own bearer guard stays active: the verified owner token is
    // the request-local bearer it compares against. No shared bearer leaks in.
    const response = await native.fetch(
      new Request(url, request) as never,
      { ...scopedEnv(env, owner), TARDIGRADE_TOKEN: auth.token } as never,
      context,
    );
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      return privateResponse(response);
    }
    // A stream outlives the token it was opened with; re-check per chunk so an
    // expired or revoked delegation closes the stream instead of draining it.
    const reader = response.body.getReader();
    return privateResponse(
      new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = await reader.read();
            const fresh = await authenticate(request, env);
            if (fresh === null || fresh.ownerId !== owner) {
              await reader.cancel();
              controller.close();
              return;
            }
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          },
          cancel: (reason) => reader.cancel(reason),
        }),
        response,
      ),
    );
  };

  const fetch: ElizaWorkerHost["fetch"] = async (request, env, context) => {
    const modes = identityModes(env);
    const bearer = bearerOf(request);
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return native.fetch(request as never, env as never, context);
    }
    if (
      modes.includes("operator") &&
      bearer !== null &&
      bearer === env.TARDIGRADE_TOKEN
    ) {
      return native.fetch(request as never, env as never, context);
    }
    if (!modes.includes("owner-token")) {
      return native.fetch(request as never, env as never, context);
    }
    try {
      const auth = await authenticate(request, env);
      if (auth === null) return failure(401, "TARDIGRADE_OWNER_TOKEN_REQUIRED");
      return await scopedFetch(request, env, context, auth);
    } catch (cause) {
      // error-policy:J1 The Worker boundary answers identity failures with a
      // structured status; the cause is logged by the platform, never echoed.
      console.error(
        JSON.stringify({
          type: "ElizaWorkerIdentityFailure",
          message: cause instanceof Error ? cause.message : String(cause),
          code: (cause as { code?: string }).code ?? null,
        }),
      );
      return failure(
        (cause as { code?: string }).code === "TARDIGRADE_FOREIGN_OWNER"
          ? 403
          : 503,
        (cause as { code?: string }).code ?? "TARDIGRADE_IDENTITY_FAILURE",
      );
    }
  };

  return { host, ActorDO, ThreadDO, fetch, modes: identityModes };
}

/**
 * The single-owner mount kept for callers that scope nothing: identical to
 * `defineElizaWorker` with only the operator bearer configured.
 */
export function defineElizaWorkerHost(
  actor: ElizaActor,
  layersFor: (context: ElizaWorkerLayerContext) => ElizaWorkerLayer,
): ElizaWorkerHost {
  return defineElizaWorker({ actor, layersFor });
}
