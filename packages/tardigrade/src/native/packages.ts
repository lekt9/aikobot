/**
 * elizaOS plugins as Tardigrade code-mode packages. Each declared plugin
 * becomes one package whose methods are its actions: the action's parameter
 * list becomes the method's JSON input schema, its description and routing
 * hint become the method docs the model reads, and its declared effect
 * policy becomes both the MCP-style annotations and the invocation kind that
 * governs replay. Nothing about the action is rewritten — the same plugin
 * object runs, unchanged, inside the owner's runtime.
 *
 * A method body holds no elizaOS state. It reads the turn from the thread's
 * own log, keys the call by (actor, instance, thread, callId) so a replayed
 * code execution reuses the recorded result, and hands the work to the
 * owner's runtime through `OwnerRuntimePort`. Events the owner runtime
 * produced are appended to the thread log so the trace shows what happened.
 *
 * The package declarations are built at module scope from plugin objects
 * used for metadata only; their handlers never run here, so a declaration
 * plugin may be constructed with stores that refuse use.
 */

import type { Action } from "@elizaos/core/edge";
import { ElizaError } from "@elizaos/core/edge";
import { Effect } from "effect";
import type { MethodDoc, Package } from "tardie/code/package/definition";
import { definePackage } from "tardie/code/package/definition";
import type { Event } from "tardie/core/event";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime/context";
import type { DeclaredPlugin } from "../compatibility";
import { effectPolicyOf } from "../compatibility";
import type { ElizaEffectPolicy } from "../events";
import { ElizaOwner } from "../hosts/identity";
import { OwnerRuntimePort } from "../owner/port";
import { actionKindOf, type NativeTurnRef } from "./executor";

export const TARDIGRADE_PACKAGE_METHOD_COLLISION =
  "TARDIGRADE_PACKAGE_METHOD_COLLISION";
export const TARDIGRADE_TURN_UNKNOWN = "TARDIGRADE_TURN_UNKNOWN";

/** Services a generated package method needs from its thread. */
export type ElizaPackageServices =
  | ElizaOwner
  | OwnerRuntimePort
  | EventLog
  | Self;

const ANNOTATIONS: Record<
  ElizaEffectPolicy,
  {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  }
> = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  unsafe: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const ACTION_OUTPUT_SCHEMA = {
  type: "object",
  description:
    "The action's result. `success` is the action's own verdict; `deliveries` are the messages it sent to the user through its callback, in order; `text`/`values`/`data` are whatever the action returned.",
  properties: {
    success: { type: "boolean" },
    action: { type: "string" },
    text: { type: "string" },
    values: { type: "object" },
    data: {},
    error: { type: "string" },
    code: { type: "string" },
    deliveries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          actionName: { type: "string" },
        },
        required: ["text"],
      },
    },
    userFacingText: { type: "string" },
    verifiedUserFacing: { type: "boolean" },
  },
  required: ["success", "action", "deliveries"],
} as const;

/** `WEB_SEARCH` becomes `webSearch`: a callable identifier in generated code. */
export function methodNameOf(actionName: string): string {
  const parts = actionName
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ElizaError(`Action name ${actionName} has no usable identifier`, {
      code: TARDIGRADE_PACKAGE_METHOD_COLLISION,
      context: { action: actionName },
    });
  }
  const [head, ...rest] = parts as [string, ...string[]];
  const name =
    head.toLowerCase() +
    rest
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("");
  return /^[0-9]/u.test(name) ? `a${name}` : name;
}

/**
 * `@elizaos/plugin-web-search` becomes `webSearch`. The scope, the `plugin-`
 * prefix and an `-edge` build suffix are packaging details the model has no
 * use for; what is left is the capability's name.
 */
export function packageNameOf(pluginName: string): string {
  return methodNameOf(
    pluginName
      .replace(/^@[^/]+\//u, "")
      .replace(/^plugin-/u, "")
      .replace(/[-_]edge$/u, ""),
  );
}

function inputSchemaOf(action: Action): Record<string, unknown> {
  const parameters = action.parameters ?? [];
  if (parameters.length === 0) {
    return {
      type: "object",
      description: `${action.name} reads the current conversation; pass any extra hints as fields.`,
      properties: {},
      additionalProperties: true,
    };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    const schema = (parameter.schema ?? {}) as Record<string, unknown>;
    properties[parameter.name] = {
      ...schema,
      description: parameter.description,
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: action.allowAdditionalParameters === true,
  };
}

function describe(action: Action): MethodDoc {
  const hint =
    typeof action.routingHint === "string" && action.routingHint.length > 0
      ? `\n\nWhen to use: ${action.routingHint}`
      : "";
  return {
    description: `${action.description}${hint}`,
    input: inputSchemaOf(action),
    output: ACTION_OUTPUT_SCHEMA,
  };
}

/** The turn a package call belongs to, read from the thread's own log. */
export function currentTurnRef(
  events: ReadonlyArray<Event>,
  owner: string,
  thread: string,
): NativeTurnRef {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as unknown as Record<string, unknown>;
    if (event?.type !== "MessageReceived") continue;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const claimed = typeof input.owner === "string" ? input.owner : owner;
    const sender = typeof input.sender === "string" ? input.sender : claimed;
    const source =
      typeof input.source === "string"
        ? input.source
        : typeof event.source === "string"
          ? event.source
          : "tardigrade";
    return {
      owner: claimed,
      sender,
      source,
      roomKey: thread,
      turn: String(event.id ?? ""),
      text: typeof event.text === "string" ? event.text : "",
      at: typeof event.at === "number" ? event.at : 0,
    };
  }
  throw new ElizaError(
    "A package method ran with no message in the thread log to attribute it to",
    { code: TARDIGRADE_TURN_UNKNOWN, context: { owner, thread } },
  );
}

export interface ElizaPackageOptions {
  readonly declared: DeclaredPlugin;
  /** Overrides the package name derived from the plugin name. */
  readonly name?: string;
}

/**
 * One declared elizaOS plugin as a code-mode package. The returned package
 * is a pure declaration: every call routes to the owner's runtime.
 */
export function elizaPackage(
  options: ElizaPackageOptions,
): Package<ElizaPackageServices> {
  const { plugin, compatibility } = options.declared;
  const actions = plugin.actions ?? [];
  const name = options.name ?? packageNameOf(plugin.name);
  const docs: Record<string, MethodDoc> = {};
  const annotations: Record<string, (typeof ANNOTATIONS)[ElizaEffectPolicy]> =
    {};
  const methods: Record<
    string,
    (
      args: unknown,
      context: { readonly callId: string },
    ) => Effect.Effect<unknown, never, ElizaPackageServices>
  > = {};
  const byMethod = new Map<string, Action>();

  for (const action of actions) {
    const method = methodNameOf(action.name);
    const clash = byMethod.get(method);
    if (clash !== undefined) {
      throw new ElizaError(
        `Actions ${clash.name} and ${action.name} both map to the package method ${name}.${method}`,
        {
          code: TARDIGRADE_PACKAGE_METHOD_COLLISION,
          context: {
            package: name,
            method,
            actions: [clash.name, action.name],
          },
        },
      );
    }
    byMethod.set(method, action);
    docs[method] = describe(action);
    annotations[method] = ANNOTATIONS[effectPolicyOf(action, compatibility)];
    const kind = actionKindOf(action, compatibility);
    methods[method] = (args, context) =>
      Effect.gen(function* () {
        const owner = yield* ElizaOwner;
        const port = yield* OwnerRuntimePort;
        const self = yield* Self;
        const log = yield* EventLog;
        const events = yield* log.read;
        const turn = currentTurnRef(events, owner.owner, self.thread);
        const outcome = yield* Effect.result(
          port.invoke({
            key: JSON.stringify([
              self.actor,
              self.instance,
              self.thread,
              context.callId,
            ]),
            kind,
            name: action.name,
            thread: self.thread,
            turn: turn.turn,
            payload: {
              turn,
              action: action.name,
              parameters:
                args === null || typeof args !== "object"
                  ? {}
                  : (args as Record<string, unknown>),
            },
          }),
        );
        // A refusal is an answer the model reads, never a failed effect: an
        // uncertain outcome must be reported honestly so the turn cannot claim
        // the action succeeded, and a retry cannot repeat an unsafe effect.
        if (outcome._tag === "Failure") {
          return {
            success: false,
            action: action.name,
            code: outcome.failure.code,
            error: outcome.failure.message,
            deliveries: [],
          };
        }
        if (outcome.success.events.length > 0) {
          yield* log.append(outcome.success.events);
        }
        return outcome.success.result;
      });
  }

  return definePackage<ElizaPackageServices>({
    name,
    description: `${plugin.description ?? plugin.name}. Methods run as this owner inside their own elizaOS runtime; results carry the action's own verdict and anything it sent to the user.`,
    docs,
    annotations,
    methods,
  });
}

/** Every declared plugin with at least one action, as packages. */
export function elizaPackages(
  plugins: ReadonlyArray<DeclaredPlugin>,
): ReadonlyArray<Package<ElizaPackageServices>> {
  const packages: Package<ElizaPackageServices>[] = [];
  const seen = new Set<string>();
  for (const declared of plugins) {
    if ((declared.plugin.actions ?? []).length === 0) continue;
    const pkg = elizaPackage({ declared });
    if (seen.has(pkg.name)) {
      throw new ElizaError(
        `Two declared plugins both map to the package name ${pkg.name}`,
        {
          code: TARDIGRADE_PACKAGE_METHOD_COLLISION,
          context: { package: pkg.name },
        },
      );
    }
    seen.add(pkg.name);
    packages.push(pkg);
  }
  return packages;
}
