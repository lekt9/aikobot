/**
 * In-memory todo store implementing the plugin's idempotent mutation contract:
 * a mutation record is keyed by scope and idempotency key, so a retried
 * request replays the recorded result instead of applying twice. The KV store
 * persists this same state per thread; tests use it directly.
 */

import type {
  CreateTodoInput,
  Todo,
  TodoMutationExecution,
  TodoMutationRecord,
  TodoStore,
} from "@elizaos/plugin-todos/edge";

export interface MemoryTodoStore extends TodoStore {
  readonly todos: Todo[];
  readonly mutations: TodoMutationRecord[];
  readonly applied: string[];
}

function todoOf(input: CreateTodoInput, id: string, now: Date): Todo {
  return {
    id,
    agentId: input.agentId,
    entityId: input.entityId,
    roomId: input.roomId ?? null,
    worldId: input.worldId ?? null,
    content: input.content,
    activeForm: input.activeForm ?? input.content,
    status: input.status ?? "pending",
    parentTodoId: input.parentTodoId ?? null,
    parentTrajectoryStepId: input.parentTrajectoryStepId ?? null,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === "completed" ? now : null,
  } as Todo;
}

/** In-memory todo store with the idempotent mutation contract of the real stores. */
export function memoryTodoStore(
  seed: { todos?: Todo[]; mutations?: TodoMutationRecord[] } = {},
): MemoryTodoStore {
  const todos: Todo[] = [...(seed.todos ?? [])];
  const mutations: TodoMutationRecord[] = [...(seed.mutations ?? [])];
  const applied: string[] = [];
  const scoped = (scope: { agentId: string; entityId: string }) =>
    todos.filter(
      (todo) =>
        todo.agentId === scope.agentId && todo.entityId === scope.entityId,
    );
  const store: MemoryTodoStore = {
    todos,
    mutations,
    applied,
    async applyMutation(input): Promise<TodoMutationExecution> {
      const existing = mutations.find(
        (record) =>
          record.scope.agentId === input.scope.agentId &&
          record.scope.entityId === input.scope.entityId &&
          record.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return {
          mutationId: existing.mutationId,
          idempotencyKey: existing.idempotencyKey,
          replayed: true,
          committedAt: existing.committedAt,
          applied: existing.applied,
          result: existing.result,
        };
      }
      applied.push(input.idempotencyKey);
      const now = new Date();
      let result: TodoMutationRecord["result"];
      const mutation = input.mutation;
      switch (mutation.action) {
        case "create": {
          const todo = todoOf(
            {
              ...mutation.input,
              agentId: input.scope.agentId,
              entityId: input.scope.entityId,
            },
            `todo-${todos.length + 1}`,
            now,
          );
          todos.push(todo);
          result = { action: "create", todo };
          break;
        }
        case "update": {
          const todo =
            scoped(input.scope).find(
              (candidate) => candidate.id === mutation.id,
            ) ?? null;
          if (todo) Object.assign(todo, mutation.patch, { updatedAt: now });
          result = { action: "update", todo };
          break;
        }
        case "complete":
        case "cancel": {
          const todo =
            scoped(input.scope).find(
              (candidate) => candidate.id === mutation.id,
            ) ?? null;
          if (todo) {
            todo.status =
              mutation.action === "complete" ? "completed" : "cancelled";
            todo.completedAt =
              mutation.action === "complete" ? now : todo.completedAt;
            todo.updatedAt = now;
          }
          result = { action: mutation.action, todo };
          break;
        }
        case "delete": {
          const index = todos.findIndex(
            (todo) =>
              todo.id === mutation.id &&
              todo.agentId === input.scope.agentId &&
              todo.entityId === input.scope.entityId,
          );
          const deleted = index >= 0 ? todos.splice(index, 1)[0] : null;
          result = { action: "delete", deleted };
          break;
        }
        case "clear": {
          const before = scoped(input.scope);
          for (const todo of before) todos.splice(todos.indexOf(todo), 1);
          result = { action: "clear", count: before.length };
          break;
        }
        case "write": {
          const before = scoped(input.scope);
          for (const todo of before) todos.splice(todos.indexOf(todo), 1);
          const after = mutation.input.todos.map((entry, index) =>
            todoOf(
              {
                agentId: input.scope.agentId,
                entityId: input.scope.entityId,
                roomId: mutation.input.roomId,
                worldId: mutation.input.worldId,
                content: entry.content,
                status: entry.status,
                activeForm: entry.activeForm,
                parentTodoId: entry.parentTodoId,
                parentTrajectoryStepId: mutation.input.parentTrajectoryStepId,
              },
              entry.id ?? `todo-${todos.length + index + 1}`,
              now,
            ),
          );
          todos.push(...after);
          result = { action: "write", before, after };
          break;
        }
      }
      const record: TodoMutationRecord = {
        mutationId: `mutation-${mutations.length + 1}`,
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
        requestDigest: JSON.stringify(mutation),
        operation: mutation.action,
        applied: true,
        result,
        committedAt: now,
      };
      mutations.push(record);
      return {
        mutationId: record.mutationId,
        idempotencyKey: record.idempotencyKey,
        replayed: false,
        committedAt: now,
        applied: true,
        result,
      };
    },
    async readCutoverState(scope) {
      return {
        todos: scoped(scope),
        mutations: mutations.filter((m) => m.scope.entityId === scope.entityId),
      };
    },
    async listMutationRecords(scope) {
      return mutations.filter((m) => m.scope.entityId === scope.entityId);
    },
    async importMutationRecords() {
      return { imported: 0, skipped: 0 };
    },
    async create(input) {
      const todo = todoOf(input, `todo-${todos.length + 1}`, new Date());
      todos.push(todo);
      return todo;
    },
    async get(scope, id) {
      return scoped(scope).find((todo) => todo.id === id) ?? null;
    },
    async list(filter) {
      return todos.filter(
        (todo) =>
          todo.agentId === filter.agentId &&
          todo.entityId === filter.entityId &&
          (filter.includeCompleted !== false ||
            todo.status === "pending" ||
            todo.status === "in_progress"),
      );
    },
    async update(scope, id, patch) {
      const todo =
        scoped(scope).find((candidate) => candidate.id === id) ?? null;
      if (todo) Object.assign(todo, patch, { updatedAt: new Date() });
      return todo;
    },
    async delete(scope, id) {
      const index = todos.findIndex(
        (todo) => todo.id === id && todo.entityId === scope.entityId,
      );
      if (index < 0) return false;
      todos.splice(index, 1);
      return true;
    },
    async writeList(input) {
      const before = scoped(input);
      for (const todo of before) todos.splice(todos.indexOf(todo), 1);
      const after = input.todos.map((entry, index) =>
        todoOf(
          {
            agentId: input.agentId,
            entityId: input.entityId,
            roomId: input.roomId,
            worldId: input.worldId,
            content: entry.content,
            status: entry.status,
            activeForm: entry.activeForm,
            parentTodoId: entry.parentTodoId,
            parentTrajectoryStepId: input.parentTrajectoryStepId,
          },
          entry.id ?? `todo-${todos.length + index + 1}`,
          new Date(),
        ),
      );
      todos.push(...after);
      return { before, after };
    },
    async clear(filter) {
      const before = scoped(filter);
      for (const todo of before) todos.splice(todos.indexOf(todo), 1);
      return before.length;
    },
  };
  return store;
}
