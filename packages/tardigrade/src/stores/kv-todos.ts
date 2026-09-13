/**
 * Todo store persisted in the thread's Tardigrade workspace key-value store,
 * which both hosts provide as a port: SQLite beside the Bun thread database
 * and the Durable Object's storage under Cloudflare. The document holds the
 * complete todo list and mutation ledger for the thread, loaded and written
 * whole under an in-process lock, so the todos plugin keeps its idempotent
 * mutation contract across process restarts without a second database.
 */

import type { TodoStore } from "@elizaos/plugin-todos/edge";
import { Effect } from "effect";
import type { KeyValueStore } from "effect/unstable/persistence";
import type { TardigradePluginCompatibility } from "../compatibility";
import { type MemoryTodoStore, memoryTodoStore } from "./memory-todos";

export const KV_TODOS_COMPATIBILITY: TardigradePluginCompatibility = {
  target: "edge",
  state: "thread-workspace-kv",
  effects: ["thread-kv-read", "thread-kv-write"],
  requiredBindings: [],
  requiredSecrets: [],
};

export const KV_TODOS_KEY = "eliza/todos/v1";

type Seed = Parameters<typeof memoryTodoStore>[0];

function reviveSeed(raw: string): Seed {
  const parsed = JSON.parse(raw) as {
    todos: Array<Record<string, unknown>>;
    mutations: Array<Record<string, unknown>>;
  };
  return {
    todos: parsed.todos.map((todo) => ({
      ...todo,
      createdAt: new Date(String(todo.createdAt)),
      updatedAt: new Date(String(todo.updatedAt)),
      completedAt: todo.completedAt ? new Date(String(todo.completedAt)) : null,
    })) as NonNullable<Seed>["todos"],
    mutations: parsed.mutations.map((record) => ({
      ...record,
      committedAt: new Date(String(record.committedAt)),
    })) as NonNullable<Seed>["mutations"],
  };
}

/** A `TodoStore` whose whole state lives at one key of the thread workspace. */
export function kvTodoStore(
  kv: KeyValueStore.KeyValueStore,
  key = KV_TODOS_KEY,
): TodoStore {
  let lock: Promise<unknown> = Promise.resolve();
  const withStore = <T>(
    operate: (store: MemoryTodoStore) => Promise<T>,
  ): Promise<T> => {
    const run = lock.then(async () => {
      const raw = await Effect.runPromise(kv.get(key));
      const store = memoryTodoStore(raw === undefined ? {} : reviveSeed(raw));
      const result = await operate(store);
      await Effect.runPromise(
        kv.set(
          key,
          JSON.stringify({ todos: store.todos, mutations: store.mutations }),
        ),
      );
      return result;
    });
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    applyMutation: (input) => withStore((store) => store.applyMutation(input)),
    readCutoverState: (scope) =>
      withStore((store) => store.readCutoverState(scope)),
    listMutationRecords: (scope) =>
      withStore((store) => store.listMutationRecords(scope)),
    importMutationRecords: (input) =>
      withStore((store) => store.importMutationRecords(input)),
    create: (input) => withStore((store) => store.create(input)),
    get: (scope, id) => withStore((store) => store.get(scope, id)),
    list: (filter) => withStore((store) => store.list(filter)),
    update: (scope, id, patch) =>
      withStore((store) => store.update(scope, id, patch)),
    delete: (scope, id) => withStore((store) => store.delete(scope, id)),
    writeList: (input) => withStore((store) => store.writeList(input)),
    clear: (filter) => withStore((store) => store.clear(filter)),
  };
}
