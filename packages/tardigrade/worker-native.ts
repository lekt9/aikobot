/**
 * Cloudflare Worker entry for the native actor. Each thread is a SQLite
 * Durable Object whose log is the execution history; each owner is a second
 * Durable Object holding that owner's elizaOS runtime and its durable
 * database. The Worker binds the two together: an authenticated owner token
 * selects the owner, the actor route is scoped to that owner's instance, and
 * the thread's layer carries both the owner and the port to its runtime.
 *
 * No process outside Cloudflare is involved: the model is called over fetch
 * from Tardigrade's own model layer, scheduled work wakes the thread through
 * the Durable Object alarm, and elizaOS state lives in the owner's object.
 */

import { Layer } from "effect";
import { modelScopeFrom, workerModelServices } from "tardie/cloudflare";
import { modelAdapters } from "tardie/model/adapter";
import { openAICompatibleAdapter } from "tardie/model/openai";
import modelLock from "./models.lock.json";
import actor from "./native-actor";
import { name as packageName, version as packageVersion } from "./package.json";
import { defineElizaWorker, type ElizaWorkerEnv } from "./src/hosts/cloudflare";
import { DEFAULT_ELIZA_TARDIGRADE_CHARACTER } from "./src/hosts/config";
import { ElizaOwner } from "./src/hosts/identity";
import { defineOwnerObject } from "./src/hosts/user-do";
import { nativeOwnerBuild } from "./src/native/owner";
import {
  type OwnerObjectNamespace,
  OwnerRuntimePort,
  ownerObjectPort,
} from "./src/owner/port";

export interface ElizaNativeWorkerEnv extends ElizaWorkerEnv {
  readonly OWNERS: OwnerObjectNamespace;
  readonly ELIZA_TARDIGRADE_AGENT_KEY?: string;
}

const character = {
  name: DEFAULT_ELIZA_TARDIGRADE_CHARACTER.name,
  bio: [DEFAULT_ELIZA_TARDIGRADE_CHARACTER.system ?? ""],
  system: DEFAULT_ELIZA_TARDIGRADE_CHARACTER.system ?? "",
};

/** One Durable Object per owner: that owner's elizaOS runtime and database. */
export const OwnerDO = defineOwnerObject<ElizaNativeWorkerEnv>({
  build: (owner, env, backend) =>
    nativeOwnerBuild({
      agentKey: env.ELIZA_TARDIGRADE_AGENT_KEY ?? "eliza-tardigrade",
      character,
    })(owner, backend),
});

const worker = defineElizaWorker({
  actor: actor as never,
  // The native actor calls the model through Tardigrade's own Infer. A
  // deployed Worker pins its catalog: the thread host ignores model
  // configuration entirely unless a lock names the snapshot it was resolved
  // against, so the adapter and the lock are both part of the deployment.
  services: workerModelServices({
    adapters: modelAdapters(openAICompatibleAdapter),
    scope: modelScopeFrom(modelLock),
  }),
  layersFor: (context) => {
    const env = context.env as unknown as ElizaNativeWorkerEnv;
    return Layer.mergeAll(
      Layer.succeed(ElizaOwner, { owner: context.owner, scoped: true }),
      Layer.succeed(
        OwnerRuntimePort,
        ownerObjectPort(env.OWNERS, context.owner),
      ),
    ) as never;
  },
});

export const { ActorDO, ThreadDO } = worker;

const identity = (env: ElizaNativeWorkerEnv): Response =>
  Response.json({
    product: packageName,
    version: packageVersion,
    actor: actor.name,
    composition: "native",
    methods: Object.keys(actor.methods),
    identity: worker.modes(env),
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
      return identity(env as unknown as ElizaNativeWorkerEnv);
    }
    return worker.fetch(request, env, context);
  },
};
