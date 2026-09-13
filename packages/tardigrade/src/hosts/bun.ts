/**
 * Bun host for the Eliza actor: SQLite-backed Tardigrade threads with the
 * turn configuration supplied as an Effect layer per thread. Used by the
 * package's `server.ts` and by the recovery and idempotency tests, which
 * reopen the same storage directory to prove resumption.
 */

import { Layer } from "effect";
import { createBunHost, type Host } from "tardie/bun";
import { type ElizaActor, ElizaTurnServices } from "../actor";
import type { ElizaTurnConfig } from "../turn";

export interface ElizaBunHostOptions {
  readonly actor: ElizaActor;
  readonly storage: string;
  readonly config: ElizaTurnConfig;
  readonly maxConcurrentThreads?: number;
}

export type ElizaBunHost = Host<ElizaActor["methods"]>;

export async function createElizaBunHost(
  options: ElizaBunHostOptions,
): Promise<ElizaBunHost> {
  return createBunHost({
    actor: options.actor,
    storage: options.storage,
    ...(options.maxConcurrentThreads === undefined
      ? {}
      : { driver: { maxConcurrentThreads: options.maxConcurrentThreads } }),
    layersFor: () =>
      Layer.succeed(ElizaTurnServices, { config: options.config }),
  });
}
