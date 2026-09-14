/**
 * Scheduled work with nobody calling in. The actor runs one turn on a real
 * Bun host — SQLite threads and the host's own alarm scheduler — and from
 * then on nothing external touches it: the tick that follows the turn arms a
 * wake whose deadline is the task's due time, the host's alarm fires at that
 * instant, the timeout lands in the thread's own log, the next tick runs
 * core's TaskService, and the registered worker executes. The worker firing
 * is the observable that matters; the event order is how it happened.
 *
 * The in-memory host has no alarms, so this is the Bun host deliberately.
 */

import { describe, expect, test } from "bun:test";
import type { Character } from "@elizaos/core/edge";
import { Effect, Layer } from "effect";
import { Infer } from "tardie/agent";
import { createBunHost, hostBackend } from "tardie/bun/create-host";
import { ElizaOwner } from "../src/hosts/identity";
import { elizaNativeActor } from "../src/native/actor";
import { nativeOwnerBuild } from "../src/native/owner";
import { dueSummaryOf } from "../src/native/tasks";
import { bunOwnerRegistry } from "../src/owner/bun";
import { OwnerRuntimePort } from "../src/owner/port";
import { testStorageDir } from "./support";

const character: Character = {
  name: "Eliza",
  bio: ["reminds"],
  system: "Be brief.",
};

const scriptedInfer = {
  resolve: () => ({ model: { provider: "test", model_id: "scripted" } }),
  react: () => Effect.sync(() => ({ kind: "complete" as const, output: "ok" })),
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the actor wakes itself", () => {
  test("a task due in the future runs with no external caller, and the cycle re-arms", async () => {
    const root = testStorageDir("native-scheduling");
    const registry = bunOwnerRegistry({
      dir: `${root}/owners`,
      build: nativeOwnerBuild({ agentKey: "eliza-scheduling", character }),
    });
    const actor = elizaNativeActor({ character });
    const host = await createBunHost({
      actor: actor as never,
      storage: `${root}/threads`,
      layersFor: (_thread: string, instance: string) =>
        Layer.mergeAll(
          Layer.succeed(Infer, scriptedInfer as never),
          Layer.succeed(ElizaOwner, { owner: instance, scoped: false }),
          Layer.succeed(OwnerRuntimePort, registry.portFor(instance)),
        ) as never,
    } as never);
    let fired = 0;
    try {
      const runtime = await registry.forOwner("alice").runtime();
      runtime.registerTaskWorker({
        name: "REMIND_OWNER",
        execute: async () => {
          fired += 1;
        },
      });
      await runtime.createTask({
        agentId: runtime.agentId,
        name: "REMIND_OWNER",
        description: "remind the owner",
        tags: ["queue", "repeat"],
        // Due about two seconds from now, then every four; the margins are
        // wide enough that a loaded machine does not change the outcome.
        metadata: { updatedAt: Date.now() - 2_000, updateInterval: 4_000 },
      });

      const client = host as unknown as {
        allocateRootThread: (options: {
          name: string;
          instance: string;
        }) => Promise<{
          coordinate: { instance: string; thread: string };
          methods: Record<
            string,
            (input: unknown, options: unknown) => Promise<unknown>
          >;
        }>;
      };
      const thread = await client.allocateRootThread({
        name: "alice",
        instance: "alice",
      });
      await thread.methods.message?.(
        { text: "hello" },
        { key: "turn-1", timeoutMs: 60_000 },
      );

      const backend = hostBackend(host);
      const read = async (): Promise<Array<Record<string, unknown>>> => [
        ...((await (
          await backend.ensure(thread.coordinate.instance)
        ).read(thread.coordinate.thread)) as ReadonlyArray<
          Record<string, unknown>
        >),
      ];

      // Nothing below calls the actor: the only thing that happens is waiting.
      const deadline = Date.now() + 30_000;
      let events = await read();
      while (fired === 0 && Date.now() < deadline) {
        await wait(500);
        events = await read();
      }
      expect(fired).toBeGreaterThanOrEqual(1);

      const types = events.map((event) => String(event.type));
      expect(types).toContain("ElizaWakeArmed");
      expect(types).toContain("CallDispatched");
      expect(types).toContain("AlarmFired");
      expect(types).toContain("CallTimedOut");

      // Every alarm the host fired was armed for one of the wake deadlines:
      // the actor's own pending call is the only thing that scheduled it.
      const deadlines = new Set(
        events
          .filter((event) => event.type === "ElizaWakeArmed")
          .map(
            (event) =>
              (event.call as { deadlineAt?: number } | undefined)?.deadlineAt,
          ),
      );
      expect(deadlines.size).toBeGreaterThanOrEqual(1);
      for (const deadline of deadlines) expect(typeof deadline).toBe("number");
      const alarms = events.filter((event) => event.type === "AlarmFired");
      expect(alarms.length).toBeGreaterThanOrEqual(1);
      for (const alarm of alarms) {
        expect(deadlines.has(alarm.scheduledFor as number)).toBe(true);
      }

      // The wake was dispatched before the alarm, and the tick came after it.
      expect(types.indexOf("CallDispatched")).toBeLessThan(
        types.indexOf("AlarmFired"),
      );
      expect(types.lastIndexOf("ElizaTickCompleted")).toBeGreaterThan(
        types.indexOf("CallTimedOut"),
      );

      // One turn happened; every later tick was the actor waking itself.
      expect(types.filter((type) => type === "MessageReceived")).toHaveLength(
        1,
      );
      const ticks = events.filter(
        (event) => event.type === "ElizaTickCompleted",
      ) as Array<Record<string, unknown>>;
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.some((tick) => Number(tick.executed ?? 0) >= 1)).toBe(true);

      // And it is still armed for the next one rather than having stopped.
      expect(
        types.filter((type) => type === "ElizaWakeArmed").length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await host.close();
      await registry.close();
    }
  }, 90_000);
});

describe("when the queue next needs attention", () => {
  const now = 1_000_000;

  test("repeating and one-shot tasks are read by core's own rules", () => {
    expect(
      dueSummaryOf(
        [
          {
            tags: ["queue", "repeat"],
            metadata: { updatedAt: now - 1_000, updateInterval: 5_000 },
          },
        ],
        now,
      ),
    ).toEqual({ nextDueAt: now + 4_000, dueNow: 0 });

    expect(dueSummaryOf([{ tags: ["queue"], dueAt: now + 250 }], now)).toEqual({
      nextDueAt: now + 250,
      dueNow: 0,
    });

    expect(
      dueSummaryOf(
        [{ tags: ["queue"], metadata: { scheduledAt: now - 10 } }],
        now,
      ),
    ).toEqual({ nextDueAt: null, dueNow: 1 });

    // A one-shot with no due time runs at the next tick.
    expect(dueSummaryOf([{ tags: ["queue"] }], now)).toEqual({
      nextDueAt: null,
      dueNow: 1,
    });
  });

  test("paused rows and incomplete repeats are not scheduled", () => {
    expect(
      dueSummaryOf(
        [{ tags: ["queue"], dueAt: now + 5, metadata: { paused: true } }],
        now,
      ),
    ).toEqual({ nextDueAt: null, dueNow: 0 });
    expect(
      dueSummaryOf(
        [{ tags: ["queue", "repeat"], metadata: { updatedAt: now } }],
        now,
      ),
    ).toEqual({ nextDueAt: null, dueNow: 0 });
    expect(dueSummaryOf([], now)).toEqual({ nextDueAt: null, dueNow: 0 });
  });

  test("the earliest future time wins, and past ones are counted instead", () => {
    expect(
      dueSummaryOf(
        [
          { tags: ["queue"], dueAt: now + 9_000 },
          { tags: ["queue"], dueAt: now + 300 },
          { tags: ["queue"], dueAt: now - 1 },
          { tags: ["queue"], dueAt: now - 5_000 },
        ],
        now,
      ),
    ).toEqual({ nextDueAt: now + 300, dueNow: 2 });
  });
});
