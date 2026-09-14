/**
 * Events the native composition adds to a thread's log. They are the durable
 * record of the elizaOS work the engine owed and got: the provider context
 * composed for a turn, and the evaluator pass that ran after it. Each is
 * keyed by its turn so a redelivered event is absorbed rather than repeated,
 * and each carries the complete text it produced — a reader of the log sees
 * exactly what the model saw.
 */

import { Schema } from "effect";
import type { Event } from "tardie/core/event";
import type { KeyFragment } from "tardie/core/log";

export const ELIZA_CONTEXT_PREFIX = "eliza/context:";
export const ELIZA_EVALUATE_PREFIX = "eliza/evaluate:";

export const ElizaContextComposed = Schema.Struct({
  type: Schema.Literal("ElizaContextComposed"),
  turn: Schema.String,
  /** The complete provider text, exactly as the model receives it. */
  text: Schema.String,
  providers: Schema.Array(Schema.String),
  at: Schema.Number,
}).annotate({ identifier: "ElizaContextComposed" });

export const ElizaContextFailed = Schema.Struct({
  type: Schema.Literal("ElizaContextFailed"),
  turn: Schema.String,
  code: Schema.String,
  error: Schema.String,
  at: Schema.Number,
}).annotate({ identifier: "ElizaContextFailed" });

export const ElizaEvaluated = Schema.Struct({
  type: Schema.Literal("ElizaEvaluated"),
  turn: Schema.String,
  skipped: Schema.Boolean,
  evaluators: Schema.Array(Schema.String),
  processed: Schema.Array(Schema.String),
  at: Schema.Number,
}).annotate({ identifier: "ElizaEvaluated" });

export const ElizaEvaluationFailed = Schema.Struct({
  type: Schema.Literal("ElizaEvaluationFailed"),
  turn: Schema.String,
  code: Schema.String,
  error: Schema.String,
  at: Schema.Number,
}).annotate({ identifier: "ElizaEvaluationFailed" });

export interface ElizaContextComposedFields {
  readonly turn: string;
  readonly text: string;
  readonly providers: ReadonlyArray<string>;
  readonly at: number;
}

export interface ElizaFailureFields {
  readonly turn: string;
  readonly code: string;
  readonly error: string;
  readonly at: number;
}

export interface ElizaEvaluatedFields {
  readonly turn: string;
  readonly skipped: boolean;
  readonly evaluators: ReadonlyArray<string>;
  readonly processed: ReadonlyArray<string>;
  readonly at: number;
}

export const elizaContextComposed = (
  fields: ElizaContextComposedFields,
): Event => ({ type: "ElizaContextComposed", ...fields }) as unknown as Event;

export const elizaContextFailed = (fields: ElizaFailureFields): Event =>
  ({ type: "ElizaContextFailed", ...fields }) as unknown as Event;

export const elizaEvaluated = (fields: ElizaEvaluatedFields): Event =>
  ({ type: "ElizaEvaluated", ...fields }) as unknown as Event;

export const elizaEvaluationFailed = (fields: ElizaFailureFields): Event =>
  ({ type: "ElizaEvaluationFailed", ...fields }) as unknown as Event;

/**
 * One context composition per turn, however often the event is delivered.
 * Each fragment claims its own prefix: the runtime refuses two fragments that
 * claim the same one, so the components cannot share a single fragment.
 */
export const elizaContextKeys: KeyFragment = {
  prefixes: [ELIZA_CONTEXT_PREFIX],
  keyOf: (event) => {
    const record = event as unknown as Record<string, unknown>;
    const turn = String(record.turn ?? "");
    if (turn === "") return undefined;
    return record.type === "ElizaContextComposed" ||
      record.type === "ElizaContextFailed"
      ? `${ELIZA_CONTEXT_PREFIX}${turn}`
      : undefined;
  },
};

/** One evaluator pass per turn, however often the event is delivered. */
export const elizaEvaluateKeys: KeyFragment = {
  prefixes: [ELIZA_EVALUATE_PREFIX],
  keyOf: (event) => {
    const record = event as unknown as Record<string, unknown>;
    const turn = String(record.turn ?? "");
    if (turn === "") return undefined;
    return record.type === "ElizaEvaluated" ||
      record.type === "ElizaEvaluationFailed"
      ? `${ELIZA_EVALUATE_PREFIX}${turn}`
      : undefined;
  },
};
