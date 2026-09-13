/**
 * Serverless scheduling on Tardigrade. Core's `TaskService` keeps the clock
 * and the scheduled-item semantics; the adapter supplies a log-projected task
 * table, journals every task mutation and worker execution, and exposes one
 * host wakeup method that calls `runDueTasks()`. No second scheduler exists.
 *
 * Task rows replay into each ephemeral runtime from `ElizaTaskUpserted` and
 * `ElizaTaskDeleted`, so a task an action created in one turn is due at the
 * next wakeup on whichever host holds the thread. A worker execution is a
 * journaled `task` boundary whose retry policy the worker declares through
 * `tardigradeEffectPolicy`; an undeclared worker is unsafe and fails closed
 * after a crash.
 */

import type { IAgentRuntime, Task, TaskWorker } from "@elizaos/core/edge";
import { Schema } from "effect";
import { actorMethod } from "tardie/core/actor";
import type { Event } from "tardie/core/event";
import {
  type ElizaEffectPolicy,
  elizaTaskDeleted,
  elizaTaskUpserted,
  elizaTickRequested,
} from "./events";
import type { BoundaryRecorder } from "./journal";

export interface TaskJournalState {
  readonly tasks: ReadonlyMap<string, Task>;
}

export const initialTaskJournal = (): TaskJournalState => ({
  tasks: new Map(),
});

/** Pure step: folds task upserts and deletes into the projected task table. */
export const reduceTaskJournal = (
  state: TaskJournalState,
  event: Event,
): TaskJournalState => {
  const record = event as Record<string, unknown>;
  if (event.type === "ElizaTaskUpserted") {
    const tasks = new Map(state.tasks);
    tasks.set(String(record.taskId), record.task as Task);
    return { tasks };
  }
  if (event.type === "ElizaTaskDeleted") {
    const taskId = String(record.taskId);
    if (!state.tasks.has(taskId)) return state;
    const tasks = new Map(state.tasks);
    tasks.delete(taskId);
    return { tasks };
  }
  return state;
};

export const tasksOf = (state: TaskJournalState): Task[] => [
  ...state.tasks.values(),
];

export interface TardigradeTaskWorker extends TaskWorker {
  /** Retry policy for the worker's journaled execution; undeclared is unsafe. */
  readonly tardigradeEffectPolicy?: ElizaEffectPolicy;
}

export const taskWorkerPolicy = (worker: TaskWorker): ElizaEffectPolicy =>
  (worker as TardigradeTaskWorker).tardigradeEffectPolicy ?? "unsafe";

const serializableTask = (task: Task): Task =>
  JSON.parse(JSON.stringify(task)) as Task;

export interface TaskJournalOptions {
  readonly recorder: BoundaryRecorder;
  readonly append: (events: ReadonlyArray<Event>) => Promise<void>;
  readonly turn: string;
  readonly now: () => number;
}

export interface TaskJournalAttachment {
  /** Task worker boundaries this runtime reached, live or replayed. */
  readonly executed: () => number;
  /**
   * Seeds the durable task rows and opens the journal. Tasks and workers the
   * runtime created before this point are its own housekeeping (drains that
   * every runtime recreates) and stay out of the durable table.
   */
  readonly activate: (tasks: ReadonlyArray<Task>) => Promise<void>;
}

/**
 * Journals the runtime's task mutations and worker executions for tasks the
 * actor owns. Must be attached before `initialize()` so every registration
 * passes through it; journaling starts at `activate()`.
 */
export function attachTaskJournal(
  runtime: IAgentRuntime,
  options: TaskJournalOptions,
): TaskJournalAttachment {
  const createTask = runtime.createTask.bind(runtime);
  const updateTask = runtime.updateTask.bind(runtime);
  const deleteTask = runtime.deleteTask.bind(runtime);
  const registerTaskWorker = runtime.registerTaskWorker.bind(runtime);
  const owned = new Set<string>();
  let active = false;
  const upsert = async (taskId: string, task: Task) => {
    await options.append([
      elizaTaskUpserted({
        taskId,
        task: serializableTask(task),
        turn: options.turn,
        at: options.now(),
      }),
    ]);
  };
  runtime.createTask = async (task) => {
    // Core filters getTasks by agent; an owned row must carry the agent id
    // so the wakeup's serverless tick can see it.
    const scoped: Task = task.agentId
      ? task
      : { ...task, agentId: runtime.agentId };
    const id = await createTask(scoped);
    if (!active) return id;
    owned.add(String(id));
    const stored = (await runtime.getTask(id)) ?? { ...scoped, id };
    await upsert(String(id), stored);
    return id;
  };
  runtime.updateTask = async (id, patch) => {
    await updateTask(id, patch);
    if (!owned.has(String(id))) return;
    const stored = await runtime.getTask(id);
    if (stored) await upsert(String(id), stored);
  };
  runtime.deleteTask = async (id) => {
    await deleteTask(id);
    if (!owned.delete(String(id))) return;
    await options.append([
      elizaTaskDeleted({
        taskId: String(id),
        turn: options.turn,
        at: options.now(),
      }),
    ]);
  };
  runtime.registerTaskWorker = (worker) =>
    registerTaskWorker({
      ...worker,
      execute: (rt, workerOptions, task) =>
        owned.has(String(task.id ?? ""))
          ? options.recorder.record({
              kind: "task",
              name: worker.name,
              policy: taskWorkerPolicy(worker),
              input: {
                name: worker.name,
                taskId: task.id ?? null,
                options: workerOptions,
              },
              execute: (context) =>
                worker.execute(
                  rt,
                  {
                    ...workerOptions,
                    tardigradeOperationId: context.operationId,
                    tardigradeAttempt: context.attempt,
                  },
                  task,
                ),
            })
          : worker.execute(rt, workerOptions, task),
    });
  return {
    executed: () => options.recorder.ordinals().task,
    activate: async (tasks) => {
      if (tasks.length > 0) {
        await runtime.adapter.createTasks(tasks.map(serializableTask));
        for (const task of tasks) if (task.id) owned.add(String(task.id));
      }
      active = true;
    },
  };
}

export const ElizaTickInput = Schema.Struct({ owner: Schema.String }).annotate({
  identifier: "ElizaTickInput",
});
export type ElizaTickInput = typeof ElizaTickInput.Type;

export const ElizaTickOutput = Schema.Struct({
  executed: Schema.Finite,
}).annotate({
  identifier: "ElizaTickOutput",
});
export type ElizaTickOutput = typeof ElizaTickOutput.Type;

type TickTerminal =
  | { readonly status: "completed"; readonly executed: number }
  | { readonly status: "failed"; readonly error: string };

interface TickProjectionState {
  readonly ticks: ReadonlyMap<string, { readonly terminal?: TickTerminal }>;
}

const reduceTicks = (
  state: TickProjectionState,
  event: Event,
): TickProjectionState => {
  const record = event as Record<string, unknown>;
  if (event.type === "ElizaTickRequested") {
    const id = String(record.id);
    if (state.ticks.has(id)) return state;
    const ticks = new Map(state.ticks);
    ticks.set(id, {});
    return { ticks };
  }
  if (event.type === "ElizaTickCompleted" || event.type === "ElizaTickFailed") {
    const id = String(record.tick);
    const existing = state.ticks.get(id);
    if (!existing || existing.terminal !== undefined) return state;
    const ticks = new Map(state.ticks);
    ticks.set(id, {
      terminal:
        event.type === "ElizaTickCompleted"
          ? { status: "completed", executed: Number(record.executed) }
          : { status: "failed", error: String(record.error ?? "tick failed") },
    });
    return { ticks };
  }
  return state;
};

/** Host wakeup: run every due scheduled task for the thread's owner once. */
export const runDueTasksMethod = actorMethod({
  input: ElizaTickInput,
  output: ElizaTickOutput,
  event: ({ invocation, input, at }) =>
    elizaTickRequested({
      id: invocation.id,
      owner: input.owner,
      ...(invocation.epoch === 0 ? {} : { epoch: invocation.epoch }),
      at,
    }),
  projection: {
    initial: (): TickProjectionState => ({ ticks: new Map() }),
    step: reduceTicks,
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const tick = state.ticks.get(invocation.id);
        if (tick === undefined) return undefined;
        if (tick.terminal === undefined) return { status: "pending" as const };
        return tick.terminal.status === "completed"
          ? {
              status: "completed" as const,
              output: { executed: tick.terminal.executed },
            }
          : { status: "failed" as const, error: tick.terminal.error };
      },
    }),
  },
});
