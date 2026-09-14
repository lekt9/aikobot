/**
 * Todo store persisted in the thread's Tardigrade workspace key-value store,
 * which both hosts provide as a port: SQLite beside the Bun thread database
 * and the Durable Object's storage under Cloudflare. The document holds the
 * complete todo list and mutation ledger for the thread; `documentTodoStore`
 * owns the load/mutate/write cycle, so this module only says where the
 * document lives.
 */

import type { TodoStore } from "@elizaos/plugin-todos/edge";
import { Effect } from "effect";
import type { KeyValueStore } from "effect/unstable/persistence";
import type { TardigradePluginCompatibility } from "../compatibility";
import { documentTodoStore } from "./document-todos";

export const KV_TODOS_COMPATIBILITY: TardigradePluginCompatibility = {
  target: "edge",
  state: "thread-workspace-kv",
  effects: ["thread-kv-read", "thread-kv-write"],
  requiredBindings: [],
  requiredSecrets: [],
};

export const KV_TODOS_KEY = "eliza/todos/v1";

/** A `TodoStore` whose whole state lives at one key of the thread workspace. */
export function kvTodoStore(
  kv: KeyValueStore.KeyValueStore,
  key = KV_TODOS_KEY,
): TodoStore {
  return documentTodoStore({
    load: () => Effect.runPromise(kv.get(key)),
    save: (document) => Effect.runPromise(kv.set(key, document)),
  });
}
