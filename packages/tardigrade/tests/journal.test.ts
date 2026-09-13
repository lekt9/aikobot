/**
 * Effect journal contract: pure projection of boundary events, keyed dedup,
 * and the recorder's execute/replay/unknown-outcome decisions. Deterministic;
 * the durable append is an in-memory array standing in for a thread log.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/edge";
import type { Event } from "tardie/core/event";
import {
  elizaBoundaryKey,
  elizaBoundaryRecorded,
  elizaBoundaryStarted,
  elizaKeys,
  elizaThreadBound,
} from "../src/events";
import {
  createBoundaryRecorder,
  digestValue,
  initialJournal,
  journalFromLog,
  reduceJournal,
  TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
} from "../src/journal";

const TURN = "turn-1";

function harness(log: Event[] = []) {
  const appended: Event[] = [];
  const recorder = createBoundaryRecorder({
    turn: TURN,
    epoch: 0,
    journal: journalFromLog(log, TURN, 0),
    append: async (events) => {
      appended.push(...events);
      log.push(...events);
    },
    now: () => 1_000,
  });
  return { recorder, appended, log };
}

describe("journal projection", () => {
  test("folds started and recorded boundaries into one record per key", () => {
    const key = elizaBoundaryKey(TURN, 0, "action", 0);
    const started = elizaBoundaryStarted({
      turn: TURN,
      at: 1,
      key,
      kind: "action",
      ordinal: 0,
      name: "TODO",
      operationId: `eliza:${key}`,
      policy: "idempotent",
      inputDigest: "abc",
    });
    const recorded = elizaBoundaryRecorded({
      turn: TURN,
      at: 2,
      key,
      kind: "action",
      ordinal: 0,
      outcome: "returned",
      result: { ok: true },
    });
    const duplicateStart = { ...started, inputDigest: "zzz" } as Event;
    const journal = journalFromLog(
      [started, duplicateStart, recorded],
      TURN,
      0,
    );
    const record = journal.boundaries.get(key);
    expect(record?.inputDigest).toBe("abc");
    expect(record?.operationId).toBe(`eliza:${key}`);
    expect(record?.outcome).toEqual({
      status: "returned",
      result: { ok: true },
    });
    expect(journalFromLog([started, recorded], TURN, 1).boundaries.size).toBe(
      0,
    );
  });

  test("ignores unrelated events and keeps epochs apart", () => {
    const key = elizaBoundaryKey(TURN, 1, "model", 0);
    const state = [
      elizaThreadBound({ owner: "o", agent: "a", at: 1 }),
      { type: "MessageReceived", id: TURN, text: "hi", at: 1 } as Event,
      elizaBoundaryRecorded({
        turn: TURN,
        epoch: 1,
        at: 3,
        key,
        kind: "model",
        ordinal: 0,
        outcome: "failed",
        error: "boom",
      }),
    ].reduce(reduceJournal, initialJournal());
    expect(state.turns.get(`${TURN}/0`)).toBeUndefined();
    expect(state.turns.get(`${TURN}/1`)?.boundaries.get(key)?.outcome).toEqual({
      status: "failed",
      error: "boom",
    });
  });

  test("derives stable dedup keys for the adapter alphabet", () => {
    const key = elizaBoundaryKey(TURN, 0, "delivery", 2);
    expect(
      elizaKeys.keyOf(
        elizaBoundaryStarted({
          turn: TURN,
          at: 1,
          key,
          kind: "delivery",
          ordinal: 2,
          name: "reply",
          operationId: "op",
          policy: "unsafe",
          inputDigest: "d",
        }),
      ),
    ).toBe(`ezs:${key}`);
    expect(
      elizaKeys.keyOf(
        elizaBoundaryRecorded({
          turn: TURN,
          at: 1,
          key,
          kind: "delivery",
          ordinal: 2,
          outcome: "returned",
          result: null,
        }),
      ),
    ).toBe(`ezr:${key}`);
    expect(
      elizaKeys.keyOf(elizaThreadBound({ owner: "o", agent: "a", at: 1 })),
    ).toBe("ezb:owner");
    expect(
      elizaKeys.keyOf({ type: "TurnCompleted", output: "x", at: 1 } as Event),
    ).toBeUndefined();
  });
});

describe("boundary recorder", () => {
  test("a fresh boundary records start before execution and the JSON result after", async () => {
    const { recorder, appended } = harness();
    const seen: string[] = [];
    const result = await recorder.record({
      kind: "action",
      name: "TODO",
      policy: "idempotent",
      input: { text: "buy milk" },
      execute: async (context) => {
        seen.push(context.operationId, context.attempt);
        expect(appended.map((event) => event.type)).toEqual([
          "ElizaBoundaryStarted",
        ]);
        return { when: new Date(0), nested: { ok: true } };
      },
    });
    expect(seen).toEqual([
      `eliza:${elizaBoundaryKey(TURN, 0, "action", 0)}`,
      "first",
    ]);
    expect(result as unknown).toEqual({
      when: "1970-01-01T00:00:00.000Z",
      nested: { ok: true },
    });
    expect(appended.map((event) => event.type)).toEqual([
      "ElizaBoundaryStarted",
      "ElizaBoundaryRecorded",
    ]);
    const started = appended[0] as Record<string, unknown>;
    expect(started.inputDigest).toBe(await digestValue({ text: "buy milk" }));
    expect(started.policy).toBe("idempotent");
    expect(recorder.stats()).toEqual({
      executed: 1,
      replayed: 0,
      retried: 0,
      failed: 0,
    });
  });

  test("a recorded boundary replays without executing and reports divergence", async () => {
    const first = harness();
    await first.recorder.record({
      kind: "model",
      name: "TEXT_LARGE",
      policy: "read",
      input: { prompt: "p1" },
      execute: async () => "answer",
    });
    const second = harness(first.log);
    let executed = 0;
    const divergences: string[] = [];
    const replayRecorder = createBoundaryRecorder({
      turn: TURN,
      epoch: 0,
      journal: journalFromLog(second.log, TURN, 0),
      append: async (events) => {
        second.appended.push(...events);
      },
      now: () => 2,
      onDiverged: (divergence) => divergences.push(divergence.key),
    });
    const replayed = await replayRecorder.record({
      kind: "model",
      name: "TEXT_LARGE",
      policy: "read",
      input: { prompt: "p1" },
      execute: async () => {
        executed += 1;
        return "never";
      },
    });
    expect(replayed).toBe("answer");
    expect(executed).toBe(0);
    expect(divergences).toEqual([]);
    expect(second.appended).toEqual([]);

    const divergent = createBoundaryRecorder({
      turn: TURN,
      epoch: 0,
      journal: journalFromLog(first.log, TURN, 0),
      append: async (events) => {
        second.appended.push(...events);
      },
      now: () => 3,
      onDiverged: (divergence) => divergences.push(divergence.key),
    });
    expect(
      await divergent.record({
        kind: "model",
        name: "TEXT_LARGE",
        policy: "read",
        input: { prompt: "p2" },
        execute: async () => {
          executed += 1;
          return "never";
        },
      }),
    ).toBe("answer");
    expect(executed).toBe(0);
    expect(divergences).toEqual([elizaBoundaryKey(TURN, 0, "model", 0)]);
    expect(second.appended.map((event) => event.type)).toEqual([
      "ElizaReplayDiverged",
    ]);
  });

  test("a recorded failure replays as the same thrown error", async () => {
    const first = harness();
    await expect(
      first.recorder.record({
        kind: "action",
        name: "WEB_SEARCH",
        policy: "read",
        input: 1,
        execute: async () => {
          throw new Error("upstream 503");
        },
      }),
    ).rejects.toThrow("upstream 503");
    expect(first.appended.map((event) => event.type)).toEqual([
      "ElizaBoundaryStarted",
      "ElizaBoundaryRecorded",
    ]);
    expect((first.appended[1] as Record<string, unknown>).outcome).toBe(
      "failed",
    );
    const replay = harness(first.log);
    let executed = 0;
    await expect(
      replay.recorder.record({
        kind: "action",
        name: "WEB_SEARCH",
        policy: "read",
        input: 1,
        execute: async () => {
          executed += 1;
          return "x";
        },
      }),
    ).rejects.toThrow("upstream 503");
    expect(executed).toBe(0);
  });

  test("an unknown outcome retries read and idempotent effects with the original operation id", async () => {
    for (const policy of ["read", "idempotent"] as const) {
      const key = elizaBoundaryKey(TURN, 0, "action", 0);
      const log: Event[] = [
        elizaBoundaryStarted({
          turn: TURN,
          at: 1,
          key,
          kind: "action",
          ordinal: 0,
          name: "TODO",
          operationId: "eliza:original",
          policy,
          inputDigest: "x",
        }),
      ];
      const { recorder, appended } = harness(log);
      const contexts: Array<{ attempt: string; operationId: string }> = [];
      const result = await recorder.record({
        kind: "action",
        name: "TODO",
        policy,
        input: "any",
        execute: async (context) => {
          contexts.push({
            attempt: context.attempt,
            operationId: context.operationId,
          });
          return 42;
        },
      });
      expect(result).toBe(42);
      expect(contexts).toEqual([
        { attempt: "retry", operationId: "eliza:original" },
      ]);
      expect(appended.map((event) => event.type)).toEqual([
        "ElizaBoundaryRecorded",
      ]);
      expect(recorder.stats()).toEqual({
        executed: 1,
        replayed: 0,
        retried: 1,
        failed: 0,
      });
    }
  });

  test("an unknown outcome of an unsafe effect fails the turn explicitly", async () => {
    const key = elizaBoundaryKey(TURN, 0, "delivery", 0);
    const { recorder, appended } = harness([
      elizaBoundaryStarted({
        turn: TURN,
        at: 1,
        key,
        kind: "delivery",
        ordinal: 0,
        name: "reply",
        operationId: "eliza:original",
        policy: "unsafe",
        inputDigest: "x",
      }),
    ]);
    let executed = 0;
    const failure = await recorder
      .record({
        kind: "delivery",
        name: "reply",
        policy: "unsafe",
        input: "hello",
        execute: async () => {
          executed += 1;
          return true;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(
      TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
    );
    expect((failure as ElizaError).context).toMatchObject({
      key,
      operationId: "eliza:original",
    });
    expect(executed).toBe(0);
    expect(appended).toEqual([]);
  });

  test("ordinals advance independently per kind", async () => {
    const { recorder } = harness();
    const keys: string[] = [];
    for (const kind of [
      "model",
      "action",
      "model",
      "delivery",
      "action",
    ] as const) {
      await recorder.record({
        kind,
        name: kind,
        policy: "read",
        input: null,
        execute: async (context) => {
          keys.push(context.key);
          return null;
        },
      });
    }
    expect(keys).toEqual([
      `${TURN}/0/model/0`,
      `${TURN}/0/action/0`,
      `${TURN}/0/model/1`,
      `${TURN}/0/delivery/0`,
      `${TURN}/0/action/1`,
    ]);
    expect(recorder.ordinals()).toEqual({
      model: 2,
      action: 2,
      delivery: 1,
      task: 0,
    });
  });
});
