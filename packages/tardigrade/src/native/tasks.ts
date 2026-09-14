/**
 * Scheduling with no scheduler. Tardigrade has no cron, sleep or timer: the
 * only durable timing primitive is an unresolved method deadline, because a
 * resting thread arms its host alarm at the earliest deadline in its log and
 * the host wakes the thread at that instant. So a reminder is armed by
 * calling a `wake` method on the actor's own thread whose deadline is the due
 * time and which is expected to time out there. When it does, the caller-side
 * `CallTimedOut` lands in the same log, this component owes a tick, the
 * owner's core `TaskService.runDueTasks()` runs, and the next wake is armed
 * from what the tick reports. Nothing outside the deployment is involved.
 *
 * The cycle is bootstrapped by a turn: every completed turn owes one tick, so
 * a reminder created during a conversation is scheduled by the tick that
 * follows it.
 *
 * Two constraints from the runtime shape this module. The wake is armed as a
 * root call rather than from inside a method, because a child call's deadline
 * is clamped to its parent's. And the tick effect is declared unbound, so the
 * deadline cancellation that woke the thread cannot suppress the work it woke
 * the thread for.
 */

import { ElizaError } from "@elizaos/core/edge";
import { Effect, Schema } from "effect";
import type { AgentComponent, AgentView } from "tardie/agent";
import { actorMethod } from "tardie/core/actor";
import { legacyComponent } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import type { Event } from "tardie/core/event";
import { actorCall } from "tardie/core/interaction/invoke";
import type { EventLog, KeyFragment } from "tardie/core/log";
import type { Transition } from "tardie/core/transition";
import { parseThreadAddress } from "tardie/core/transport/endpoint";
import { ElizaOwner } from "../hosts/identity";
import { OwnerRuntimePort } from "../owner/port";

export const ELIZA_WAKE_PREFIX = "eliza/wake:";
export const ELIZA_TICK_PREFIX = "eliza/tick:";
export const ELIZA_TICK_TAG = "eliza-tick";

/**
 * The longest wait one armed wake can express. A per-call timeout above a
 * method's declared timeout is refused, so the declaration is the ceiling;
 * a due time further out is armed in stages, one wake at a time.
 */
export const MAX_WAKE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The closest two wakes may be. It is a deployment policy, not a detail: core
 * registers internal queue rows that fall due every tenth of a second, so
 * without a floor a resting actor would wake ten times a second forever. A
 * due time sooner than the floor is served at the floor, which makes the
 * floor the worst-case lateness of a reminder.
 */
export const MIN_WAKE_MS = 5_000;

/**
 * How long to wait when a queued task claims to be due but the tick ran
 * nothing. That is a stuck row — no registered worker, or validation refuses
 * it — and waking every second for it would burn the deployment's clock.
 */
export const IDLE_WAKE_MS = 60_000;

export const ElizaWakeInput = Schema.Struct({
  dueAt: Schema.Number,
  reason: Schema.String,
}).annotate({ identifier: "ElizaWakeInput" });

export type ElizaWakeInput = typeof ElizaWakeInput.Type;

export const ElizaWakeOutput = Schema.Struct({
  woken: Schema.Boolean,
}).annotate({ identifier: "ElizaWakeOutput" });

export interface ElizaWakeArmedFields {
  readonly wake: string;
  readonly dueAt: number;
  readonly reason: string;
  readonly at: number;
}

export interface ElizaTickCompletedFields {
  readonly wake: string;
  readonly executed: number;
  /** The earliest due time still ahead, or null when none is. */
  readonly nextDueAt: number | null;
  /** Queued tasks whose due time has already passed. */
  readonly dueNow: number;
  readonly at: number;
}

export interface ElizaTickFailedFields {
  readonly wake: string;
  readonly code: string;
  readonly error: string;
  readonly at: number;
}

export const elizaWakeArmed = (fields: ElizaWakeArmedFields): Event =>
  ({ type: "ElizaWakeArmed", ...fields }) as unknown as Event;

export const elizaTickCompleted = (fields: ElizaTickCompletedFields): Event =>
  ({ type: "ElizaTickCompleted", ...fields }) as unknown as Event;

export const elizaTickFailed = (fields: ElizaTickFailedFields): Event =>
  ({ type: "ElizaTickFailed", ...fields }) as unknown as Event;

/** One tick per wake, however often its event is delivered. */
export const elizaTickKeys: KeyFragment = {
  prefixes: [ELIZA_TICK_PREFIX],
  keyOf: (event) => {
    const record = event as unknown as Record<string, unknown>;
    const wake = String(record.wake ?? "");
    if (wake === "") return undefined;
    return record.type === "ElizaTickCompleted" ||
      record.type === "ElizaTickFailed"
      ? `${ELIZA_TICK_PREFIX}${wake}`
      : undefined;
  },
};

interface WakeProjection {
  readonly armed: ReadonlySet<string>;
}

/**
 * The method a thread calls on itself to be woken later. It is never
 * answered: the host cancels it at its deadline, which is the wake. Its
 * declared timeout is the ceiling for a single wait.
 */
export const elizaWakeMethod = actorMethod({
  input: ElizaWakeInput,
  output: ElizaWakeOutput,
  timeoutMs: MAX_WAKE_MS,
  event: ({ invocation, input, at }) =>
    elizaWakeArmed({
      wake: invocation.id,
      dueAt: input.dueAt,
      reason: input.reason,
      at,
    }),
  projection: {
    initial: (): WakeProjection => ({ armed: new Set() }),
    step: (state, event): WakeProjection => {
      const record = event as unknown as Record<string, unknown>;
      if (record.type !== "ElizaWakeArmed") return state;
      return { armed: new Set([...state.armed, String(record.wake ?? "")]) };
    },
    output: (state) => ({
      currentEpoch: () => 0,
      // An armed wake stays pending until its deadline retires it; that
      // pending deadline is exactly what keeps the host's alarm armed.
      invocationState: (invocation: { readonly id: string }) =>
        state.armed.has(invocation.id)
          ? ({ status: "pending" } as const)
          : undefined,
    }),
  },
});

export const ELIZA_WAKE_METHODS = { wake: elizaWakeMethod } as const;

const record = (event: Event): Record<string, unknown> =>
  event as unknown as Record<string, unknown>;

/**
 * The thread's own coordinate, from the `ThreadCreated` event that opened it.
 * Hosts record the address either as a coordinate object or as the
 * `actor:instance:thread` string, so both spellings are read.
 */
export function selfAddressOf(log: ReadonlyArray<Event>):
  | {
      readonly actor: string;
      readonly instance: string;
      readonly thread: string;
    }
  | undefined {
  for (const event of log) {
    if (event.type !== "ThreadCreated") continue;
    const address = record(event).address;
    if (typeof address === "string") {
      const coordinate = parseThreadAddress(address);
      return {
        actor: coordinate.actor,
        instance: coordinate.instance,
        thread: coordinate.thread,
      };
    }
    if (address !== null && typeof address === "object") {
      const coordinate = address as Record<string, unknown>;
      if (
        typeof coordinate.actor === "string" &&
        typeof coordinate.instance === "string" &&
        typeof coordinate.thread === "string"
      ) {
        return {
          actor: coordinate.actor,
          instance: coordinate.instance,
          thread: coordinate.thread,
        };
      }
    }
  }
  return undefined;
}

interface ScheduleState {
  /** Wake id to its due time, for wakes that have been armed. */
  readonly armed: Map<string, number>;
  /** Wake ids whose deadline has landed and whose tick is not yet recorded. */
  readonly due: Set<string>;
  /** Wake ids whose tick has been recorded. */
  readonly ticked: Set<string>;
  /** The next due time the last tick reported, if any. */
  nextDueAt: number | null;
  /** What the last tick ran, and what it left already due. */
  executed: number;
  dueNow: number;
  /** Ticks recorded so far; it makes each armed wake a distinct call. */
  ticks: number;
  /** When the last tick landed. Wake targets are measured from it, never
   * from the log's moving tail, or each armed wake would move the target and
   * arm another. */
  lastTickAt: number;
  /** The latest timestamp in the log, used instead of the wall clock. */
  latestAt: number;
}

function scheduleOf(log: ReadonlyArray<Event>): ScheduleState {
  const state: ScheduleState = {
    armed: new Map(),
    due: new Set(),
    ticked: new Set(),
    nextDueAt: null,
    executed: 0,
    dueNow: 0,
    ticks: 0,
    lastTickAt: 0,
    latestAt: 0,
  };
  const completedTurns = new Set<string>();
  for (const event of log) {
    const value = record(event);
    if (typeof value.at === "number" && value.at > state.latestAt) {
      state.latestAt = value.at;
    }
    switch (event.type) {
      case "ElizaWakeArmed":
        state.armed.set(String(value.wake ?? ""), Number(value.dueAt ?? 0));
        break;
      case "CallTimedOut":
      case "CallSkipped": {
        const id = String(value.call ?? value.id ?? "");
        if (id.startsWith("wake-")) state.due.add(id);
        break;
      }
      case "TurnCompleted":
        completedTurns.add(String(value.turn ?? ""));
        break;
      case "ElizaTickCompleted":
        state.ticked.add(String(value.wake ?? ""));
        state.ticks += 1;
        state.nextDueAt =
          typeof value.nextDueAt === "number" ? value.nextDueAt : null;
        state.executed = Number(value.executed ?? 0);
        state.dueNow = Number(value.dueNow ?? 0);
        state.lastTickAt = Number(value.at ?? state.lastTickAt);
        break;
      case "ElizaTickFailed":
        state.ticked.add(String(value.wake ?? ""));
        state.ticks += 1;
        state.executed = 0;
        state.dueNow = 0;
        state.lastTickAt = Number(value.at ?? state.lastTickAt);
        break;
      default:
        break;
    }
  }
  // Every completed turn owes one tick, which is how a reminder created in a
  // conversation gets scheduled without anyone calling in.
  for (const turn of completedTurns) state.due.add(`turn-${turn}`);
  return state;
}

export interface ElizaTaskComponentOptions {
  readonly name?: string;
}

/**
 * Owes a tick for every wake whose deadline has landed and for every
 * completed turn, then arms the next wake from what the tick reported.
 */
export function elizaTaskComponent(
  options: ElizaTaskComponentOptions = {},
): AgentComponent<ElizaOwner | OwnerRuntimePort | EventLog> {
  const name = options.name ?? "eliza-tasks";
  type R = ElizaOwner | OwnerRuntimePort | EventLog;
  const view: AgentView = { system: [], tools: [], context: [], output: [] };
  return legacyComponent<AgentView, R>({
    name,
    keys: elizaTickKeys,
    derive: (log) => {
      const state = scheduleOf(log);
      const transitions: Array<Transition<never, R>> = [];

      for (const wake of state.due) {
        if (state.ticked.has(wake)) continue;
        transitions.push(
          effect<{ readonly wake: string }, R>({
            // Unbound on purpose: the deadline cancellation that woke this
            // thread must not suppress the work it woke the thread for.
            key: `${ELIZA_TICK_PREFIX}${wake}`,
            input: { wake },
            act: (input) =>
              Effect.gen(function* () {
                const owner = yield* ElizaOwner;
                const port = yield* OwnerRuntimePort;
                const at = yield* Effect.clockWith(
                  (clock) => clock.currentTimeMillis,
                );
                const outcome = yield* Effect.result(
                  port.invoke({
                    key: `${ELIZA_TICK_PREFIX}${owner.owner}/${input.wake}`,
                    kind: "tick",
                    name: "tick",
                    thread: "",
                    turn: input.wake,
                    payload: { wake: input.wake },
                  }),
                );
                if (outcome._tag === "Failure") {
                  return [
                    elizaTickFailed({
                      wake: input.wake,
                      code: outcome.failure.code,
                      error: outcome.failure.message,
                      at,
                    }),
                  ];
                }
                const result = outcome.success.result as {
                  readonly executed: number;
                  readonly nextDueAt: number | null;
                  readonly dueNow: number;
                };
                return [
                  ...outcome.success.events,
                  elizaTickCompleted({
                    wake: input.wake,
                    executed: result.executed,
                    nextDueAt: result.nextDueAt,
                    dueNow: result.dueNow,
                    at,
                  }),
                ];
              }),
          }) as Transition<never, R>,
        );
      }
      if (transitions.length > 0) return { view, transitions };

      // Nothing owed: arm the next wake from what the last tick reported. The
      // wait is measured from the log's own latest timestamp, not the wall
      // clock, so deriving the same log twice arms the same call.
      const self = selfAddressOf(log);
      if (self === undefined || state.ticks === 0) {
        return { view, transitions: [] };
      }
      const base = state.lastTickAt > 0 ? state.lastTickAt : state.latestAt;
      // Wake at the earliest of: draining again after work ran, the next due
      // time still ahead, and a backoff for a row that claims to be due but
      // never runs. The target is a function of the last tick alone, so
      // re-deriving the same log arms the same call rather than a new one.
      const candidates: number[] = [];
      if (state.executed > 0) candidates.push(base + MIN_WAKE_MS);
      if (state.nextDueAt !== null && state.nextDueAt > base) {
        candidates.push(state.nextDueAt);
      }
      if (candidates.length === 0 && state.dueNow > 0) {
        candidates.push(base + IDLE_WAKE_MS);
      }
      if (candidates.length === 0) return { view, transitions: [] };
      const target = Math.min(...candidates);
      const id = `wake-${target}-${state.ticks}`;
      if (state.armed.has(id) || state.due.has(id) || state.ticked.has(id)) {
        return { view, transitions: [] };
      }
      const wait = Math.min(Math.max(target - base, MIN_WAKE_MS), MAX_WAKE_MS);
      const call = actorCall(log, {
        target: { coordinate: self, methods: ELIZA_WAKE_METHODS },
        method: "wake",
        input: { dueAt: target, reason: "eliza tasks" },
        id,
        timeoutMs: wait,
      });
      return {
        view,
        transitions: call.transitions as unknown as ReadonlyArray<
          Transition<never, R>
        >,
      };
    },
  }) as AgentComponent<R>;
}

export const TARDIGRADE_TASK_SERVICE_MISSING =
  "TARDIGRADE_TASK_SERVICE_MISSING";

export interface DueSummary {
  /** The earliest due time still ahead of `now`, or null when none is. */
  readonly nextDueAt: number | null;
  /** Queued tasks whose due time has already passed. */
  readonly dueNow: number;
}

/**
 * When this owner's queue next needs attention, mirroring core's own tick
 * rules: a repeating task is due at `updatedAt + updateInterval - notBefore`,
 * a one-shot at its `dueAt` or `metadata.scheduledAt`, and a one-shot with
 * neither runs at the next tick. Core owns the decision to execute; this only
 * decides when to wake, and separates work already due from work still ahead
 * so a row that never runs cannot hold the schedule at its floor.
 */
export function dueSummaryOf(
  tasks: ReadonlyArray<{
    readonly tags?: ReadonlyArray<string>;
    readonly dueAt?: unknown;
    readonly metadata?: Record<string, unknown>;
  }>,
  now: number,
): DueSummary {
  let nextDueAt: number | null = null;
  let dueNow = 0;
  const consider = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return;
    if (value <= now) {
      dueNow += 1;
      return;
    }
    nextDueAt = nextDueAt === null ? value : Math.min(nextDueAt, value);
  };
  for (const task of tasks) {
    const metadata = task.metadata ?? {};
    if (metadata.paused === true) continue;
    if (task.tags?.includes("repeat") === true) {
      const interval = Number(metadata.updateInterval ?? 0);
      const lastRan = Number(metadata.updatedAt ?? 0);
      const notBefore = Number(metadata.notBefore ?? 0);
      if (interval > 0 && Number.isFinite(lastRan)) {
        consider(lastRan + interval - notBefore);
      }
      continue;
    }
    const explicit =
      typeof task.dueAt === "number"
        ? task.dueAt
        : typeof metadata.scheduledAt === "number"
          ? (metadata.scheduledAt as number)
          : null;
    consider(explicit ?? 0);
  }
  return { nextDueAt, dueNow };
}

/**
 * The owner-side tick: core's `TaskService.runDueTasks()` for this owner,
 * then the next due time so the engine knows when to wake again.
 */
export function tickExecutor(options: { readonly now?: () => number } = {}): {
  readonly policy: "idempotent";
  readonly run: (context: {
    readonly runtime: {
      readonly agentId: string;
      getService(name: string): unknown;
      getTasks(params: Record<string, unknown>): Promise<
        ReadonlyArray<{
          readonly tags?: ReadonlyArray<string>;
          readonly dueAt?: unknown;
          readonly metadata?: Record<string, unknown>;
        }>
      >;
    };
    readonly owner: string;
  }) => Promise<{
    readonly result: {
      readonly executed: number;
      readonly nextDueAt: number | null;
    };
  }>;
} {
  const now = options.now ?? (() => Date.now());
  return {
    policy: "idempotent",
    run: async (context) => {
      const service = context.runtime.getService("task") as {
        runDueTasks?: () => Promise<void>;
      } | null;
      if (service?.runDueTasks === undefined) {
        throw new ElizaError(
          "The owner runtime has no core TaskService, so scheduled work cannot run",
          {
            code: TARDIGRADE_TASK_SERVICE_MISSING,
            context: { owner: context.owner },
          },
        );
      }
      const before = await context.runtime.getTasks({ tags: ["queue"] });
      const ran = dueSummaryOf(before, now()).dueNow;
      await service.runDueTasks();
      const after = await context.runtime.getTasks({ tags: ["queue"] });
      const summary = dueSummaryOf(after, now());
      return {
        result: {
          // A repeating task stays in the queue with a later due time, and a
          // one-shot leaves it; either way what moved off "due" is what ran.
          executed: Math.max(0, ran - summary.dueNow),
          nextDueAt: summary.nextDueAt,
          dueNow: summary.dueNow,
        },
      };
    },
  };
}
