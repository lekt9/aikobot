/**
 * Cloudflare Worker entry: mounts the Eliza actor on Durable Objects and
 * serves Tardigrade's actor, thread, method, and event routes. `GET /` is a
 * public identity document for operators and release probes; every other
 * route is Tardigrade's, protected by `TARDIGRADE_TOKEN`. Turn services come
 * from the Worker bindings; `OPENAI_API_KEY` and `TARDIGRADE_TOKEN` are
 * secrets.
 */

import actor from "./actor";
import { name as packageName, version as packageVersion } from "./package.json";
import { defineElizaWorkerHost, type ElizaWorkerEnv } from "./src/cloudflare";
import { elizaTurnServicesLayer } from "./src/hosts/config";

const { host, fetch: tardigradeFetch } = defineElizaWorkerHost(
  actor,
  (context) =>
    elizaTurnServicesLayer({
      env: context.env as unknown as Record<string, string | undefined>,
    }),
);

export const { ActorDO, ThreadDO } = host;

const identity = (env: ElizaWorkerEnv): Response =>
  Response.json({
    product: packageName,
    version: packageVersion,
    actor: actor.name,
    methods: Object.keys(actor.methods),
    model: env.ELIZA_TARDIGRADE_MODEL ?? null,
    provider: env.ELIZA_TARDIGRADE_MODEL_PROVIDER ?? null,
    routes: { health: "/healthz", api: "/v1" },
  });

type WorkerFetch = typeof tardigradeFetch;

export default {
  fetch: (
    ...[request, env, context]: Parameters<WorkerFetch>
  ): ReturnType<WorkerFetch> | Response => {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/identity")
    ) {
      return identity(env);
    }
    return tardigradeFetch(request, env, context);
  },
};
