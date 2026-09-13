/**
 * Scheduling proof on a real Bun host: an action schedules a core task during
 * a turn, the task row lands in the durable log, a host wakeup runs core's
 * TaskService.runDueTasks over the projected rows, the worker's execution is a
 * journaled boundary, one-shot tasks are consumed, repeat tasks honor their
 * interval, and wakeups obey the thread's owner binding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Plugin } from "@elizaos/core/edge";
import { hostBackend } from "tardie/bun/create-host";
import { elizaActor } from "../src/actor";
import { declarePlugin } from "../src/compatibility";
import { turnOutputDelivery } from "../src/delivery";
import { createElizaBunHost, type ElizaBunHost } from "../src/hosts/bun";
import type { TardigradeTaskWorker } from "../src/scheduling";
import {
  HOST_TODOS_COMPATIBILITY,
  scriptedModelPort,
  testPlugins,
  testStorageDir,
} from "./support";

const opened: Array<{ host: ElizaBunHost; storage: string }> = [];

function pingPlugin(pings: string[]): Plugin {
  const worker: TardigradeTaskWorker = {
    name: "PING",
    tardigradeEffectPolicy: "idempotent",
    execute: async (_runtime, options) => {
      pings.push(String(options.tardigradeOperationId ?? ""));
      return undefined;
    },
  };
  return {
    name: "ping-scheduler",
    description: "Schedules a PING task through core's task system.",
    init: async (_config, runtime) => {
      runtime.registerTaskWorker(worker);
    },
    actions: [
      {
        name: "SCHEDULE_PING",
        description:
          "Schedule a ping task; repeat=true schedules a recurring one.",
        similes: [],
        tags: ["capability:schedule", "effect:idempotent"],
        contexts: ["general"],
        parameters: [
          {
            name: "repeat",
            description: "Whether the ping recurs every minute.",
            required: false,
            schema: { type: "boolean" },
          },
        ],
        validate: async () => true,
        handler: async (runtime, message, _state, options, callback) => {
          const repeat =
            (options as { parameters?: { repeat?: unknown } })?.parameters
              ?.repeat === true;
          const taskId = await runtime.createTask({
            name: "PING",
            description: "Ping the owner.",
            tags: repeat ? ["queue", "repeat"] : ["queue"],
            roomId: message.roomId,
            metadata: repeat ? { updateInterval: 60_000, updatedAt: 0 } : {},
          });
          const observedAt = new Date().toISOString();
          const operationId = String(
            (options as { tardigradeOperationId?: unknown })
              ?.tardigradeOperationId ?? "",
          );
          const receiptId = `tasks:schedule:${taskId}`;
          const userFacingText = `Scheduled ping ${taskId}.`;
          await callback?.({ text: userFacingText });
          return {
            success: true,
            text: `scheduled ${taskId}`,
            userFacingText,
            verifiedUserFacing: true,
            userFacingEffectReceiptIds: [receiptId],
            data: { actionName: "SCHEDULE_PING", taskId, repeat },
            effectReceipts: [
              {
                receiptId,
                operation: "tasks.schedule",
                resource: { kind: "tasks.task", id: taskId },
                artifacts: [],
                idempotency: { key: operationId, replayed: false },
                observedAt,
                outcome: "applied",
                commit: {
                  kind: "durable",
                  id: taskId,
                  committedAt: observedAt,
                },
              },
            ],
          };
        },
      },
    ],
  };
}

async function openHost(pings: string[]) {
  const storage = testStorageDir("eliza-tardigrade-sched-");
  const model = scriptedModelPort((request) => {
    const repeat = JSON.stringify(request.messages).includes("every minute");
    return {
      candidateActionNames: ["SCHEDULE_PING"],
      replyText: "",
      plans: [{ action: "SCHEDULE_PING", parameters: { repeat } }],
      finishText: "Scheduled.",
    };
  });
  const host = await createElizaBunHost({
    actor: elizaActor({ name: "eliza-sched" }),
    storage,
    config: {
      agentKey: "eliza-sched",
      character: { name: "Tardiza", system: "You are Tardiza." },
      plugins: [
        ...testPlugins().plugins,
        declarePlugin(pingPlugin(pings), {
          ...HOST_TODOS_COMPATIBILITY,
          state: "test-ping",
        }),
      ],
      model,
      delivery: turnOutputDelivery,
      host: { bindings: [], secrets: [] },
    },
  });
  opened.push({ host, storage });
  return { host, model };
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.host.close();
    rmSync(entry.storage, { recursive: true, force: true });
  }
});

async function readLog(host: ElizaBunHost, instance: string, thread: string) {
  return [
    ...(await (await hostBackend(host).ensure(instance)).read(thread)),
  ] as Array<Record<string, unknown>>;
}

describe("serverless scheduling", () => {
  test("a task scheduled in a turn runs once on the next wakeup and is consumed", async () => {
    const pings: string[] = [];
    const { host } = await openHost(pings);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "ping me once", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    let log = await readLog(host, "owner-1", thread.coordinate.thread);
    const upserts = log.filter((event) => event.type === "ElizaTaskUpserted");
    expect(upserts).toHaveLength(1);
    expect((upserts[0].task as { tags: string[] }).tags).toEqual(["queue"]);
    expect(pings).toEqual([]);

    const first = await thread.methods.runDueTasks(
      { owner: "owner-1" },
      { key: "tick-1" },
    );
    expect(first).toEqual({ executed: 1 });
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatch(/^eliza:tick-1\/0\/task\/0$/);
    log = await readLog(host, "owner-1", thread.coordinate.thread);
    const taskBoundaries = log.filter(
      (event) => event.type === "ElizaBoundaryStarted" && event.kind === "task",
    );
    expect(
      taskBoundaries.map((event) => [event.turn, event.name, event.policy]),
    ).toEqual([["tick-1", "PING", "idempotent"]]);
    expect(
      log.some(
        (event) =>
          event.type === "ElizaBoundaryRecorded" && event.kind === "task",
      ),
    ).toBe(true);
    expect(
      log.filter((event) => event.type === "ElizaTaskDeleted"),
    ).toHaveLength(1);
    expect(
      log
        .filter((event) => event.type === "ElizaTickCompleted")
        .map((event) => event.tick),
    ).toEqual(["tick-1"]);

    const second = await thread.methods.runDueTasks(
      { owner: "owner-1" },
      { key: "tick-2" },
    );
    expect(second).toEqual({ executed: 0 });
    expect(pings).toHaveLength(1);
  });

  test("a repeat task honors its interval across wakeups", async () => {
    const pings: string[] = [];
    const { host } = await openHost(pings);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await thread.methods.message(
      { text: "ping me every minute", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    let log = await readLog(host, "owner-1", thread.coordinate.thread);
    const repeatTask = log.find((event) => event.type === "ElizaTaskUpserted")
      ?.task as { tags: string[] } | undefined;
    expect(repeatTask?.tags).toEqual(["queue", "repeat"]);
    expect(
      await thread.methods.runDueTasks({ owner: "owner-1" }, { key: "tick-1" }),
    ).toEqual({
      executed: 1,
    });
    log = await readLog(host, "owner-1", thread.coordinate.thread);
    const upserts = log.filter((event) => event.type === "ElizaTaskUpserted");
    expect(upserts.length).toBeGreaterThanOrEqual(2);
    const latest = upserts.at(-1)?.task as { metadata: { updatedAt: number } };
    expect(latest.metadata.updatedAt).toBeGreaterThan(0);
    expect(
      log.filter((event) => event.type === "ElizaTaskDeleted"),
    ).toHaveLength(0);
    expect(
      await thread.methods.runDueTasks({ owner: "owner-1" }, { key: "tick-2" }),
    ).toEqual({
      executed: 0,
    });
    expect(pings).toHaveLength(1);
  });

  test("wakeups obey the thread's owner binding", async () => {
    const pings: string[] = [];
    const { host } = await openHost(pings);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await expect(
      thread.methods.runDueTasks({ owner: "owner-1" }, { key: "tick-early" }),
    ).rejects.toThrow("TARDIGRADE_THREAD_UNBOUND");
    await thread.methods.message(
      { text: "ping me once", input: { owner: "owner-1" } },
      { key: "call-1" },
    );
    await expect(
      thread.methods.runDueTasks({ owner: "owner-2" }, { key: "tick-foreign" }),
    ).rejects.toThrow("TARDIGRADE_OWNER_INSTANCE_MISMATCH");
    expect(pings).toEqual([]);
    const log = await readLog(host, "owner-1", thread.coordinate.thread);
    expect(
      log
        .filter((event) => event.type === "ElizaTickFailed")
        .map((event) => event.tick),
    ).toEqual(["tick-early", "tick-foreign"]);
  });
});
