/**
 * The shared body of every persisted todo store: the plugin's whole todo
 * list and mutation ledger live in one JSON document, loaded and written
 * under an in-process lock so the plugin's idempotent mutation contract
 * survives restarts without a second database. Hosts differ only in where
 * that document lives — a thread's workspace key-value store, or an owner's
 * durable state backend.
 */

import type { TodoStore } from "@elizaos/plugin-todos/edge";
import { type MemoryTodoStore, memoryTodoStore } from "./memory-todos";

type Seed = Parameters<typeof memoryTodoStore>[0];

/** Restores the stored document, including the Date fields the plugin uses. */
export function reviveTodoSeed(raw: string): Seed {
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

export interface TodoDocument {
  load(): Promise<string | undefined>;
  save(document: string): Promise<void>;
}

/** A `TodoStore` whose whole state is one JSON document. */
export function documentTodoStore(document: TodoDocument): TodoStore {
  let lock: Promise<unknown> = Promise.resolve();
  const withStore = <T>(
    operate: (store: MemoryTodoStore) => Promise<T>,
  ): Promise<T> => {
    const run = lock.then(async () => {
      const raw = await document.load();
      const store = memoryTodoStore(
        raw === undefined ? {} : reviveTodoSeed(raw),
      );
      const result = await operate(store);
      await document.save(
        JSON.stringify({ todos: store.todos, mutations: store.mutations }),
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
