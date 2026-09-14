/**
 * Owner runtime contracts: keyed invocations with started/complete receipts
 * over the real edge AgentRuntime and durable adapter — replay from a
 * receipt, key reuse refused, uncertain outcomes refused for unsafe work and
 * retried for reads — plus the Bun registry reopening an owner's SQLite
 * file and the thread-side port routing to the owner's object. No model,
 * no host process; the registry test uses a real SQLite file.
 */

import { describe, expect, test } from "bun:test";
import {
  type Character,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core/edge";
import { Effect } from "effect";
import { TARDIGRADE_EFFECT_OUTCOME_UNKNOWN } from "../src/journal";
import { memoryBackend } from "../src/owner/backend";
import { bunOwnerRegistry } from "../src/owner/bun";
import {
  type OwnerInvocation,
  ownerObjectPort,
  TARDIGRADE_INVOCATION_FAILED,
  TARDIGRADE_INVOCATION_KEY_REUSED,
  TARDIGRADE_INVOCATION_UNKNOWN_KIND,
} from "../src/owner/port";
import {
  createOwnerRuntime,
  type OwnerExecutor,
  type OwnerRuntimeOptions,
} from "../src/owner/runtime";
import { testStorageDir } from "./support";

const AGENT = stringToUuid("owner-runtime-agent") as UUID;
const roomId = stringToUuid("owner-room") as UUID;
const character: Character = {
  name: "Owner",
  bio: ["keeps state"],
  system: "Keep state.",
};

const executors: Record<string, OwnerExecutor> = {
  note: {
    policy: "unsafe",
    run: async ({ runtime, invocation }) => {
      const text = String((invocation.payload as { text: string }).text);
      const memory: Memory = {
        id: stringToUuid(`${invocation.key}/memory`) as UUID,
        entityId: stringToUuid(invocation.thread) as UUID,
        agentId: AGENT,
        roomId,
        content: { text },
        createdAt: 1_700_000_000_000,
      };
      await runtime.createMemory(memory, "messages");
      const count = (
        await runtime.getMemories({ roomId, tableName: "messages", count: 100 })
      ).length;
      return { result: { count }, events: [{ type: "Noted", text } as never] };
    },
  },
  count: {
    policy: "read",
    run: async ({ runtime }) => ({
      result: (
        await runtime.getMemories({ roomId, tableName: "messages", count: 100 })
      ).map((memory) => memory.content.text),
    }),
  },
  boom: {
    policy: "unsafe",
    run: async () => {
      throw new Error("the effect may or may not have happened");
    },
  },
  flaky: {
    policy: "read",
    run: (() => {
      let attempts = 0;
      return async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { result: { attempts } };
      };
    })(),
  },
};

const build = (): Omit<OwnerRuntimeOptions, "owner" | "backend"> => ({
  agentId: AGENT,
  character,
  plugins: [],
  executors,
  now: () => 1_700_000_000_000,
  basicCapabilities: false,
});

const invocation = (
  key: string,
  kind: string,
  payload: unknown = {},
): OwnerInvocation => ({
  key,
  kind,
  name: kind,
  thread: "thread-1",
  turn: "turn-1",
  payload,
});

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

describe("owner runtime receipts", () => {
  test("a repeated key replays the recorded output without running again", async () => {
    const backend = memoryBackend();
    const owner = createOwnerRuntime({ ...build(), owner: "alice", backend });
    const first = await owner.invoke(invocation("k1", "note", { text: "sky" }));
    expect(first).toEqual({
      result: { count: 1 },
      events: [{ type: "Noted", text: "sky" }],
      replayed: false,
    });
    const again = await owner.invoke(invocation("k1", "note", { text: "sky" }));
    expect(again).toEqual({ ...first, replayed: true });
    const listed = await owner.invoke(invocation("k2", "count"));
    expect(listed.result).toEqual(["sky"]);
    expect(owner.receipt("k1")?.state).toBe("complete");
    await owner.close();
  });

  test("a reused key with another payload and an unknown kind are refused", async () => {
    const owner = createOwnerRuntime({
      ...build(),
      owner: "alice",
      backend: memoryBackend(),
    });
    await owner.invoke(invocation("k1", "note", { text: "sky" }));
    expect(
      await codeOf(owner.invoke(invocation("k1", "note", { text: "sea" }))),
    ).toBe(TARDIGRADE_INVOCATION_KEY_REUSED);
    expect(await codeOf(owner.invoke(invocation("k3", "nope")))).toBe(
      TARDIGRADE_INVOCATION_UNKNOWN_KIND,
    );
    await owner.close();
  });

  test("an unsafe failure keeps its started receipt and refuses automatic replay; a read retries", async () => {
    const owner = createOwnerRuntime({
      ...build(),
      owner: "alice",
      backend: memoryBackend(),
    });
    expect(await codeOf(owner.invoke(invocation("k4", "boom")))).toBe(
      TARDIGRADE_INVOCATION_FAILED,
    );
    expect(owner.receipt("k4")?.state).toBe("started");
    expect(await codeOf(owner.invoke(invocation("k4", "boom")))).toBe(
      TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
    );
    expect(await codeOf(owner.invoke(invocation("k5", "flaky")))).toBe(
      TARDIGRADE_INVOCATION_FAILED,
    );
    expect(owner.receipt("k5")).toBeUndefined();
    const retried = await owner.invoke(invocation("k5", "flaky"));
    expect(retried.result).toEqual({ attempts: 2 });
    await owner.close();
  });

  test("invocations serialize per owner in arrival order", async () => {
    const owner = createOwnerRuntime({
      ...build(),
      owner: "alice",
      backend: memoryBackend(),
    });
    const results = await Promise.all([
      owner.invoke(invocation("s1", "note", { text: "one" })),
      owner.invoke(invocation("s2", "note", { text: "two" })),
      owner.invoke(invocation("s3", "count")),
    ]);
    expect(results.slice(0, 2).map((result) => result.result)).toEqual([
      { count: 1 },
      { count: 2 },
    ]);
    const listed = results[2]?.result as string[] | undefined;
    expect([...(listed ?? [])].sort()).toEqual(["one", "two"]);
    await owner.close();
  });
});

describe("Bun owner registry", () => {
  test("an owner's memory survives closing and reopening the registry, and owners are isolated", async () => {
    const dir = testStorageDir("owner-registry");
    const registry = bunOwnerRegistry({ dir, build });
    await Effect.runPromise(
      registry
        .portFor("alice")
        .invoke(invocation("r1", "note", { text: "persisted" })),
    );
    await registry.close();

    const reopened = bunOwnerRegistry({ dir, build });
    const alice = await Effect.runPromise(
      reopened.portFor("alice").invoke(invocation("r2", "count")),
    );
    expect(alice.result).toEqual(["persisted"]);
    const replayed = await Effect.runPromise(
      reopened
        .portFor("alice")
        .invoke(invocation("r1", "note", { text: "persisted" })),
    );
    expect(replayed.replayed).toBe(true);
    const bob = await Effect.runPromise(
      reopened.portFor("bob").invoke(invocation("r1", "count")),
    );
    expect(bob.result).toEqual([]);
    expect(reopened.pathFor("alice")).not.toBe(reopened.pathFor("bob"));
    await reopened.close();
  });
});

describe("owner object port", () => {
  test("routes each invocation to the owner's own object and refuses a foreign owner id", async () => {
    const calls: Array<{ name: string; owner: string; key: string }> = [];
    const namespace = {
      getByName: (name: string) => ({
        invoke: async (owner: string, request: OwnerInvocation) => {
          if (owner !== name) throw new Error("foreign owner refused");
          calls.push({ name, owner, key: request.key });
          return { result: name, events: [], replayed: false };
        },
      }),
    };
    const alice = ownerObjectPort(namespace, "alice");
    expect(
      await Effect.runPromise(alice.invoke(invocation("p1", "count"))),
    ).toMatchObject({ result: "alice" });
    expect(calls).toEqual([{ name: "alice", owner: "alice", key: "p1" }]);
    expect(() => ownerObjectPort(namespace, "../bob")).toThrow();
  });
});
