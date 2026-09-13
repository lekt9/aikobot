/**
 * Duplicate delivery proof on a real Bun host: the same call key delivered
 * twice (concurrently or after completion) runs one turn, a re-delivered
 * `MessageReceived` event is absorbed by the log's dedup key, and distinct
 * keys with identical text remain distinct turns.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { hostBackend } from "tardie/bun/create-host";
import { messageReceived } from "tardie/core/interaction/provider-message";
import { elizaActor } from "../src/actor";
import { createElizaBunHost, type ElizaBunHost } from "../src/hosts/bun";
import {
  recordingDeliveryPort,
  scriptedModelPort,
  testPlugins,
  testStorageDir,
} from "./support";

const opened: Array<{ host: ElizaBunHost; storage: string }> = [];

async function openHost() {
  const storage = testStorageDir("eliza-tardigrade-idem-");
  const model = scriptedModelPort({ replyText: "Once." });
  const delivery = recordingDeliveryPort();
  const host = await createElizaBunHost({
    actor: elizaActor({ name: "eliza-idem" }),
    storage,
    config: {
      agentKey: "eliza-idem",
      character: { name: "Tardiza", system: "You are Tardiza." },
      plugins: testPlugins().plugins,
      model,
      delivery,
      host: { bindings: [], secrets: [] },
    },
  });
  opened.push({ host, storage });
  return { host, model, delivery };
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.host.close();
    rmSync(entry.storage, { recursive: true, force: true });
  }
});

async function log(host: ElizaBunHost, instance: string, thread: string) {
  return [
    ...(await (await hostBackend(host).ensure(instance)).read(thread)),
  ] as Array<Record<string, unknown>>;
}

describe("duplicate inbound delivery", () => {
  test("the same call key delivered twice concurrently runs one turn", async () => {
    const { host, model, delivery } = await openHost();
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    const [first, second] = await Promise.all([
      thread.methods.message(
        { text: "hello", input: { owner: "owner-1" } },
        { key: "dup-1" },
      ),
      thread.methods.message(
        { text: "hello", input: { owner: "owner-1" } },
        { key: "dup-1" },
      ),
    ]);
    expect(first).toBe("Once.");
    expect(second).toBe("Once.");
    const events = await log(host, "owner-1", thread.coordinate.thread);
    expect(
      events.filter((event) => event.type === "MessageReceived"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "TurnCompleted"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "ElizaBoundaryStarted" && event.kind === "model",
      ),
    ).toHaveLength(model.calls);
    expect(delivery.deliveries).toHaveLength(1);
  });

  test("re-delivering a completed call returns the recorded result without a new turn", async () => {
    const { host, model, delivery } = await openHost();
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    const first = await thread.methods.message(
      { text: "hello", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    const callsAfterFirst = model.calls;
    const eventsAfterFirst = (
      await log(host, "owner-1", thread.coordinate.thread)
    ).length;
    const again = await thread.methods.message(
      {
        text: "a different text under the same key",
        input: { owner: "owner-1" },
      },
      { key: "call-1" },
    );
    expect(again).toBe(first);
    expect(model.calls).toBe(callsAfterFirst);
    expect(delivery.deliveries).toHaveLength(1);
    expect((await log(host, "owner-1", thread.coordinate.thread)).length).toBe(
      eventsAfterFirst,
    );
  });

  test("a re-delivered MessageReceived event is absorbed by the log's dedup key", async () => {
    const { host, model } = await openHost();
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "hello", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    const callsAfterFirst = model.calls;
    const runtime = await hostBackend(host).ensure("owner-1");
    const before = await runtime.read(thread.coordinate.thread);
    const original = before.find((event) => event.type === "MessageReceived");
    expect(original).toBeDefined();
    await runtime.seed(thread.coordinate.thread, [
      original as (typeof before)[number],
    ]);
    await runtime.seed(thread.coordinate.thread, [
      messageReceived({
        ...(original as Record<string, unknown>),
        id: "call-1",
        text: "hello",
        at: Date.now(),
      }),
    ]);
    await runtime.wake(thread.coordinate.thread);
    await runtime.settled();
    const after = await runtime.read(thread.coordinate.thread);
    expect(
      after.filter((event) => event.type === "MessageReceived"),
    ).toHaveLength(1);
    expect(
      after.filter((event) => event.type === "TurnCompleted"),
    ).toHaveLength(1);
    expect(after.length).toBe(before.length);
    expect(model.calls).toBe(callsAfterFirst);
    expect(original).toBeDefined();
  });

  test("distinct keys with identical text are distinct turns", async () => {
    const { host, model } = await openHost();
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "same", input: { owner: "owner-1" } },
      { key: "k-1" },
    );
    const callsAfterFirst = model.calls;
    await thread.methods.message(
      { text: "same", input: { owner: "owner-1" } },
      { key: "k-2" },
    );
    expect(model.calls).toBeGreaterThan(callsAfterFirst);
    const events = await log(host, "owner-1", thread.coordinate.thread);
    expect(
      events
        .filter((event) => event.type === "TurnCompleted")
        .map((event) => event.turn),
    ).toEqual(["k-1", "k-2"]);
  });
});
