/**
 * Cloudflare Worker entry: mounts the Eliza actor on Durable Objects and
 * serves Tardigrade's actor, thread, method, and event routes for many
 * owners. `GET /` is a public identity document for operators and release
 * probes; every other route needs an Aiko owner token
 * (`ELIZA_OWNER_TOKEN_SECRET`) or the operator bearer (`TARDIGRADE_TOKEN`).
 * Turn services come from the Worker bindings; the model credential and
 * both bearers are secrets.
 */

import actor from "./actor";
import { name as packageName, version as packageVersion } from "./package.json";
import { defineElizaWorker, type ElizaWorkerEnv } from "./src/cloudflare";
import { elizaTurnServicesLayer } from "./src/hosts/config";

const worker = defineElizaWorker({
  actor,
  layersFor: (context) =>
    elizaTurnServicesLayer({
      env: context.env as unknown as Record<string, string | undefined>,
    }),
});

export const { ActorDO, ThreadDO } = worker;

const identity = (env: ElizaWorkerEnv): Response =>
  Response.json({
    product: packageName,
    version: packageVersion,
    actor: actor.name,
    composition: "pipeline",
    methods: Object.keys(actor.methods),
    identity: worker.modes(env),
    model: env.ELIZA_TARDIGRADE_MODEL ?? null,
    provider: env.ELIZA_TARDIGRADE_MODEL_PROVIDER ?? null,
    routes: { health: "/healthz", api: "/v1" },
  });

type WorkerFetch = typeof worker.fetch;

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
    return worker.fetch(request, env, context);
  },
};
