/**
 * elizaOS evaluators as a native component. The engine settles a turn with
 * `TurnCompleted`; this component then owes one keyed effect that records the
 * reply as a memory and runs the owner's evaluator pipeline over the finished
 * exchange, exactly where the message pipeline ran it. The pass is idempotent
 * by turn, so a recovered host runs it once, and its outcome — including a
 * failure — lands in the log rather than being swallowed.
 *
 * Evaluation never blocks the reply: the turn is already complete when the
 * effect is owed, so a slow or failing evaluator cannot hold up the user's
 * answer, only its own record.
 */

import { Effect } from "effect";
import type { AgentComponent, AgentView } from "tardie/agent";
import { component } from "tardie/core/component";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime/context";
import type { Transition } from "tardie/core/transition";
import type { TransitionContext } from "tardie/core/transition/transition";
import { ElizaOwner } from "../hosts/identity";
import { OwnerRuntimePort } from "../owner/port";
import {
  ELIZA_EVALUATE_PREFIX,
  elizaEvaluated,
  elizaEvaluateKeys,
  elizaEvaluationFailed,
} from "./events";
import type { NativeEvaluateOutput } from "./executor";
import { currentTurnRef } from "./packages";

export const ELIZA_EVALUATE_TAG = "eliza-evaluate";

const EMPTY_VIEW: AgentView = {
  system: [],
  tools: [],
  context: [],
  output: [],
};

interface PendingEvaluation {
  readonly turn: string;
  readonly reply: string;
  readonly context: TransitionContext;
}

interface EvaluateState {
  readonly pending: ReadonlyMap<string, PendingEvaluation>;
  readonly order: ReadonlyArray<string>;
  readonly done: ReadonlySet<string>;
}

const initialEvaluate = (): EvaluateState => ({
  pending: new Map(),
  order: [],
  done: new Set(),
});

export interface ElizaEvaluatorOptions {
  readonly name?: string;
}

/** Runs the owner's evaluators once per completed turn. */
export function elizaEvaluatorComponent(
  options: ElizaEvaluatorOptions = {},
): AgentComponent<ElizaOwner | OwnerRuntimePort | EventLog | Self> {
  const name = options.name ?? "eliza-evaluators";
  const built = component<
    EvaluateState,
    AgentView,
    ElizaOwner | OwnerRuntimePort | EventLog | Self
  >({
    name,
    initial: initialEvaluate,
    step: (state, event, context) => {
      const record = event as unknown as Record<string, unknown>;
      if (record.type === "TurnCompleted") {
        const turn = String(record.turn ?? "");
        if (turn === "" || state.done.has(turn) || state.pending.has(turn)) {
          return state;
        }
        const pending = new Map(state.pending);
        pending.set(turn, {
          turn,
          reply: typeof record.output === "string" ? record.output : "",
          context,
        });
        return { ...state, pending, order: [...state.order, turn] };
      }
      if (
        record.type === "ElizaEvaluated" ||
        record.type === "ElizaEvaluationFailed"
      ) {
        const turn = String(record.turn ?? "");
        const pending = new Map(state.pending);
        pending.delete(turn);
        return {
          pending,
          order: state.order.filter((entry) => entry !== turn),
          done: new Set([...state.done, turn]),
        };
      }
      return state;
    },
    output: (state) => {
      const head = state.order
        .map((turn) => state.pending.get(turn))
        .find(Boolean);
      if (head === undefined) return { view: EMPTY_VIEW, transitions: [] };
      const transitions: ReadonlyArray<
        Transition<never, ElizaOwner | OwnerRuntimePort | EventLog | Self>
      > = [
        head.context.effect(ELIZA_EVALUATE_TAG, {
          input: { turn: head.turn, reply: head.reply },
          act: (input: { readonly turn: string; readonly reply: string }) =>
            Effect.gen(function* () {
              const owner = yield* ElizaOwner;
              const port = yield* OwnerRuntimePort;
              const self = yield* Self;
              const log = yield* EventLog;
              const events = yield* log.read;
              const at = yield* Effect.clockWith(
                (clock) => clock.currentTimeMillis,
              );
              const turn = currentTurnRef(events, owner.owner, self.thread);
              const outcome = yield* Effect.result(
                port.invoke({
                  key: JSON.stringify([
                    self.actor,
                    self.instance,
                    self.thread,
                    `${ELIZA_EVALUATE_PREFIX}${input.turn}`,
                  ]),
                  kind: "evaluate",
                  name: "evaluate",
                  thread: self.thread,
                  turn: input.turn,
                  payload: {
                    turn: { ...turn, turn: input.turn },
                    reply: input.reply,
                  },
                }),
              );
              if (outcome._tag === "Failure") {
                return [
                  elizaEvaluationFailed({
                    turn: input.turn,
                    code: outcome.failure.code,
                    error: outcome.failure.message,
                    at,
                  }),
                ];
              }
              const summary = outcome.success.result as NativeEvaluateOutput;
              return [
                ...outcome.success.events,
                elizaEvaluated({
                  turn: input.turn,
                  skipped: summary.skipped,
                  evaluators: summary.activeEvaluators,
                  processed: summary.processedEvaluators,
                  at,
                }),
              ];
            }),
        }),
      ];
      return { view: EMPTY_VIEW, transitions };
    },
  });
  return { ...built, keys: elizaEvaluateKeys };
}
