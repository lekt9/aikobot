/**
 * Durable event alphabet for Eliza turns hosted on Tardigrade. Every external
 * boundary of a turn (model call, action handler, delivery, task worker) lands
 * twice in the thread log: `ElizaBoundaryStarted` before the effect runs and
 * `ElizaBoundaryRecorded` once its outcome is known. Replay reads the record
 * instead of re-executing, and a started-but-unrecorded boundary is the
 * explicit "outcome unknown" state the recovery policy decides on.
 *
 * Events carry `turn` so Tardigrade's turn projection and `tdg events`
 * attribute them to the message they served. The key fragment makes a
 * duplicate append of the same boundary absorb instead of double-recording.
 */

import { Schema } from "effect";
import type { Event } from "tardie/core/event";
import type { KeyFragment } from "tardie/core/log";

export const ELIZA_BOUNDARY_KINDS = [
  "model",
  "action",
  "delivery",
  "task",
] as const;
export type ElizaBoundaryKind = (typeof ELIZA_BOUNDARY_KINDS)[number];

/**
 * How a boundary whose outcome is unknown after a crash may be retried.
 * `read` effects observe only; `idempotent` effects carry the stable operation
 * id downstream so the provider replays; `unsafe` effects end the turn.
 */
export const ELIZA_EFFECT_POLICIES = ["read", "idempotent", "unsafe"] as const;
export type ElizaEffectPolicy = (typeof ELIZA_EFFECT_POLICIES)[number];

export const ElizaBoundaryStarted = Schema.Struct({
  type: Schema.Literal("ElizaBoundaryStarted"),
  turn: Schema.String,
  epoch: Schema.optional(Schema.Finite),
  key: Schema.String,
  kind: Schema.Literals(ELIZA_BOUNDARY_KINDS),
  ordinal: Schema.Finite,
  name: Schema.String,
  operationId: Schema.String,
  policy: Schema.Literals(ELIZA_EFFECT_POLICIES),
  inputDigest: Schema.String,
  at: Schema.Finite,
});
export type ElizaBoundaryStarted = typeof ElizaBoundaryStarted.Type;

export const ElizaBoundaryRecorded = Schema.Struct({
  type: Schema.Literal("ElizaBoundaryRecorded"),
  turn: Schema.String,
  epoch: Schema.optional(Schema.Finite),
  key: Schema.String,
  kind: Schema.Literals(ELIZA_BOUNDARY_KINDS),
  ordinal: Schema.Finite,
  outcome: Schema.Literals(["returned", "failed"]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  at: Schema.Finite,
});
export type ElizaBoundaryRecorded = typeof ElizaBoundaryRecorded.Type;

/** A replayed boundary whose live input no longer matches the recorded input. */
export const ElizaReplayDiverged = Schema.Struct({
  type: Schema.Literal("ElizaReplayDiverged"),
  turn: Schema.String,
  epoch: Schema.optional(Schema.Finite),
  key: Schema.String,
  expectedDigest: Schema.String,
  actualDigest: Schema.String,
  at: Schema.Finite,
});
export type ElizaReplayDiverged = typeof ElizaReplayDiverged.Type;

/** Binds a thread to exactly one owner principal for its whole life. */
export const ElizaThreadBound = Schema.Struct({
  type: Schema.Literal("ElizaThreadBound"),
  owner: Schema.String,
  agent: Schema.String,
  at: Schema.Finite,
});
export type ElizaThreadBound = typeof ElizaThreadBound.Type;

/** Log-projected scheduled-task rows for the serverless TaskService contract. */
export const ElizaTaskUpserted = Schema.Struct({
  type: Schema.Literal("ElizaTaskUpserted"),
  taskId: Schema.String,
  task: Schema.Unknown,
  turn: Schema.optional(Schema.String),
  at: Schema.Finite,
});
export type ElizaTaskUpserted = typeof ElizaTaskUpserted.Type;

export const ElizaTaskDeleted = Schema.Struct({
  type: Schema.Literal("ElizaTaskDeleted"),
  taskId: Schema.String,
  turn: Schema.optional(Schema.String),
  at: Schema.Finite,
});
export type ElizaTaskDeleted = typeof ElizaTaskDeleted.Type;

/** Host wakeup that asks the actor to run due scheduled tasks. */
export const ElizaTickRequested = Schema.Struct({
  type: Schema.Literal("ElizaTickRequested"),
  id: Schema.String,
  owner: Schema.String,
  epoch: Schema.optional(Schema.Finite),
  at: Schema.Finite,
});
export type ElizaTickRequested = typeof ElizaTickRequested.Type;

export const ElizaTickCompleted = Schema.Struct({
  type: Schema.Literal("ElizaTickCompleted"),
  tick: Schema.String,
  executed: Schema.Finite,
  at: Schema.Finite,
});
export type ElizaTickCompleted = typeof ElizaTickCompleted.Type;

export const ElizaTickFailed = Schema.Struct({
  type: Schema.Literal("ElizaTickFailed"),
  tick: Schema.String,
  error: Schema.String,
  at: Schema.Finite,
});
export type ElizaTickFailed = typeof ElizaTickFailed.Type;

interface TurnStamp {
  readonly turn: string;
  readonly epoch?: number;
  readonly at: number;
}

const stamped = (stamp: TurnStamp) => ({
  turn: stamp.turn,
  ...(stamp.epoch === undefined || stamp.epoch === 0
    ? {}
    : { epoch: stamp.epoch }),
  at: stamp.at,
});

export const elizaBoundaryKey = (
  turn: string,
  epoch: number,
  kind: ElizaBoundaryKind,
  ordinal: number,
): string => `${turn}/${epoch}/${kind}/${ordinal}`;

export const elizaBoundaryStarted = (
  fields: TurnStamp & {
    readonly key: string;
    readonly kind: ElizaBoundaryKind;
    readonly ordinal: number;
    readonly name: string;
    readonly operationId: string;
    readonly policy: ElizaEffectPolicy;
    readonly inputDigest: string;
  },
): Event =>
  ({
    type: "ElizaBoundaryStarted",
    ...stamped(fields),
    key: fields.key,
    kind: fields.kind,
    ordinal: fields.ordinal,
    name: fields.name,
    operationId: fields.operationId,
    policy: fields.policy,
    inputDigest: fields.inputDigest,
  }) as Event;

export const elizaBoundaryRecorded = (
  fields: TurnStamp & {
    readonly key: string;
    readonly kind: ElizaBoundaryKind;
    readonly ordinal: number;
  } & (
      | { readonly outcome: "returned"; readonly result: unknown }
      | { readonly outcome: "failed"; readonly error: string }
    ),
): Event =>
  ({
    type: "ElizaBoundaryRecorded",
    ...stamped(fields),
    key: fields.key,
    kind: fields.kind,
    ordinal: fields.ordinal,
    outcome: fields.outcome,
    ...(fields.outcome === "returned"
      ? { result: fields.result }
      : { error: fields.error }),
  }) as Event;

export const elizaReplayDiverged = (
  fields: TurnStamp & {
    readonly key: string;
    readonly expectedDigest: string;
    readonly actualDigest: string;
  },
): Event =>
  ({
    type: "ElizaReplayDiverged",
    ...stamped(fields),
    key: fields.key,
    expectedDigest: fields.expectedDigest,
    actualDigest: fields.actualDigest,
  }) as Event;

export const elizaThreadBound = (fields: {
  readonly owner: string;
  readonly agent: string;
  readonly at: number;
}): Event => ({ type: "ElizaThreadBound", ...fields }) as Event;

export const elizaTaskUpserted = (fields: {
  readonly taskId: string;
  readonly task: unknown;
  readonly turn?: string;
  readonly at: number;
}): Event =>
  ({
    type: "ElizaTaskUpserted",
    taskId: fields.taskId,
    task: fields.task,
    ...(fields.turn === undefined ? {} : { turn: fields.turn }),
    at: fields.at,
  }) as Event;

export const elizaTaskDeleted = (fields: {
  readonly taskId: string;
  readonly turn?: string;
  readonly at: number;
}): Event =>
  ({
    type: "ElizaTaskDeleted",
    taskId: fields.taskId,
    ...(fields.turn === undefined ? {} : { turn: fields.turn }),
    at: fields.at,
  }) as Event;

export const elizaTickRequested = (fields: {
  readonly id: string;
  readonly owner: string;
  readonly epoch?: number;
  readonly at: number;
}): Event =>
  ({
    type: "ElizaTickRequested",
    id: fields.id,
    owner: fields.owner,
    ...(fields.epoch === undefined || fields.epoch === 0
      ? {}
      : { epoch: fields.epoch }),
    at: fields.at,
  }) as Event;

export const elizaTickCompleted = (fields: {
  readonly tick: string;
  readonly executed: number;
  readonly at: number;
}): Event => ({ type: "ElizaTickCompleted", ...fields }) as Event;

export const elizaTickFailed = (fields: {
  readonly tick: string;
  readonly error: string;
  readonly at: number;
}): Event => ({ type: "ElizaTickFailed", ...fields }) as Event;

const field = (event: Event, name: string): string =>
  String((event as Record<string, unknown>)[name] ?? "");

/**
 * Dedup keys for the adapter's own alphabet. A boundary is one occurrence per
 * key, a divergence is one per observed digest, and a thread binds once.
 */
export const elizaKeys: KeyFragment = {
  prefixes: ["ezs:", "ezr:", "ezd:", "ezb:", "ezk:"],
  keyOf: (event) => {
    switch (event.type) {
      case "ElizaBoundaryStarted":
        return `ezs:${field(event, "key")}`;
      case "ElizaBoundaryRecorded":
        return `ezr:${field(event, "key")}`;
      case "ElizaReplayDiverged":
        return `ezd:${field(event, "key")}/${field(event, "actualDigest")}`;
      case "ElizaThreadBound":
        return "ezb:owner";
      case "ElizaTickCompleted":
      case "ElizaTickFailed":
        return `ezk:${field(event, "tick")}`;
      default:
        return undefined;
    }
  },
};
