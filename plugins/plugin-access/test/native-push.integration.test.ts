/**
 * Joins real native Access webhook ingestion to the SDK, coordinator, TaskService,
 * scheduler and production owner-bound Telegram dispatcher. The Access child uses
 * its required Bun version and one native module tree. Website responses, model
 * decisions and the final sendMessageToTarget receipt are deterministic test inputs;
 * no external model or Telegram service is contacted. Access restarts from disk,
 * while Aiko coordinator restarts retain the injected task/store test boundaries.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  type Content,
  createCharacter,
  ModelType,
  type SendHandlerResult,
  type TargetInfo,
  type Task,
  TaskService,
  type UUID,
} from "@elizaos/core";
import {
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  getScheduledTaskRunner,
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { createAccessClient } from "access/client";
import { createOwnerTokenIssuer } from "access/server-auth";
import { expect, test } from "vitest";
import { registerDefaultChannelPack } from "../../plugin-personal-assistant/src/lifeops/channels/default-pack";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../../plugin-personal-assistant/src/lifeops/channels/index";
import { createProductionScheduledTaskDispatcher } from "../../plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring";
import { drainStateSchema } from "../src/contracts";
import { AccessCoordinator } from "../src/coordinator";
import { createAccessWatchers, scheduleAccessWatcher } from "../src/scheduling";

const OWNER: UUID = "11111111-1111-4111-8111-111111111111";
const OTHER: UUID = "22222222-2222-4222-8222-222222222222";
const AGENT: UUID = "33333333-3333-4333-8333-333333333333";
const OWNER_ROOM: UUID = "44444444-4444-4444-8444-444444444444";
const OTHER_ROOM: UUID = "55555555-5555-4555-8555-555555555555";
const TOKEN_SECRET = "native-push-owner-token-fixture-32-bytes";
const HOOK_SECRET = "native-push-webhook-fixture-secret";
const FULL_DETAIL = "Complete invoice source evidence. ".repeat(3000);

function nativeBun(): string {
  const candidates = process.env.ACCESS_NATIVE_TEST_BUN
    ? [process.env.ACCESS_NATIVE_TEST_BUN]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((path) => join(path, "bun"));
  for (const candidate of new Set(candidates)) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    const version = /^(\d+)\.(\d+)\./.exec(result.stdout?.trim() ?? "");
    if (
      result.status === 0 &&
      version &&
      (Number(version[1]) > 1 ||
        (Number(version[1]) === 1 && Number(version[2]) >= 4))
    )
      return candidate;
  }
  throw new Error(
    "Access native integration requires Bun >=1.4; set ACCESS_NATIVE_TEST_BUN to that executable",
  );
}

function nativeHostSource(accessRoot: string, stateDir: string, port: number) {
  // A child process keeps Access's native actor/host identity and engine intact.
  // The only fake boundaries are Infer and the external website driver.
  return `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(accessRoot, "package.json"))});
const { Effect, Layer } = await import(require.resolve("effect"));
const { Infer } = await import(require.resolve("tardie/agent"));
const { createAccessTenancy, createAccessActor } = await import(${JSON.stringify(join(accessRoot, "src/index.ts"))});
const { createOwnerTokenVerifier } = await import(${JSON.stringify(join(accessRoot, "src/server-auth/index.ts"))});
const owners = ${JSON.stringify([OWNER, OTHER])};
const reads = Object.fromEntries(owners.map(owner => [owner, 0]));
const inferences = Object.fromEntries(owners.map(owner => [owner, 0]));
const host = createAccessTenancy({
  dir: ${JSON.stringify(stateDir)}, resource: "http://127.0.0.1", authorizationServers: [],
  verifier: createOwnerTokenVerifier({ secret: ${JSON.stringify(TOKEN_SECRET)} }),
  passphraseForOwner: owner => "native-push-encrypted-fixture-" + owner,
  configure: () => ({ network: { mode: "direct" } }),
  configureAccount: owner => ({ network: { mode: "direct" }, access: { driver: async () => {
    reads[owner]++;
    return { status: 200, headers: { "content-type": "application/json" }, setCookies: [],
      body: JSON.stringify({ owner, invoice: owner + "-private-invoice", detail: ${JSON.stringify(FULL_DETAIL)} }) };
  } } }),
  subscriptionFor: id => {
    const owner = owners.find(value => id === "hook-" + value);
    return owner ? { ownerId: owner, accountId: "work", subscriptionId: "updates", secret: ${JSON.stringify(HOOK_SECRET)}, on: { "invoice.changed": { intents: ["invoice"] } } } : undefined;
  },
  native: resources => ({ actor: createAccessActor({ ...resources, capabilities: [] }),
    remote: { model: { provider: "fixture", model_id: "deterministic" } },
    layersFor: () => Layer.succeed(Infer, { react: () => Effect.sync(() => {
      const count = ++inferences[resources.ownerId];
      return count % 2 === 1 ? { kind: "calls", calls: [{ name: "execute", callId: "read-" + count,
        arguments: { code: 'return await accounts.call({accountId:"work",method:"query",input:{intent:"invoice"}})' } }] }
        : { kind: "complete", output: "Observed complete invoice response" };
    }) }) })
});
for (const owner of owners) {
  const tenant = await host.forOwner(owner);
  if (tenant.accounts.list().length === 0) {
    tenant.accounts.add({ id: "work", site: "invoice.fixture" });
    await tenant.accounts.run("work", async resource => {
      await resource.access.session.fetch("https://invoice.fixture/invoices");
      resource.access.hooks.subscribe({ id: "updates", origin: "https://invoice.fixture", on: { "invoice.changed": { intents: ["invoice"] } } });
    });
  }
}
const server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: request => {
  if (new URL(request.url).pathname === "/__fixture/counts") return Response.json({ reads, inferences });
  return host.fetch(request);
} });
process.on("SIGTERM", async () => { server.stop(true); await host.close(); process.exit(0); });
console.log("ACCESS_NATIVE_TEST_READY:" + server.port);
`;
}

async function openNativeHost(
  binary: string,
  root: string,
  dir: string,
  port = 0,
) {
  const child = spawn(binary, ["--eval", nativeHostSource(root, dir, port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readyPort = await new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Native Access fixture startup timed out"));
    }, 20000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ACCESS_NATIVE_TEST_READY:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Native Access fixture exited before readiness (${code})`),
      );
    });
  });
  return { child, port: readyPort, baseUrl: `http://127.0.0.1:${readyPort}` };
}

async function closeNativeHost(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Native Access fixture did not close cleanly"));
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
    child.kill("SIGTERM");
  });
}

class JoinedRuntime extends AgentRuntime {
  readonly tasks = new Map<UUID, Task>();
  readonly sends: { target: TargetInfo; content: Content }[] = [];
  beforeSend: (() => Promise<void>) | undefined;
  failNextCursorCommit = false;

  override async getTask(id: UUID): Promise<Task | null> {
    return structuredClone(this.tasks.get(id) ?? null);
  }
  override async createTask(task: Task): Promise<UUID> {
    if (!task.id || this.tasks.has(task.id))
      throw new Error("Task identity required");
    this.tasks.set(task.id, structuredClone(task));
    return task.id;
  }
  override async updateTask(id: UUID, update: Partial<Task>): Promise<void> {
    const prior = this.tasks.get(id);
    if (!prior) throw new Error("Task not found");
    const next = { ...prior, ...update };
    const state = drainStateSchema.parse(next.metadata?.values?.access);
    const previous = drainStateSchema.parse(prior.metadata?.values?.access);
    if (
      this.failNextCursorCommit &&
      state.cursor > previous.cursor &&
      this.sends.length > 0
    ) {
      this.failNextCursorCommit = false;
      throw new Error("Injected cursor commit failure after accepted delivery");
    }
    this.tasks.set(id, structuredClone(next));
  }
  override async sendMessageToTarget(
    target: TargetInfo,
    content: Content,
  ): SendHandlerResult {
    await this.beforeSend?.();
    this.sends.push({
      target: structuredClone(target),
      content: structuredClone(content),
    });
    return {
      kind: "delivered",
      memories: [],
      receipt: {
        providerMessageIds: [`telegram-test-sink-${this.sends.length}`],
        acceptedAt: Date.now(),
        persistence: { status: "persisted", memoryIds: [] },
      },
    };
  }
}

test("signed native push commits owner context before production Telegram dispatch and survives duplicate/restart", async () => {
  const accessRoot = resolve(
    dirname(createRequire(import.meta.url).resolve("access")),
    "..",
  );
  const dir = await mkdtemp(join(tmpdir(), "aiko-native-push-"));
  const binary = nativeBun();
  let host: Awaited<ReturnType<typeof openNativeHost>> | undefined;
  const runtime = new JoinedRuntime({
    agentId: AGENT,
    character: createCharacter({ name: "Native push integration" }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  let coordinator: AccessCoordinator | undefined;
  try {
    host = await openNativeHost(binary, accessRoot, dir);
    const baseUrl = host.baseUrl;
    const issuer = createOwnerTokenIssuer({ secret: TOKEN_SECRET });
    const clients = new Map(
      [OWNER, OTHER].map((owner) => [
        owner,
        createAccessClient({ baseUrl, token: () => issuer.issue(owner) }),
      ]),
    );
    const client = (owner: UUID) => {
      const value = clients.get(owner);
      if (!value) throw new Error("Unexpected owner");
      return value;
    };
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    for (const [owner, room] of [
      [OWNER, OWNER_ROOM],
      [OTHER, OTHER_ROOM],
    ] as const) {
      await runtime.createEntity({
        id: owner,
        names: ["Fixture owner"],
        agentId: AGENT,
      });
      await runtime.createRooms([
        {
          id: room,
          type: ChannelType.DM,
          source: "telegram",
          channelId: `chat-${owner}`,
          worldId: AGENT,
          metadata: { accountId: "aiko-test-bot" },
        },
      ]);
      await runtime.addParticipant(owner, room);
      await runtime.addParticipant(AGENT, room);
    }
    const store = createInMemoryScheduledTaskStore();
    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    registerChannelRegistry(runtime, channelRegistry);
    registerScheduledTaskRunnerDeps(runtime, () => ({
      store,
      logStore: createInMemoryScheduledTaskLogStore(),
      dispatcher: createProductionScheduledTaskDispatcher({
        runtime,
        persistDispatchAttempt: async (record, message, key) => {
          const task = await store.get(record.taskId);
          if (!task) throw new Error("Missing dispatch task");
          const prepared = {
            dispatchPreparedMessage: message,
            dispatchIdempotencyKey: key,
          };
          task.metadata = { ...task.metadata, ...prepared };
          await store.upsert(task);
          Object.assign(record.metadata ?? {}, prepared);
        },
      }),
      ownerFacts: () => ({ timezone: "UTC" }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      channelKeys: () => new Set(["telegram"]),
      channelAvailable: () => true,
    }));
    await runtime.registerService(ScheduledTaskRunnerService);
    await runtime.getServiceLoadPromise(ScheduledTaskRunnerService.serviceType);
    const runner = () => getScheduledTaskRunner(runtime, { agentId: AGENT });
    coordinator = new AccessCoordinator(runtime, {
      client,
      watchers: createAccessWatchers(runner, runtime),
    });
    const context = () => {
      if (!coordinator) throw new Error("Coordinator required");
      return coordinator.context(OWNER);
    };
    let relevanceCalls = 0;
    const renderPrompts: string[] = [];
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async (_runtime, params) => {
        if (typeof params.prompt !== "string")
          throw new Error("Complete string model prompt required");
        if (
          params.prompt.startsWith(
            "Evaluate whether this newly committed website event",
          )
        ) {
          relevanceCalls++;
          expect(params.prompt).toContain(FULL_DETAIL);
          expect(params.prompt).not.toContain(`${OTHER}-private-invoice`);
          expect(params.prompt).toContain(JSON.stringify(await context()));
          return JSON.stringify({
            relevant: true,
            reason: "Deterministic fixture confirms invoice condition",
          });
        }
        renderPrompts.push(params.prompt);
        expect(params.prompt).toContain(`${OWNER}-private-invoice`);
        expect(params.prompt).toContain(FULL_DETAIL);
        expect(params.prompt).not.toContain(`${OTHER}-private-invoice`);
        return "Your invoice changed.";
      },
      "native-push-deterministic-model",
    );
    runtime.beforeSend = async () => {
      const committed = await context();
      expect(committed.status).toBe("ready");
      expect(JSON.stringify(committed)).toContain(FULL_DETAIL);
      expect(JSON.stringify(committed)).not.toContain(
        `${OTHER}-private-invoice`,
      );
    };
    coordinator.start();
    const taskService = new TaskService(runtime);
    for (const owner of [OWNER, OTHER]) {
      await coordinator.enroll(owner);
      await scheduleAccessWatcher(runtime, owner, "work", {
        id: randomUUID(),
        intent: "Tell me when my invoice changes",
        channelKey: "telegram",
      });
    }
    const body = JSON.stringify({
      id: "invoice-event-one",
      type: "invoice.changed",
      payload: { claimedOwner: OTHER },
    });
    const signature = createHmac("sha256", HOOK_SECRET)
      .update(body)
      .digest("hex");
    const push = (signed: string) =>
      fetch(`${baseUrl}/hooks/hook-${OWNER}`, {
        method: "POST",
        headers: { "x-access-signature": signed },
        body,
      });
    expect((await push("invalid-signature")).status).toBe(401);
    const accepted = await push(signature);
    expect(accepted.status).toBe(202);
    const result = (await accepted.json()) as { operation: { id: string } };
    await expect
      .poll(
        async () =>
          (await client(OWNER).accounts.connection("work")).operations.find(
            (operation) => operation.id === result.operation.id,
          )?.status,
        { timeout: 15000 },
      )
      .toBe("completed");
    const events = await client(OWNER).events(0);
    expect(
      events.events.some(
        (event) =>
          event.type === "evidence.committed" &&
          event.operationId === result.operation.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(await client(OTHER).context())).not.toContain(
      `${OWNER}-private-invoice`,
    );
    runtime.failNextCursorCommit = true;
    await expect(
      taskService.executeTaskById(coordinator.taskId(OWNER)),
    ).rejects.toThrow();
    expect(runtime.sends).toHaveLength(1);
    expect(runtime.sends[0]?.target).toMatchObject({
      source: "telegram",
      channelId: `chat-${OWNER}`,
      accountId: "aiko-test-bot",
      roomId: OWNER_ROOM,
    });
    expect(runtime.sends[0]?.content).toMatchObject({
      text: "Your invoice changed.",
      agentVoiced: true,
    });
    expect(renderPrompts).toHaveLength(1);
    const callsBeforeRestart = relevanceCalls;
    const cursorBeforeRestart = events.nextCursor;
    await coordinator.stop();
    await closeNativeHost(host.child);
    host = await openNativeHost(binary, accessRoot, dir, host.port);
    expect((await client(OWNER).events(cursorBeforeRestart)).events).toEqual(
      [],
    );
    expect((await push(signature)).status).toBe(202);
    const counts = (await (
      await fetch(`${baseUrl}/__fixture/counts`)
    ).json()) as {
      reads: Record<string, number>;
      inferences: Record<string, number>;
    };
    expect(counts.reads[OWNER]).toBe(0);
    expect(counts.inferences[OWNER]).toBe(0);
    coordinator = new AccessCoordinator(runtime, {
      client,
      watchers: createAccessWatchers(runner, runtime),
    });
    coordinator.start();
    await taskService.executeTaskById(coordinator.taskId(OWNER));
    await taskService.executeTaskById(coordinator.taskId(OTHER));
    expect(runtime.sends).toHaveLength(1);
    expect(relevanceCalls).toBe(callsBeforeRestart);
    expect((await coordinator.context(OWNER)).cursor).toBe(cursorBeforeRestart);
    expect(JSON.stringify(await coordinator.context(OTHER))).not.toContain(
      `${OWNER}-private-invoice`,
    );
    const occurrence = (await runner().list()).find(
      (task) => task.metadata?.accessEventId,
    );
    expect(occurrence?.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      receipt: {
        provider: "telegram",
        providerMessageId: "telegram-test-sink-1",
      },
    });
  } finally {
    await coordinator?.stop();
    await runtime.stop();
    if (host) await closeNativeHost(host.child);
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
