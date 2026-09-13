/**
 * Restart recovery proof: a child process is SIGKILLed after its TODO
 * mutation reached the store but before the boundary record committed. A
 * fresh host on the same SQLite storage recovers the owed turn, replays the
 * recorded model boundaries without inference, retries the idempotent action
 * with its original operation id so the store dedupes, delivers once, and
 * completes the same invocation the caller was waiting on.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostBackend } from "tardie/bun/create-host";
import type { Event } from "tardie/core/event";
import { elizaActor } from "../src/actor";
import { createElizaBunHost } from "../src/hosts/bun";
import type { ElizaTurnConfig } from "../src/turn";
import {
  fileTodoStore,
  recordingDeliveryPort,
  scriptedModelPort,
  testPlugins,
  testStorageDir,
} from "./support";

const RECOVERY_SCRIPT = {
  candidateActionNames: ["TODO"],
  replyText: "",
  plans: [
    {
      action: "TODO",
      parameters: { action: "create", content: "water the plants" },
    },
  ],
  finishText: "Added water the plants to your list.",
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("restart recovery", () => {
  test("a turn killed after its external effect succeeds recovers with one effect and one delivery", async () => {
    const dir = testStorageDir("eliza-tardigrade-recovery-");
    const storage = join(dir, "storage");
    const storeFile = join(dir, "todos.json");
    const markerFile = join(dir, "effect-applied");
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "scripts", "recovery-child.ts"),
        storage,
        storeFile,
        markerFile,
      ],
      { stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "..") },
    );
    try {
      await waitFor(
        () => existsSync(markerFile),
        60_000,
        "the child to apply its todo mutation",
      );
    } catch (error) {
      child.kill(9);
      const stderr = await new Response(child.stderr).text();
      throw new Error(`${(error as Error).message}\n${stderr}`);
    }
    child.kill(9);
    await child.exited;
    expect(child.signalCode ?? child.exitCode).not.toBe(0);

    const persisted = JSON.parse(readFileSync(storeFile, "utf8")) as {
      todos: Array<{ content: string }>;
      mutations: Array<{ idempotencyKey: string }>;
    };
    expect(persisted.todos.map((todo) => todo.content)).toEqual([
      "water the plants",
    ]);
    const appliedKey = readFileSync(markerFile, "utf8");
    expect(persisted.mutations.map((record) => record.idempotencyKey)).toEqual([
      appliedKey,
    ]);

    const coordinate = JSON.parse(
      readFileSync(`${markerFile}.thread`, "utf8"),
    ) as {
      actor: string;
      instance: string;
      thread: string;
    };
    const model = scriptedModelPort(RECOVERY_SCRIPT);
    const delivery = recordingDeliveryPort();
    const store = fileTodoStore({ path: storeFile });
    const config: ElizaTurnConfig = {
      agentKey: "eliza-recovery",
      character: { name: "Tardiza", system: "You are Tardiza." },
      plugins: testPlugins({ store }).plugins,
      model,
      delivery,
      host: { bindings: [], secrets: [] },
    };
    const host = await createElizaBunHost({
      actor: elizaActor({ name: "eliza-recovery" }),
      storage,
      config,
    });
    try {
      const backend = hostBackend(host);
      const runtime = await backend.ensure(coordinate.instance);
      const before = [...(await runtime.read(coordinate.thread))] as Array<
        Record<string, unknown>
      >;
      const startedActions = before.filter(
        (event) =>
          event.type === "ElizaBoundaryStarted" && event.kind === "action",
      );
      expect(startedActions).toHaveLength(1);
      expect(startedActions[0].name).toBe("TODO");
      expect(
        before.some(
          (event) =>
            event.type === "ElizaBoundaryRecorded" && event.kind === "action",
        ),
      ).toBe(false);
      expect(before.some((event) => event.type === "TurnCompleted")).toBe(
        false,
      );

      const output = await host.thread(coordinate).methods.message(
        {
          text: "remind me to water the plants",
          input: { owner: "owner-1" },
        },
        { key: "call-1" },
      );
      expect(output).toBe("Added water the plants to your list.");

      const after = [...(await runtime.read(coordinate.thread))] as Array<
        Record<string, unknown>
      >;
      const messages = after.filter(
        (event) => event.type === "MessageReceived",
      );
      expect(messages).toHaveLength(1);
      expect(
        after.filter((event) => event.type === "TurnCompleted"),
      ).toHaveLength(1);
      const actionStarts = after.filter(
        (event) =>
          event.type === "ElizaBoundaryStarted" && event.kind === "action",
      );
      const actionRecords = after.filter(
        (event) =>
          event.type === "ElizaBoundaryRecorded" && event.kind === "action",
      );
      expect(actionStarts).toHaveLength(1);
      expect(actionRecords).toHaveLength(1);
      expect(actionRecords[0].outcome).toBe("returned");
      const modelRecordsBefore = before.filter(
        (event) =>
          event.type === "ElizaBoundaryRecorded" && event.kind === "model",
      ).length;
      expect(modelRecordsBefore).toBeGreaterThanOrEqual(2);
      const modelRecordsAfter = after.filter(
        (event) =>
          event.type === "ElizaBoundaryRecorded" && event.kind === "model",
      ).length;
      expect(model.calls).toBe(modelRecordsAfter - modelRecordsBefore);
      expect(model.calls).toBeLessThan(modelRecordsAfter);

      const recovered = JSON.parse(readFileSync(storeFile, "utf8")) as {
        todos: Array<{ content: string }>;
        mutations: Array<{ idempotencyKey: string }>;
      };
      expect(recovered.todos.map((todo) => todo.content)).toEqual([
        "water the plants",
      ]);
      expect(recovered.mutations).toHaveLength(1);
      expect(store.applied).toEqual([]);
      expect(delivery.deliveries).toHaveLength(1);
      expect(delivery.deliveries[0].content.text).toBe(
        "Added water the plants to your list.",
      );
      const events: Event[] = after as unknown as Event[];
      expect(
        events.filter((event) => event.type === "ElizaThreadBound"),
      ).toHaveLength(1);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
