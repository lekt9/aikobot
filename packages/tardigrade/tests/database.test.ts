/**
 * Durable owner adapter contracts: the real edge AgentRuntime writes
 * entities, rooms, memories, and tasks through the adapter; a snapshot
 * persisted to the owner backend restores them into a fresh adapter; owners
 * never share a backend; large documents chunk and incomplete chunks refuse
 * to load; schema drift fails closed. Deterministic, no model, no host.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AgentRuntime,
  type Character,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core/edge";
import {
  CHUNK_SIZE,
  chunkedSqlBackend,
  memoryBackend,
  type SqlRunner,
} from "../src/owner/backend";
import {
  DurableElizaDatabaseAdapter,
  OWNER_ADAPTER_KEY,
  TARDIGRADE_STATE_SCHEMA,
} from "../src/owner/durable-adapter";
import { sqliteBackend } from "../src/owner/sqlite-backend";
import { testStorageDir } from "./support";

const AGENT = stringToUuid("durable-adapter-agent") as UUID;
const OTHER_AGENT = stringToUuid("another-agent") as UUID;
const character: Character = {
  name: "Durable",
  bio: ["persists"],
  system: "You persist.",
};

async function runtimeOver(adapter: DurableElizaDatabaseAdapter) {
  const runtime = new AgentRuntime({
    agentId: AGENT,
    character,
    adapter,
    plugins: [],
    logLevel: "error",
    disableBasicCapabilities: true,
    enableAutonomy: false,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
  });
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

const roomId = stringToUuid("room-1") as UUID;
const worldId = stringToUuid("world-1") as UUID;
const entityId = stringToUuid("alice") as UUID;

async function seed(adapter: DurableElizaDatabaseAdapter) {
  const runtime = await runtimeOver(adapter);
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "alice",
    name: "Alice",
    source: "test",
    channelId: "room-1",
    type: "DM" as never,
    worldName: "World",
  });
  const memory: Memory = {
    id: stringToUuid("memory-1") as UUID,
    entityId,
    agentId: AGENT,
    roomId,
    content: { text: "the sky is blue" },
    createdAt: 1_700_000_000_000,
  };
  await runtime.createMemory(memory, "messages");
  await runtime.createTask({
    agentId: AGENT,
    name: "remind",
    description: "remind alice",
    tags: ["queue"],
    metadata: { updatedAt: 1_700_000_000_000 },
    roomId,
  });
  await runtime.stop();
}

describe("durable adapter", () => {
  test("a snapshot restores entities, rooms, memories, and tasks into a fresh adapter", async () => {
    const backend = memoryBackend();
    const first = DurableElizaDatabaseAdapter.open({ agentId: AGENT, backend });
    await seed(first);
    expect(first.persistedFields()).toEqual(
      expect.arrayContaining([
        "entities",
        "memoriesById",
        "memoriesByRoom",
        "rooms",
        "tasks",
      ]),
    );
    first.persist();
    expect(backend.read(OWNER_ADAPTER_KEY)).toContain("the sky is blue");

    const second = DurableElizaDatabaseAdapter.open({
      agentId: AGENT,
      backend,
    });
    const runtime = await runtimeOver(second);
    const memories = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 10,
    });
    expect(memories.map((memory) => memory.content.text)).toEqual([
      "the sky is blue",
    ]);
    const tasks = await runtime.getTasks({ tags: ["queue"] });
    expect(tasks.map((task) => task.name)).toEqual(["remind"]);
    const [entity] = await runtime.getEntitiesByIds([entityId]);
    expect(entity?.names).toContain("Alice");
    expect(await runtime.getRoom(roomId)).toMatchObject({
      id: roomId,
      worldId,
    });
    await runtime.stop();
  });

  test("owners have separate backends, so one owner's snapshot never reaches another", async () => {
    const alice = memoryBackend();
    const bob = memoryBackend();
    const adapter = DurableElizaDatabaseAdapter.open({
      agentId: AGENT,
      backend: alice,
    });
    await seed(adapter);
    adapter.persist();
    const bobsAdapter = DurableElizaDatabaseAdapter.open({
      agentId: AGENT,
      backend: bob,
    });
    const runtime = await runtimeOver(bobsAdapter);
    expect(
      await runtime.getMemories({ roomId, tableName: "messages", count: 10 }),
    ).toEqual([]);
    expect(bob.keys("/")).toEqual([]);
    await runtime.stop();
  });

  test("schema drift and foreign agents refuse to load instead of dropping state", () => {
    const backend = memoryBackend();
    const adapter = DurableElizaDatabaseAdapter.open({
      agentId: AGENT,
      backend,
    });
    adapter.persist();
    const stored = JSON.parse(backend.read(OWNER_ADAPTER_KEY) as string);
    backend.write(
      OWNER_ADAPTER_KEY,
      JSON.stringify({
        ...stored,
        fields: { ...stored.fields, ledgers: { $map: [] } },
      }),
    );
    expect(() =>
      DurableElizaDatabaseAdapter.open({ agentId: AGENT, backend }),
    ).toThrow(expect.objectContaining({ code: TARDIGRADE_STATE_SCHEMA }));
    backend.write(
      OWNER_ADAPTER_KEY,
      JSON.stringify({
        ...stored,
        fields: { ...stored.fields, rooms: { $set: [] } },
      }),
    );
    expect(() =>
      DurableElizaDatabaseAdapter.open({ agentId: AGENT, backend }),
    ).toThrow(expect.objectContaining({ code: TARDIGRADE_STATE_SCHEMA }));
    backend.write(OWNER_ADAPTER_KEY, JSON.stringify(stored));
    expect(() =>
      DurableElizaDatabaseAdapter.open({ agentId: OTHER_AGENT, backend }),
    ).toThrow(expect.objectContaining({ code: TARDIGRADE_STATE_SCHEMA }));
  });
});

describe("chunked SQL backend", () => {
  test("large documents chunk on bun:sqlite and survive reopening the file", () => {
    const path = join(testStorageDir("owner-backend"), "alice.sqlite");
    const backend = sqliteBackend(path);
    const big = "x".repeat(CHUNK_SIZE * 2 + 17);
    backend.write("/eliza/big.json", big);
    backend.write("/eliza/small.json", "{}");
    expect(backend.keys("/eliza/")).toEqual([
      "/eliza/big.json",
      "/eliza/small.json",
    ]);
    backend.close();
    const reopened = sqliteBackend(path);
    expect(reopened.read("/eliza/big.json")).toBe(big);
    reopened.delete("/eliza/big.json");
    expect(reopened.read("/eliza/big.json")).toBeUndefined();
    expect(reopened.keys("/eliza/")).toEqual(["/eliza/small.json"]);
    reopened.close();
  });

  test("a document with missing chunks is an error, never a truncated value", () => {
    const rows = new Map<string, Map<number, string>>();
    const manifests = new Map<string, number>();
    const runner: SqlRunner = {
      run: (query, ...values) => {
        if (query.startsWith("CREATE")) return;
        if (query.startsWith("DELETE FROM eliza_chunks"))
          rows.delete(String(values[0]));
        else if (query.startsWith("DELETE FROM eliza_state"))
          manifests.delete(String(values[0]));
        else if (query.startsWith("INSERT INTO eliza_chunks")) {
          const parts =
            rows.get(String(values[0])) ?? new Map<number, string>();
          parts.set(Number(values[1]), String(values[2]));
          rows.set(String(values[0]), parts);
        } else if (query.startsWith("INSERT INTO eliza_state")) {
          manifests.set(String(values[0]), Number(values[1]));
        }
      },
      rows: <T>(query: string, ...values: ReadonlyArray<string | number>) => {
        if (query.startsWith("SELECT parts")) {
          const parts = manifests.get(String(values[0]));
          return (parts === undefined ? [] : [{ parts }]) as T[];
        }
        if (query.startsWith("SELECT value")) {
          const parts =
            rows.get(String(values[0])) ?? new Map<number, string>();
          return [...parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => ({ value })) as T[];
        }
        return [...manifests.keys()]
          .filter((key) => key.startsWith(String(values[1])))
          .sort()
          .map((key) => ({ key })) as T[];
      },
      transaction: (operation) => operation(),
    };
    const backend = chunkedSqlBackend(runner);
    backend.write("/doc", "y".repeat(CHUNK_SIZE + 1));
    expect(backend.read("/doc")).toHaveLength(CHUNK_SIZE + 1);
    rows.get("/doc")?.delete(1);
    expect(() => backend.read("/doc")).toThrow(/incomplete/u);
  });
});
