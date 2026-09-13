/**
 * Effect journal for one Eliza turn: the pure projection of boundary events
 * out of the thread log, and the recorder that consults it before running any
 * external effect. The recorder is the only place a model call, action, or
 * delivery may execute; it appends `ElizaBoundaryStarted` before and
 * `ElizaBoundaryRecorded` after through the host's durable append, so a crash
 * between the two leaves an explicit unknown outcome rather than a silent
 * duplicate on retry.
 *
 * Ordinals are assigned per kind in call order, which is deterministic for a
 * pipeline whose recorded boundaries replay identically. The pipeline always
 * receives the JSON-roundtripped value, live or replayed, so both paths
 * observe the same representation.
 */

import { ElizaError, stableStringify } from "@elizaos/core/edge";
import type { Event } from "tardie/core/event";
import {
  type ElizaBoundaryKind,
  type ElizaEffectPolicy,
  elizaBoundaryKey,
  elizaBoundaryRecorded,
  elizaBoundaryStarted,
  elizaReplayDiverged,
} from "./events";

export type BoundaryOutcome =
  | { readonly status: "returned"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: string };

export interface BoundaryRecord {
  readonly key: string;
  readonly kind: ElizaBoundaryKind;
  readonly ordinal: number;
  readonly name: string;
  readonly operationId: string;
  readonly policy: ElizaEffectPolicy;
  readonly inputDigest: string;
  readonly outcome?: BoundaryOutcome;
}

export interface ReplayDivergence {
  readonly key: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

export interface TurnJournal {
  readonly turn: string;
  readonly epoch: number;
  readonly boundaries: ReadonlyMap<string, BoundaryRecord>;
  readonly diverged: ReadonlyArray<ReplayDivergence>;
}

export interface JournalState {
  readonly turns: ReadonlyMap<string, TurnJournal>;
}

const turnSlot = (turn: string, epoch: number): string => `${turn}/${epoch}`;

const eventEpoch = (event: Record<string, unknown>): number => {
  const epoch = event.epoch;
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
    ? epoch
    : 0;
};

const emptyJournal = (turn: string, epoch: number): TurnJournal => ({
  turn,
  epoch,
  boundaries: new Map(),
  diverged: [],
});

export const initialJournal = (): JournalState => ({ turns: new Map() });

const withTurn = (
  state: JournalState,
  turn: string,
  epoch: number,
  update: (journal: TurnJournal) => TurnJournal,
): JournalState => {
  const slot = turnSlot(turn, epoch);
  const next = new Map(state.turns);
  next.set(slot, update(state.turns.get(slot) ?? emptyJournal(turn, epoch)));
  return { turns: next };
};

/** Pure step: folds one durable event into the journal state. */
export const reduceJournal = (
  state: JournalState,
  event: Event,
): JournalState => {
  const record = event as Record<string, unknown>;
  switch (event.type) {
    case "ElizaBoundaryStarted": {
      const turn = String(record.turn);
      return withTurn(state, turn, eventEpoch(record), (journal) => {
        const key = String(record.key);
        if (journal.boundaries.has(key)) return journal;
        const boundaries = new Map(journal.boundaries);
        boundaries.set(key, {
          key,
          kind: record.kind as ElizaBoundaryKind,
          ordinal: Number(record.ordinal),
          name: String(record.name),
          operationId: String(record.operationId),
          policy: record.policy as ElizaEffectPolicy,
          inputDigest: String(record.inputDigest),
        });
        return { ...journal, boundaries };
      });
    }
    case "ElizaBoundaryRecorded": {
      const turn = String(record.turn);
      return withTurn(state, turn, eventEpoch(record), (journal) => {
        const key = String(record.key);
        const existing = journal.boundaries.get(key);
        if (existing?.outcome !== undefined) return journal;
        const outcome: BoundaryOutcome =
          record.outcome === "failed"
            ? {
                status: "failed",
                error: String(record.error ?? "boundary failed"),
              }
            : { status: "returned", result: record.result };
        const boundaries = new Map(journal.boundaries);
        boundaries.set(key, {
          key,
          kind: (existing?.kind ?? record.kind) as ElizaBoundaryKind,
          ordinal: existing?.ordinal ?? Number(record.ordinal),
          name: existing?.name ?? "",
          operationId: existing?.operationId ?? "",
          policy: existing?.policy ?? "unsafe",
          inputDigest: existing?.inputDigest ?? "",
          outcome,
        });
        return { ...journal, boundaries };
      });
    }
    case "ElizaReplayDiverged": {
      const turn = String(record.turn);
      return withTurn(state, turn, eventEpoch(record), (journal) => ({
        ...journal,
        diverged: [
          ...journal.diverged,
          {
            key: String(record.key),
            expectedDigest: String(record.expectedDigest),
            actualDigest: String(record.actualDigest),
          },
        ],
      }));
    }
    default:
      return state;
  }
};

export const journalOf = (
  state: JournalState,
  turn: string,
  epoch: number,
): TurnJournal =>
  state.turns.get(turnSlot(turn, epoch)) ?? emptyJournal(turn, epoch);

/** Replays a complete log into one turn's journal. */
export const journalFromLog = (
  log: ReadonlyArray<Event>,
  turn: string,
  epoch: number,
): TurnJournal =>
  journalOf(log.reduce(reduceJournal, initialJournal()), turn, epoch);

const encoder = new TextEncoder();

/** SHA-256 over the canonical JSON form of a value, as lowercase hex. */
export async function digestValue(value: unknown): Promise<string> {
  const bytes = encoder.encode(stableStringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The JSON representation every boundary result is stored and replayed as. */
export function roundtripJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface BoundaryExecutionContext {
  readonly key: string;
  readonly operationId: string;
  readonly ordinal: number;
  /** `retry` marks an execution after a crash left the outcome unknown. */
  readonly attempt: "first" | "retry";
}

export interface BoundaryRequest<T> {
  readonly kind: ElizaBoundaryKind;
  readonly name: string;
  readonly policy: ElizaEffectPolicy;
  readonly input: unknown;
  readonly execute: (context: BoundaryExecutionContext) => Promise<T>;
}

export interface BoundaryRecorderOptions {
  readonly turn: string;
  readonly epoch: number;
  readonly journal: TurnJournal;
  readonly append: (events: ReadonlyArray<Event>) => Promise<void>;
  readonly now: () => number;
  readonly onDiverged?: (divergence: ReplayDivergence) => void;
}

export interface BoundaryRecorderStats {
  readonly executed: number;
  readonly replayed: number;
  readonly retried: number;
  readonly failed: number;
}

export interface BoundaryFailure {
  readonly key: string;
  readonly kind: ElizaBoundaryKind;
  readonly name: string;
  readonly error: string;
}

export interface BoundaryRecorder {
  record<T>(request: BoundaryRequest<T>): Promise<T>;
  stats(): BoundaryRecorderStats;
  ordinals(): Readonly<Record<ElizaBoundaryKind, number>>;
  /** Boundaries that ended in failure this attempt, live or replayed. */
  failures(): ReadonlyArray<BoundaryFailure>;
}

export const TARDIGRADE_EFFECT_OUTCOME_UNKNOWN =
  "TARDIGRADE_EFFECT_OUTCOME_UNKNOWN";

export function createBoundaryRecorder(
  options: BoundaryRecorderOptions,
): BoundaryRecorder {
  const counters: Record<ElizaBoundaryKind, number> = {
    model: 0,
    action: 0,
    delivery: 0,
    task: 0,
  };
  let executed = 0;
  let replayed = 0;
  let retried = 0;
  let failed = 0;
  const failures: BoundaryFailure[] = [];
  const stamp = () => ({
    turn: options.turn,
    epoch: options.epoch,
    at: options.now(),
  });

  const replay = <T>(record: BoundaryRecord): T => {
    replayed += 1;
    const outcome = record.outcome;
    if (outcome === undefined) {
      throw new ElizaError("Boundary replay requires a recorded outcome", {
        code: "TARDIGRADE_BOUNDARY_RECORD_INCOMPLETE",
        context: { key: record.key },
      });
    }
    if (outcome.status === "failed") {
      failed += 1;
      failures.push({
        key: record.key,
        kind: record.kind,
        name: record.name,
        error: outcome.error,
      });
      throw new Error(outcome.error);
    }
    return outcome.result as T;
  };

  const execute = async <T>(
    request: BoundaryRequest<T>,
    key: string,
    ordinal: number,
    operationId: string,
    attempt: "first" | "retry",
  ): Promise<T> => {
    executed += 1;
    if (attempt === "retry") retried += 1;
    let result: T;
    try {
      result = await request.execute({ key, operationId, ordinal, attempt });
    } catch (error) {
      // error-policy:J2 the boundary records the failure as its durable
      // outcome so a replay rethrows the same error instead of re-running,
      // then rethrows for the pipeline's own failure path.
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      failures.push({
        key,
        kind: request.kind,
        name: request.name,
        error: message,
      });
      await options.append([
        elizaBoundaryRecorded({
          ...stamp(),
          key,
          kind: request.kind,
          ordinal,
          outcome: "failed",
          error: message,
        }),
      ]);
      throw error;
    }
    const stored = roundtripJson(result);
    await options.append([
      elizaBoundaryRecorded({
        ...stamp(),
        key,
        kind: request.kind,
        ordinal,
        outcome: "returned",
        result: stored,
      }),
    ]);
    return stored;
  };

  return {
    async record<T>(request: BoundaryRequest<T>): Promise<T> {
      const ordinal = counters[request.kind];
      counters[request.kind] = ordinal + 1;
      const key = elizaBoundaryKey(
        options.turn,
        options.epoch,
        request.kind,
        ordinal,
      );
      const operationId = `eliza:${key}`;
      const inputDigest = await digestValue(request.input);
      const known = options.journal.boundaries.get(key);
      if (known?.outcome !== undefined) {
        if (known.inputDigest !== inputDigest) {
          const divergence = {
            key,
            expectedDigest: known.inputDigest,
            actualDigest: inputDigest,
          };
          await options.append([
            elizaReplayDiverged({ ...stamp(), ...divergence }),
          ]);
          options.onDiverged?.(divergence);
        }
        return replay<T>(known);
      }
      if (known !== undefined) {
        if (request.policy === "unsafe") {
          throw new ElizaError(
            `Tardigrade boundary ${key} (${request.name}) started but its outcome was never recorded; the effect is not declared retry-safe`,
            {
              code: TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
              context: {
                key,
                kind: request.kind,
                name: request.name,
                operationId: known.operationId,
                policy: request.policy,
              },
            },
          );
        }
        return execute(request, key, ordinal, known.operationId, "retry");
      }
      await options.append([
        elizaBoundaryStarted({
          ...stamp(),
          key,
          kind: request.kind,
          ordinal,
          name: request.name,
          operationId,
          policy: request.policy,
          inputDigest,
        }),
      ]);
      return execute(request, key, ordinal, operationId, "first");
    },
    stats: () => ({ executed, replayed, retried, failed }),
    failures: () => [...failures],
    ordinals: () => ({ ...counters }),
  };
}
