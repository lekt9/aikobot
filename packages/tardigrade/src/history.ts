/**
 * Conversation history projected from the thread log. Each served
 * `MessageReceived` is one user turn and its `TurnCompleted` output is the
 * assistant turn; the projection is the complete record — no window, no
 * summary — and the turn runner seeds it verbatim into the ephemeral runtime
 * before handling the current message.
 */

import type { Event } from "tardie/core/event";

export interface TurnHistoryEntry {
  readonly turn: string;
  readonly text: string;
  readonly at: number;
  readonly sender?: string;
  readonly output?: string;
  readonly outputAt?: number;
}

export interface HistoryState {
  readonly order: ReadonlyArray<string>;
  readonly entries: ReadonlyMap<string, TurnHistoryEntry>;
}

export const initialHistory = (): HistoryState => ({
  order: [],
  entries: new Map(),
});

const numberField = (record: Record<string, unknown>, name: string): number => {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const senderOf = (record: Record<string, unknown>): string | undefined => {
  const input = record.input;
  if (!input || typeof input !== "object") return undefined;
  const sender = (input as Record<string, unknown>).sender;
  return typeof sender === "string" && sender ? sender : undefined;
};

/** Pure step: folds one durable event into the history projection. */
export const reduceHistory = (
  state: HistoryState,
  event: Event,
): HistoryState => {
  const record = event as Record<string, unknown>;
  if (event.type === "MessageReceived") {
    const turn = String(record.id ?? "");
    if (!turn || state.entries.has(turn)) return state;
    const entries = new Map(state.entries);
    const sender = senderOf(record);
    entries.set(turn, {
      turn,
      text: String(record.text ?? ""),
      at: numberField(record, "at"),
      ...(sender === undefined ? {} : { sender }),
    });
    return { order: [...state.order, turn], entries };
  }
  if (event.type === "TurnCompleted") {
    const turn = String(record.turn ?? "");
    const existing = state.entries.get(turn);
    if (!existing || existing.output !== undefined) return state;
    const entries = new Map(state.entries);
    entries.set(turn, {
      ...existing,
      output: String(record.output ?? ""),
      outputAt: numberField(record, "at"),
    });
    return { ...state, entries };
  }
  return state;
};

/** Every served turn before `turn`, in service order. */
export const historyBefore = (
  state: HistoryState,
  turn: string,
): ReadonlyArray<TurnHistoryEntry> => {
  const entries: TurnHistoryEntry[] = [];
  for (const id of state.order) {
    if (id === turn) break;
    const entry = state.entries.get(id);
    if (entry) entries.push(entry);
  }
  return entries;
};

export const historyFromLog = (log: ReadonlyArray<Event>): HistoryState =>
  log.reduce(reduceHistory, initialHistory());
