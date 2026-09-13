/**
 * Cloudflare Workers host for the Eliza actor: each thread is a SQLite-backed
 * Durable Object whose event log is the durable execution history, and the
 * Worker resumes unfinished turns through alarms. The turn configuration is
 * built per thread from the Worker bindings through the shared layer.
 */

import type { Layer } from "effect";
import type { KeyValueStore } from "effect/unstable/persistence";
import {
  type CloudflareWorkerLayerContext,
  defineWorkerHost,
  type Env,
  type WorkerHost,
  workerHttp,
} from "tardie/cloudflare";
import type { HostPorts } from "tardie/host/ports";
import type { ElizaActor, ElizaTurnServices } from "../actor";

export interface ElizaWorkerEnv extends Env {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly ELIZA_TARDIGRADE_MODEL?: string;
  readonly ELIZA_TARDIGRADE_MODEL_PROVIDER?: string;
  readonly ELIZA_TARDIGRADE_AGENT_KEY?: string;
}

export type ElizaWorkerLayer = Layer.Layer<
  ElizaTurnServices,
  never,
  HostPorts | KeyValueStore.KeyValueStore
>;

export interface ElizaWorkerHost {
  readonly host: WorkerHost<ElizaWorkerEnv>;
  readonly fetch: NonNullable<ExportedHandler<ElizaWorkerEnv>["fetch"]>;
}

/** Mounts the actor once per Worker module with per-thread turn services. */
export function defineElizaWorkerHost(
  actor: ElizaActor,
  layersFor: (
    context: CloudflareWorkerLayerContext<ElizaWorkerEnv>,
  ) => ElizaWorkerLayer,
): ElizaWorkerHost {
  const host = defineWorkerHost<
    Parameters<
      (typeof actor.components)[number]["machine"]["output"]
    >[0] extends never
      ? never
      : ElizaTurnServices | HostPorts,
    ElizaActor["methods"],
    ElizaWorkerEnv
  >(actor as never, { layersFor: layersFor as never } as never);
  return { host, fetch: workerHttp(host).fetch };
}
