/**
 * The Eliza actor: a Tardigrade component that owes one `turn` effect per
 * unserved message and settles it with Eliza's own decision loop. The
 * component's state is a pure projection of the thread log — served turns,
 * the effect journal, the thread's owner binding, and the queue of pending
 * messages with their transition contexts — so a recovered host derives the
 * same owed transition, and the act consults the journal before touching the
 * outside world.
 *
 * Turns execute one at a time per thread in arrival order. The act appends
 * boundary evidence through the thread's `EventLog` as the turn progresses
 * and returns Tardigrade's own `TurnCompleted`/`TurnFailed` terminal, which
 * is what the generic `message` method projects into the caller's result.
 */

import { ElizaError, type Task } from "@elizaos/core/edge";
import { Clock, Context, Effect, Schema } from "effect";
import { agentMessageMethod, ModelRef } from "tardie/agent";
import {
  type Actor,
  actor,
  actorMethod,
  component,
  handles,
} from "tardie/core/actor";
import type { Event } from "tardie/core/event";
import { messageKeys } from "tardie/core/interaction/provider-message";
import type { ActorMethodProjection } from "tardie/core/interaction/state";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime/context";
import type { TransitionContext } from "tardie/core/transition/transition";
import {
  agentKeys,
  type TurnFailureCause,
  turnCompleted,
  turnFailed,
} from "tardie/log/events";
import {
  elizaKeys,
  elizaThreadBound,
  elizaTickCompleted,
  elizaTickFailed,
} from "./events";
import type { TurnHistoryEntry } from "./history";
import {
  type HistoryState,
  historyBefore,
  initialHistory,
  reduceHistory,
} from "./history";
import {
  initialJournal,
  type JournalState,
  journalOf,
  reduceJournal,
  TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
  type TurnJournal,
} from "./journal";
import {
  initialTaskJournal,
  reduceTaskJournal,
  runDueTasksMethod,
  type TaskJournalState,
  tasksOf,
} from "./scheduling";
import { type ElizaTurnConfig, runElizaTick, runElizaTurn } from "./turn";

export const TARDIGRADE_OWNER_REQUIRED = "TARDIGRADE_OWNER_REQUIRED";
export const TARDIGRADE_OWNER_MISMATCH = "TARDIGRADE_OWNER_MISMATCH";
export const TARDIGRADE_OWNER_INSTANCE_MISMATCH =
  "TARDIGRADE_OWNER_INSTANCE_MISMATCH";
export const TARDIGRADE_THREAD_UNBOUND = "TARDIGRADE_THREAD_UNBOUND";

/** Host-provided turn configuration: model, plugins, delivery, capabilities. */
export class ElizaTurnServices extends Context.Service<
  ElizaTurnServices,
  { readonly config: ElizaTurnConfig }
>()("elizaos/tardigrade/TurnServices") {}

export interface ElizaMessageInput {
  readonly owner: string;
  readonly sender?: string;
  readonly source?: string;
}

/** Typed `message` input: the generic agent contract with the owner claim required. */
export const ElizaMessageMethodInput = Schema.Struct({
  text: Schema.String,
  input: Schema.Struct({
    owner: Schema.String,
    sender: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.String),
  }),
  model: Schema.optionalKey(ModelRef),
}).annotate({ identifier: "ElizaMessageInput" });

/**
 * Tardigrade's agent message method with the adapter's input schema, so the
 * owner claim is validated at the method boundary and `tdg methods` publishes
 * it; events, projection, and cancellation are the generic method's own.
 */
export const elizaMessageMethod = actorMethod({
  input: ElizaMessageMethodInput,
  output: agentMessageMethod.output,
  timeoutMs: agentMessageMethod.timeoutMs,
  durableInput: agentMessageMethod.durableInput,
  event: (call) => agentMessageMethod.event(call),
  // The generic method erases its state type; the output stays the reply string.
  projection: agentMessageMethod.projection as ActorMethodProjection<
    unknown,
    string
  >,
  cancellation: agentMessageMethod.cancellation,
});

interface PendingTurn {
  readonly kind: "turn";
  readonly turn: string;
  readonly epoch: number;
  readonly text: string;
  readonly input: Partial<ElizaMessageInput>;
  readonly at: number;
  readonly context: TransitionContext;
}

interface PendingTick {
  readonly kind: "tick";
  readonly tick: string;
  readonly epoch: number;
  readonly owner: string;
  readonly at: number;
  readonly context: TransitionContext;
}

type PendingWork = PendingTurn | PendingTick;

interface ThreadBinding {
  readonly owner: string;
  readonly agent: string;
}

interface ElizaActorState {
  readonly history: HistoryState;
  readonly journal: JournalState;
  readonly tasks: TaskJournalState;
  readonly bound?: ThreadBinding;
  readonly pending: ReadonlyMap<string, PendingWork>;
  readonly order: ReadonlyArray<string>;
}

interface TurnEffectInput {
  readonly turn: string;
  readonly epoch: number;
  readonly text: string;
  readonly input: Partial<ElizaMessageInput>;
  readonly history: ReadonlyArray<TurnHistoryEntry>;
  readonly journal: TurnJournal;
  readonly tasks: ReadonlyArray<Task>;
  readonly bound?: ThreadBinding;
}

interface TickEffectInput {
  readonly tick: string;
  readonly epoch: number;
  readonly owner: string;
  readonly journal: TurnJournal;
  readonly tasks: ReadonlyArray<Task>;
  readonly bound?: ThreadBinding;
}

type TickResult =
  | { readonly kind: "completed"; readonly executed: number }
  | { readonly kind: "failed"; readonly error: string };

type TurnResult =
  | { readonly kind: "completed"; readonly output: string }
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly cause: TurnFailureCause;
    };

const eventEpoch = (record: Record<string, unknown>): number => {
  const epoch = record.epoch;
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
    ? epoch
    : 0;
};

const messageInputOf = (value: unknown): Partial<ElizaMessageInput> => {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const pick = (name: keyof ElizaMessageInput) =>
    typeof record[name] === "string" && record[name]
      ? { [name]: record[name] as string }
      : {};
  return { ...pick("owner"), ...pick("sender"), ...pick("source") };
};

const isTerminal = (type: string): boolean =>
  type === "TurnCompleted" || type === "TurnFailed" || type === "TurnCancelled";

const isTickTerminal = (type: string): boolean =>
  type === "ElizaTickCompleted" || type === "ElizaTickFailed";

const initialState = (): ElizaActorState => ({
  history: initialHistory(),
  journal: initialJournal(),
  tasks: initialTaskJournal(),
  pending: new Map(),
  order: [],
});

const withoutPending = (
  state: ElizaActorState,
  id: string,
): ElizaActorState => {
  if (!state.pending.has(id)) return state;
  const pending = new Map(state.pending);
  pending.delete(id);
  return { ...state, pending };
};

function reduceState(
  state: ElizaActorState,
  event: Event,
  context: TransitionContext,
): ElizaActorState {
  const record = event as Record<string, unknown>;
  let next: ElizaActorState = {
    ...state,
    history: reduceHistory(state.history, event),
    journal: reduceJournal(state.journal, event),
    tasks: reduceTaskJournal(state.tasks, event),
  };
  if (event.type === "ElizaTickRequested") {
    const tick = String(record.id ?? "");
    if (tick && !next.pending.has(tick)) {
      const pending = new Map(next.pending);
      pending.set(tick, {
        kind: "tick",
        tick,
        epoch: eventEpoch(record),
        owner: String(record.owner ?? ""),
        at: typeof record.at === "number" ? record.at : 0,
        context,
      });
      next = { ...next, pending, order: [...next.order, tick] };
    }
  } else if (isTickTerminal(event.type)) {
    next = withoutPending(next, String(record.tick ?? ""));
  } else if (event.type === "MessageReceived") {
    const turn = String(record.id ?? "");
    if (
      turn &&
      !next.pending.has(turn) &&
      next.history.entries.get(turn)?.output === undefined
    ) {
      const pending = new Map(next.pending);
      pending.set(turn, {
        kind: "turn",
        turn,
        epoch: eventEpoch(record),
        text: String(record.text ?? ""),
        input: messageInputOf(record.input),
        at: typeof record.at === "number" ? record.at : 0,
        context,
      });
      next = { ...next, pending, order: [...next.order, turn] };
    }
  } else if (isTerminal(event.type)) {
    const turn = String(record.turn ?? "");
    const owed = next.pending.get(turn);
    if (owed && eventEpoch(record) === owed.epoch)
      next = withoutPending(next, turn);
  } else if (event.type === "ElizaThreadBound" && next.bound === undefined) {
    next = {
      ...next,
      bound: { owner: String(record.owner), agent: String(record.agent) },
    };
  }
  return next;
}

const failureCauseOf = (error: unknown): TurnFailureCause => {
  if (error instanceof ElizaError) {
    if (error.code === "MODEL_OUTPUT_INCOMPLETE") return "truncated";
    if (error.code === TARDIGRADE_EFFECT_OUTCOME_UNKNOWN)
      return "inference_attempts_exhausted";
  }
  return "inference_error";
};

const failureTextOf = (error: unknown): string => {
  if (error instanceof ElizaError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

async function executeTurn(
  config: ElizaTurnConfig,
  input: TurnEffectInput,
  self: { readonly instance: string; readonly thread: string },
  append: (events: ReadonlyArray<Event>) => Promise<void>,
  now: () => number,
  signal: AbortSignal,
): Promise<TurnResult> {
  const owner = input.input.owner;
  if (!owner) {
    return {
      kind: "failed",
      cause: "message_invalid",
      error: `${TARDIGRADE_OWNER_REQUIRED}: message input must name the thread owner`,
    };
  }
  // The actor instance is the tenant the host allocated the thread under; an
  // owner claim naming another tenant cannot be admitted by a label.
  if (owner !== self.instance) {
    return {
      kind: "failed",
      cause: "message_invalid",
      error: `${TARDIGRADE_OWNER_INSTANCE_MISMATCH}: owner ${owner} does not match the actor instance ${self.instance} that holds this thread`,
    };
  }
  if (input.bound !== undefined && input.bound.owner !== owner) {
    return {
      kind: "failed",
      cause: "message_invalid",
      error: `${TARDIGRADE_OWNER_MISMATCH}: thread is bound to another owner; ${owner} may not use it`,
    };
  }
  try {
    if (input.bound === undefined) {
      await append([
        elizaThreadBound({ owner, agent: config.agentKey, at: now() }),
      ]);
    }
    const outcome = await runElizaTurn(config, {
      turn: input.turn,
      epoch: input.epoch,
      text: input.text,
      owner,
      sender: input.input.sender ?? owner,
      source: input.input.source ?? "tardigrade",
      roomKey: self.thread,
      history: input.history,
      journal: input.journal,
      tasks: input.tasks,
      append,
      signal,
    });
    return { kind: "completed", output: outcome.reply };
  } catch (error) {
    // error-policy:J1 the turn effect is the actor's boundary: every failure
    // becomes a durable TurnFailed terminal the caller reads, never a wedged
    // transition or a fabricated reply.
    return {
      kind: "failed",
      cause: failureCauseOf(error),
      error: failureTextOf(error),
    };
  }
}

async function executeTick(
  config: ElizaTurnConfig,
  input: TickEffectInput,
  self: { readonly instance: string; readonly thread: string },
  append: (events: ReadonlyArray<Event>) => Promise<void>,
  signal: AbortSignal,
): Promise<TickResult> {
  if (input.owner !== self.instance) {
    return {
      kind: "failed",
      error: `${TARDIGRADE_OWNER_INSTANCE_MISMATCH}: owner ${input.owner} does not match the actor instance ${self.instance} that holds this thread`,
    };
  }
  if (input.bound !== undefined && input.bound.owner !== input.owner) {
    return {
      kind: "failed",
      error: `${TARDIGRADE_OWNER_MISMATCH}: thread is bound to another owner; ${input.owner} may not tick it`,
    };
  }
  if (input.bound === undefined) {
    return {
      kind: "failed",
      error: `${TARDIGRADE_THREAD_UNBOUND}: no message has bound this thread yet`,
    };
  }
  try {
    const outcome = await runElizaTick(config, {
      tick: input.tick,
      epoch: input.epoch,
      owner: input.owner,
      roomKey: self.thread,
      journal: input.journal,
      tasks: input.tasks,
      append,
      signal,
    });
    return { kind: "completed", executed: outcome.executed };
  } catch (error) {
    // error-policy:J1 the tick effect is the actor's boundary; a failure is
    // a durable ElizaTickFailed the caller reads, never a wedged transition.
    return { kind: "failed", error: failureTextOf(error) };
  }
}

/** The component that runs Eliza turns for a thread. */
export function elizaTurnComponent() {
  const definition = component<
    ElizaActorState,
    Record<string, never>,
    ElizaTurnServices | Self
  >({
    name: "eliza-turn",
    initial: initialState,
    step: reduceState,
    output: (state) => {
      const head = state.order
        .map((turn) => state.pending.get(turn))
        .find(Boolean);
      if (!head) return { view: {}, transitions: [] };
      if (head.kind === "tick") {
        const input: TickEffectInput = {
          tick: head.tick,
          epoch: head.epoch,
          owner: head.owner,
          journal: journalOf(state.journal, head.tick, head.epoch),
          tasks: tasksOf(state.tasks),
          ...(state.bound === undefined ? {} : { bound: state.bound }),
        };
        return {
          view: {},
          transitions: [
            head.context.effect("tick", {
              input,
              act: (tick, { signal }) =>
                Effect.gen(function* () {
                  const log = yield* EventLog;
                  const self = yield* Self;
                  const { config } = yield* ElizaTurnServices;
                  const append = (events: ReadonlyArray<Event>) =>
                    Effect.runPromise(log.append(events));
                  const result = yield* Effect.promise(() =>
                    executeTick(config, tick, self, append, signal),
                  );
                  const at = yield* Clock.currentTimeMillis;
                  return result.kind === "completed"
                    ? elizaTickCompleted({
                        tick: tick.tick,
                        executed: result.executed,
                        at,
                      })
                    : elizaTickFailed({
                        tick: tick.tick,
                        error: result.error,
                        at,
                      });
                }),
            }),
          ],
        };
      }
      const input: TurnEffectInput = {
        turn: head.turn,
        epoch: head.epoch,
        text: head.text,
        input: head.input,
        history: historyBefore(state.history, head.turn),
        journal: journalOf(state.journal, head.turn, head.epoch),
        tasks: tasksOf(state.tasks),
        ...(state.bound === undefined ? {} : { bound: state.bound }),
      };
      return {
        view: {},
        transitions: [
          head.context.effect("turn", {
            input,
            act: (turn, { signal }) =>
              Effect.gen(function* () {
                const log = yield* EventLog;
                const self = yield* Self;
                const { config } = yield* ElizaTurnServices;
                const append = (events: ReadonlyArray<Event>) =>
                  Effect.runPromise(log.append(events));
                const result = yield* Effect.promise(() =>
                  executeTurn(
                    config,
                    turn,
                    self,
                    append,
                    () => Date.now(),
                    signal,
                  ),
                );
                const at = yield* Clock.currentTimeMillis;
                const stamp = {
                  turn: turn.turn,
                  ...(turn.epoch === 0 ? {} : { epoch: turn.epoch }),
                  at,
                };
                return result.kind === "completed"
                  ? turnCompleted({
                      output: result.output,
                      attemptKey: `${turn.turn}/eliza`,
                      ...stamp,
                    })
                  : turnFailed({
                      error: result.error,
                      cause: result.cause,
                      attempts: 1,
                      attemptKey: `${turn.turn}/eliza`,
                      ...stamp,
                    });
              }),
          }),
        ],
      };
    },
  });
  return handles(
    runDueTasksMethod,
    handles(elizaMessageMethod, {
      ...definition,
      keys: {
        prefixes: [
          ...messageKeys.prefixes,
          ...agentKeys.prefixes,
          ...elizaKeys.prefixes,
        ],
        keyOf: (event) =>
          messageKeys.keyOf(event) ??
          agentKeys.keyOf(event) ??
          elizaKeys.keyOf(event),
      },
    }),
  );
}

export interface ElizaActorOptions {
  readonly name: string;
}

/** A named Tardigrade actor whose `message` method runs Eliza turns. */
export function elizaActor(options: ElizaActorOptions) {
  return actor({
    name: options.name,
    methods: { message: elizaMessageMethod, runDueTasks: runDueTasksMethod },
    components: [elizaTurnComponent()],
  });
}

export type ElizaActor = ReturnType<typeof elizaActor>;
export type { Actor };
