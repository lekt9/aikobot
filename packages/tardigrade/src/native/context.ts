/**
 * elizaOS providers as native context, and the two rules that keep it honest.
 *
 * `elizaContextComponent` owes one keyed effect per unanswered message: the
 * owner's runtime composes its providers exactly as elizaOS would, and the
 * complete text lands in the log as `ElizaContextComposed` and in the turn's
 * system view. `elizaEvidenceFirst` re-sorts the assembled root's transitions
 * so that effect commits before the engine's first model call, the way the
 * pipeline composed state before prompting.
 *
 * `losslessContext` raises the render caps that would otherwise cut a long
 * message or a long tool result with a "[truncated at N of M chars]" marker.
 * This repository forbids silently shortening model-facing content, so the
 * caps are lifted rather than tuned, and no compaction component is mounted;
 * a context window a provider cannot accept must fail explicitly instead.
 */

import { Effect } from "effect";
import type { AgentComponent, AgentView } from "tardie/agent";
import type { Component } from "tardie/core/component";
import { component } from "tardie/core/component";
import type { Event } from "tardie/core/event";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime/context";
import type { Transition } from "tardie/core/transition";
import type { TransitionContext } from "tardie/core/transition/transition";
import { ElizaOwner } from "../hosts/identity";
import { OwnerRuntimePort } from "../owner/port";
import {
  ELIZA_CONTEXT_PREFIX,
  elizaContextComposed,
  elizaContextFailed,
  elizaContextKeys,
} from "./events";
import type { NativeContextOutput } from "./executor";
import { currentTurnRef } from "./packages";

export const ELIZA_CONTEXT_TAG = "eliza-context";
const EMPTY_VIEW: AgentView = {
  system: [],
  tools: [],
  context: [],
  output: [],
};

/**
 * The render caps, lifted. `positive()` only requires a finite positive
 * number, so the maximum safe integer is the honest way to say "never cut";
 * a payload no provider will accept then fails at dispatch with the
 * provider's own error instead of being quietly shortened.
 */
export const LOSSLESS_RENDER_CAP = Number.MAX_SAFE_INTEGER;

/** Declares that this agent never truncates a message or a tool result. */
export function losslessContext(
  name = "eliza-lossless-context",
): AgentComponent<never> {
  return component<undefined, AgentView, never>({
    name,
    initial: () => undefined,
    step: (state: undefined) => state,
    output: () => ({
      view: {
        ...EMPTY_VIEW,
        context: [
          {
            component: name,
            policy: {
              messageRenderCap: LOSSLESS_RENDER_CAP,
              resultRenderCap: LOSSLESS_RENDER_CAP,
            },
          },
        ],
      },
      transitions: [],
    }),
  });
}

interface PendingContext {
  readonly turn: string;
  readonly context: TransitionContext;
}

interface ContextState {
  readonly pending: ReadonlyMap<string, PendingContext>;
  readonly composed: ReadonlyMap<string, string>;
  readonly order: ReadonlyArray<string>;
  readonly latest: string | undefined;
}

const initialContext = (): ContextState => ({
  pending: new Map(),
  composed: new Map(),
  order: [],
  latest: undefined,
});

function withoutPending(state: ContextState, turn: string): ContextState {
  if (!state.pending.has(turn)) return state;
  const pending = new Map(state.pending);
  pending.delete(turn);
  return {
    ...state,
    pending,
    order: state.order.filter((entry) => entry !== turn),
  };
}

export interface ElizaContextOptions {
  /** Provider names to compose; omitted means the runtime's own default set. */
  readonly providers?: ReadonlyArray<string>;
  readonly name?: string;
}

/**
 * One provider composition per turn, executed in the owner's runtime and
 * recorded whole. A failure is recorded too: the turn proceeds without that
 * context rather than stalling, and the log says why.
 */
export function elizaContextComponent(
  options: ElizaContextOptions = {},
): AgentComponent<ElizaOwner | OwnerRuntimePort | EventLog | Self> {
  const name = options.name ?? "eliza-context";
  const built = component<
    ContextState,
    AgentView,
    ElizaOwner | OwnerRuntimePort | EventLog | Self
  >({
    name,
    initial: initialContext,
    step: (state, event, context) => {
      const record = event as unknown as Record<string, unknown>;
      if (record.type === "MessageReceived") {
        const turn = String(record.id ?? "");
        if (
          turn === "" ||
          state.pending.has(turn) ||
          state.composed.has(turn)
        ) {
          return { ...state, latest: turn === "" ? state.latest : turn };
        }
        const pending = new Map(state.pending);
        pending.set(turn, { turn, context });
        return {
          ...state,
          pending,
          order: [...state.order, turn],
          latest: turn,
        };
      }
      if (record.type === "ElizaContextComposed") {
        const turn = String(record.turn ?? "");
        const composed = new Map(state.composed);
        composed.set(turn, String(record.text ?? ""));
        return { ...withoutPending(state, turn), composed };
      }
      if (record.type === "ElizaContextFailed") {
        return withoutPending(state, String(record.turn ?? ""));
      }
      return state;
    },
    output: (state) => {
      const text =
        state.latest === undefined
          ? undefined
          : state.composed.get(state.latest);
      const view: AgentView = {
        ...EMPTY_VIEW,
        system: text === undefined || text.length === 0 ? [] : [text],
      };
      const head = state.order
        .map((turn) => state.pending.get(turn))
        .find(Boolean);
      if (head === undefined) return { view, transitions: [] };
      const transitions: ReadonlyArray<
        Transition<never, ElizaOwner | OwnerRuntimePort | EventLog | Self>
      > = [
        head.context.effect(ELIZA_CONTEXT_TAG, {
          input: { turn: head.turn },
          act: (input: { readonly turn: string }) =>
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
              if (turn.turn !== input.turn) {
                return [
                  elizaContextFailed({
                    turn: input.turn,
                    code: "TARDIGRADE_CONTEXT_TURN_DRIFT",
                    error: `the thread's latest message is ${turn.turn}`,
                    at,
                  }),
                ];
              }
              const outcome = yield* Effect.result(
                port.invoke({
                  key: JSON.stringify([
                    self.actor,
                    self.instance,
                    self.thread,
                    `${ELIZA_CONTEXT_PREFIX}${input.turn}`,
                  ]),
                  kind: "context",
                  name: "context",
                  thread: self.thread,
                  turn: input.turn,
                  payload: {
                    turn,
                    ...(options.providers === undefined
                      ? {}
                      : { providers: options.providers }),
                  },
                }),
              );
              if (outcome._tag === "Failure") {
                return [
                  elizaContextFailed({
                    turn: input.turn,
                    code: outcome.failure.code,
                    error: outcome.failure.message,
                    at,
                  }),
                ];
              }
              const composed = outcome.success.result as NativeContextOutput;
              return [
                ...outcome.success.events,
                elizaContextComposed({
                  turn: input.turn,
                  text: composed.text,
                  providers: composed.providers,
                  at,
                }),
              ];
            }),
        }),
      ];
      return { view, transitions };
    },
  });
  return { ...built, keys: elizaContextKeys };
}

/** The tag inside a transition key, whatever shape the runtime gave it. */
export function transitionTag(key: string): string {
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) &&
      parts.length === 3 &&
      typeof parts[2] === "string"
      ? parts[2]
      : key;
  } catch {
    // error-policy:J3 A key that is not a JSON coordinate is its own tag.
    return key;
  }
}

/**
 * Commits the named effects before the engine's model call. `infer` emits
 * child intents, then inference, then child effects; this re-sorts the
 * assembled root so an evidence effect lands first and the view is re-derived
 * with it. Intents keep their native priority.
 */
export function elizaEvidenceFirst<R>(
  source: Component<AgentView, R>,
  tags: ReadonlyArray<string> = [ELIZA_CONTEXT_TAG],
): Component<AgentView, R> {
  return {
    ...source,
    machine: {
      ...source.machine,
      output: (state) => {
        const output = source.machine.output(state);
        const priority = (work: { kind: string; key: string }): number => {
          if (work.kind === "intent") return -1;
          const index = tags.findIndex((tag) =>
            transitionTag(work.key).startsWith(tag),
          );
          return index < 0 ? tags.length : index;
        };
        return {
          ...output,
          transitions: [...output.transitions].sort(
            (a, b) =>
              priority(a as unknown as { kind: string; key: string }) -
              priority(b as unknown as { kind: string; key: string }),
          ),
        };
      },
    },
  };
}

/** Every event type the native context component records. */
export const ELIZA_CONTEXT_EVENTS: ReadonlyArray<string> = [
  "ElizaContextComposed",
  "ElizaContextFailed",
];

export type { Event };
