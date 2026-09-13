/**
 * Actor contract on a real Bun Tardigrade host: a `message` call completes an
 * Eliza turn whose durable log carries the thread binding, every journaled
 * boundary, and the terminal; later turns see the complete earlier history;
 * and owner violations end as durable failures. The model and delivery are
 * deterministic fakes; the host, log, and runtime are real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { hostBackend } from "tardie/bun/create-host";
import type { Event } from "tardie/core/event";
import { elizaActor } from "../src/actor";
import { turnOutputDelivery } from "../src/delivery";
import { createElizaBunHost, type ElizaBunHost } from "../src/hosts/bun";
import type { ElizaTurnConfig } from "../src/turn";
import {
  type ScriptedModelPort,
  scriptedModelPort,
  testPlugins,
  testStorageDir,
} from "./support";

const hosts: Array<{ host: ElizaBunHost; storage: string }> = [];

async function openHost(model: ScriptedModelPort, plugins = testPlugins()) {
  const storage = testStorageDir("eliza-tardigrade-actor-");
  const config: ElizaTurnConfig = {
    agentKey: "eliza-actor-test",
    character: { name: "Tardiza", system: "You are Tardiza." },
    plugins: plugins.plugins,
    model,
    delivery: turnOutputDelivery,
    host: { bindings: [], secrets: [] },
  };
  const host = await createElizaBunHost({
    actor: elizaActor({ name: "eliza-test" }),
    storage,
    config,
  });
  hosts.push({ host, storage });
  return { host, storage, plugins };
}

async function readLog(
  host: ElizaBunHost,
  instance: string,
  thread: string,
): Promise<Event[]> {
  const backend = hostBackend(host);
  const runtime = await backend.ensure(instance);
  return [...(await runtime.read(thread))];
}

afterEach(async () => {
  for (const entry of hosts.splice(0)) {
    await entry.host.close();
    rmSync(entry.storage, { recursive: true, force: true });
  }
});

describe("eliza actor on the Bun host", () => {
  test("a message completes a turn with the binding, boundaries, and terminal in the durable log", async () => {
    const model = scriptedModelPort({ replyText: "Hello from Tardiza." });
    const { host } = await openHost(model);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    const output = await thread.methods.message(
      { text: "hello", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    expect(output).toBe("Hello from Tardiza.");
    const log = await readLog(host, "owner-1", thread.coordinate.thread);
    const types = log.map((event) => event.type);
    expect(types).toContain("MessageReceived");
    expect(types).toContain("ElizaThreadBound");
    expect(types).toContain("ElizaBoundaryStarted");
    expect(types).toContain("ElizaBoundaryRecorded");
    expect(types).toContain("TurnCompleted");
    expect(types.indexOf("ElizaThreadBound")).toBeLessThan(
      types.indexOf("ElizaBoundaryStarted"),
    );
    expect(types.indexOf("ElizaBoundaryRecorded")).toBeLessThan(
      types.indexOf("TurnCompleted"),
    );
    const terminal = log.find(
      (event) => event.type === "TurnCompleted",
    ) as Record<string, unknown>;
    expect(terminal.turn).toBe("call-1");
    expect(terminal.output).toBe("Hello from Tardiza.");
    const started = log.filter(
      (event) => event.type === "ElizaBoundaryStarted",
    ) as Array<Record<string, unknown>>;
    expect(started.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["model", "delivery"]),
    );
    expect(started.every((event) => event.turn === "call-1")).toBe(true);
    expect(types.filter((type) => type === "TurnCompleted")).toHaveLength(1);
  });

  test("a later turn sees the complete earlier history in its prompt", async () => {
    const model = scriptedModelPort((request) => {
      const last = request.messages?.at(-1);
      const text =
        typeof last?.content === "string"
          ? last.content
          : JSON.stringify(last?.content ?? "");
      return {
        replyText: text.includes("second") ? "Second reply." : "First reply.",
      };
    });
    const { host } = await openHost(model);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "first message marker", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    const output = await thread.methods.message(
      { text: "second message marker", input: { owner: "owner-1" } },
      { key: "call-2" },
    );
    expect(output).toBe("Second reply.");
    const secondTurnRequests = model.requests.filter((request) =>
      JSON.stringify(request.messages).includes("second message marker"),
    );
    expect(secondTurnRequests.length).toBeGreaterThan(0);
    const prompt = JSON.stringify(secondTurnRequests[0].messages);
    expect(prompt).toContain("first message marker");
    expect(prompt).toContain("First reply.");
    expect(prompt.indexOf("first message marker")).toBeLessThan(
      prompt.indexOf("First reply."),
    );
    expect(prompt.indexOf("First reply.")).toBeLessThan(
      prompt.indexOf("second message marker"),
    );
  });

  test("owner violations end as durable failures the caller observes", async () => {
    const model = scriptedModelPort({ replyText: "Hello." });
    const { host } = await openHost(model);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "hello", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    await expect(
      thread.methods.message(
        { text: "hi", input: { owner: "owner-2" } },
        { key: "call-2" },
      ),
    ).rejects.toThrow("TARDIGRADE_OWNER_INSTANCE_MISMATCH");
    await expect(
      thread.methods.message({ text: "hi" } as never, { key: "call-3" }),
    ).rejects.toThrow(/owner|input/u);
    const log = await readLog(host, "owner-1", thread.coordinate.thread);
    const failed = log.filter((event) => event.type === "TurnFailed") as Array<
      Record<string, unknown>
    >;
    expect(failed.map((event) => event.turn)).toEqual(["call-2"]);
    expect(
      log.some((event) => (event as Record<string, unknown>).id === "call-3"),
    ).toBe(false);
    expect(failed.every((event) => event.cause === "message_invalid")).toBe(
      true,
    );
    expect(model.calls).toBe(model.requests.length);
    const modelStarts = log.filter(
      (event) =>
        event.type === "ElizaBoundaryStarted" &&
        (event as Record<string, unknown>).kind === "model",
    ) as Array<Record<string, unknown>>;
    expect(modelStarts.every((event) => event.turn === "call-1")).toBe(true);
  });
});
