/** Exercises the real coordinator, signed SDK transport, authenticated routes and scheduling runner with deterministic persistence/connector boundaries. */

import { once } from "node:events";
import { createServer } from "node:http";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  ModelType,
  type Task,
  TaskService,
  type UUID,
} from "@elizaos/core";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  type DispatchResult,
  type GateDecision,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  registerScheduledTaskRunnerDeps,
  type ScheduledTaskDispatchRecord,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { type AccessCommittedEvent, createAccessClient } from "access/client";
import {
  createOwnerTokenIssuer,
  createOwnerTokenVerifier,
} from "access/server-auth";
import { afterEach, describe, expect, test } from "vitest";
import { TelegramService } from "../../plugin-telegram/src/service.ts";
import { emitTelegramUserActivity } from "../../plugin-telegram/src/user-activity.ts";
import { accessActions } from "../src/actions.ts";
import { shouldEnable } from "../src/auto-enable.ts";
import {
  ACCESS_DRAIN,
  ACCESS_EVENT,
  drainStateSchema,
} from "../src/contracts.ts";
import { AccessCoordinator, type AccessWatchers } from "../src/coordinator.ts";
import { accessPlugin } from "../src/index.ts";
import { accessProvider } from "../src/provider.ts";
import { createAccessRoutes } from "../src/routes.ts";
import {
  createAccessWatchers,
  scheduleAccessWatcher,
} from "../src/scheduling.ts";
import { AccessService } from "../src/service.ts";

const OWNER: UUID = "11111111-1111-4111-8111-111111111111";
const OTHER: UUID = "22222222-2222-4222-8222-222222222222";
const AGENT: UUID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE = {
  accountId: "shop",
  sourceCid: "cid-proof",
  pointer: "/orders/0",
  observedAt: 1700000000000,
  text: "Order has shipped",
  freshness: "current" as const,
};
const EVENT: AccessCommittedEvent = {
  cursor: 1,
  id: "event-one",
  accountId: "shop",
  type: "evidence.committed",
  at: 1700000000000,
  operationId: null,
  evidence: [EVIDENCE],
};

class FixtureRuntime extends AgentRuntime {
  readonly taskRows = new Map<UUID, Task>();
  failNextCursorCommit = false;
  constructor() {
    super({
      agentId: AGENT,
      character: createCharacter({ name: "Access fixture" }),
      disableBasicCapabilities: true,
      enableAutonomy: false,
      logLevel: "fatal",
    });
  }
  override async getTask(id: UUID): Promise<Task | null> {
    return structuredClone(this.taskRows.get(id) ?? null);
  }
  override async createTask(task: Task): Promise<UUID> {
    if (!task.id || this.taskRows.has(task.id))
      throw new Error("fixture duplicate task");
    this.taskRows.set(task.id, structuredClone(task));
    return task.id;
  }
  override async updateTask(id: UUID, update: Partial<Task>): Promise<void> {
    const row = this.taskRows.get(id);
    if (!row) throw new Error("fixture missing task");
    const candidate = { ...row, ...update };
    const state = drainStateSchema.parse(candidate.metadata?.values?.access);
    if (this.failNextCursorCommit && state.cursor === 1) {
      this.failNextCursorCommit = false;
      throw new Error("fixture commit failure");
    }
    this.taskRows.set(id, structuredClone(candidate));
  }
}

function fixtureTransport() {
  const secret = "owner-token-fixture-key-32-bytes-long";
  const issuer = createOwnerTokenIssuer({ secret });
  const verifier = createOwnerTokenVerifier({ secret });
  const calls: Array<{ owner: string; path: string; body: unknown }> = [];
  let events = [structuredClone(EVENT)];
  let fail = false;
  let activeAccounts = ["shop"];
  let contextUnavailable = false;
  let requests = 0;
  return {
    calls,
    get requests() {
      return requests;
    },
    setEvents(next: AccessCommittedEvent[]) {
      events = next;
    },
    setActiveAccounts(next: string[]) {
      activeAccounts = next;
    },
    setContextUnavailable(next: boolean) {
      contextUnavailable = next;
    },
    setFail(next: boolean) {
      fail = next;
    },
    client(owner: UUID) {
      return createAccessClient({
        baseUrl: "https://access.test",
        token: () => issuer.issue(owner),
        fetch: async (input, init) => {
          requests++;
          const token =
            new Headers(init?.headers)
              .get("authorization")
              ?.replace(/^Bearer /, "") ?? "";
          const claims = await verifier.verify(token);
          if (!claims) return Response.json({}, { status: 401 });
          const url = new URL(String(input));
          const body =
            init?.body === undefined ? null : JSON.parse(String(init.body));
          calls.push({ owner: claims.ownerId, path: url.pathname, body });
          if (fail)
            return new Response("private-server-secret", { status: 503 });
          if (url.pathname.includes("/browser/handoffs/")) {
            if (claims.ownerId !== OWNER)
              return Response.json({}, { status: 404 });
            if (url.pathname.endsWith("/resume"))
              return Response.json({
                id: body.id,
                accountId: "shop",
                kind: "resume",
                status: "pending",
                thread: "private-resume",
                createdAt: 1,
                updatedAt: 1,
                output: null,
                error: null,
              });
            return Response.json(BROWSER_FRAME);
          }
          if (url.pathname === "/context")
            return Response.json({
              cursor: 0,
              evidence: [],
              status: contextUnavailable ? "unavailable" : "ready",
              error: contextUnavailable ? "Unavailable" : null,
            });
          if (url.pathname === "/events") {
            const after = Number(url.searchParams.get("after"));
            const selected =
              claims.ownerId === OWNER
                ? events.filter((event) => event.cursor > after)
                : [];
            return Response.json({
              events: selected,
              nextCursor: selected.at(-1)?.cursor ?? after,
              hasMore: false,
            });
          }
          if (url.pathname === "/accounts" && init?.method !== "POST")
            return Response.json({
              accounts: activeAccounts.map((id) => ({
                id,
                site: `${id}.test`,
                label: claims.ownerId,
                active: true,
              })),
            });
          if (
            url.pathname.endsWith("/credentials/pending") &&
            init?.method === "POST"
          )
            return Response.json({ refs: ["vault://shop.test/password"] });
          if (url.pathname === "/accounts" && init?.method === "POST")
            return Response.json({
              account: { ...body, label: body.label ?? "Shop", active: true },
            });
          return Response.json({}, { status: 404 });
        },
      });
    },
  };
}
const BROWSER_FRAME = {
  handoffId: AGENT,
  version: 1,
  url: "https://shop.test/login",
  title: "Private verification",
  width: 100,
  height: 100,
  image: { mimeType: "image/png", base64: "cHJpdmF0ZS1mcmFtZS1ieXRlcw==" },
  expiresAt: 2000000000000,
};
const noWatchers: AccessWatchers = {
  async reconcile() {},
  async match() {
    return [];
  },
  async deliver() {},
};

const modelRuntimes: FixtureRuntime[] = [];
afterEach(async () => {
  await Promise.all(modelRuntimes.splice(0).map((runtime) => runtime.stop()));
});
async function proactivityHarness() {
  const runtime = new FixtureRuntime();
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  modelRuntimes.push(runtime);
  const remote = fixtureTransport();
  const gates = createTaskGateRegistry();
  let moment: GateDecision = { kind: "allow" };
  let momentChecks = 0;
  gates.register({
    kind: "model_moment_check",
    evaluate() {
      momentChecks++;
      return moment;
    },
  });
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const delivered: ScheduledTaskDispatchRecord[] = [];
  let nowMs = Date.parse("2026-09-13T12:00:00Z");
  let quietHours: { start: string; end: string; tz: string } | undefined;
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  const createRunner = () =>
    createScheduledTaskRunner({
      agentId: AGENT,
      store,
      logStore,
      gates,
      completionChecks,
      ladders,
      anchors: createAnchorRegistry(),
      consolidation: createConsolidationRegistry(),
      now: () => new Date(nowMs),
      ownerFacts: () => ({
        timezone: "UTC",
        ...(quietHours === undefined ? {} : { quietHours }),
      }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      channelKeys: () => new Set(["telegram"]),
      channelAvailable: () => true,
      dispatcher: {
        async dispatch(record) {
          delivered.push(record);
          const key = record.metadata?.dispatchIdempotencyKey;
          if (typeof key !== "string" || key.length === 0)
            throw new Error("Native dispatch identity required");
          return {
            ok: true,
            messageId: "accepted",
            receipt: {
              provider: "telegram",
              providerMessageId: "accepted",
              idempotencyKey: key,
              acceptedAt: record.firedAtIso,
            },
          };
        },
      },
    });
  let runner = createRunner();
  const coordinator = new AccessCoordinator(runtime, {
    client: remote.client,
    watchers: createAccessWatchers(() => runner, runtime),
  });
  const prompts: string[] = [];
  let currentModel: ((prompt: string) => Promise<string>) | undefined;
  let modelRegistered = false;
  return {
    runtime,
    remote,
    get runner() {
      return runner;
    },
    restartRunner() {
      runner = createRunner();
    },
    coordinator,
    prompts,
    delivered,
    get momentChecks() {
      return momentChecks;
    },
    setMoment(decision: GateDecision) {
      moment = decision;
    },
    setTime(iso: string) {
      nowMs = Date.parse(iso);
    },
    setQuietHours(value: { start: string; end: string; tz: string }) {
      quietHours = value;
    },
    model(handler: (prompt: string) => Promise<string>) {
      currentModel = handler;
      if (modelRegistered) return;
      modelRegistered = true;
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async (_runtime, params) => {
          if (typeof params.prompt !== "string")
            throw new Error("Complete model prompt required");
          prompts.push(params.prompt);
          if (!currentModel) throw new Error("Model fixture handler required");
          return currentModel(params.prompt);
        },
        "access-proactive-test",
      );
    },
    async seed(intent: string) {
      await runner.schedule({
        kind: "watcher",
        promptInstructions: intent,
        trigger: { kind: "event", eventKind: ACCESS_EVENT },
        priority: "medium",
        respectsGlobalPause: true,
        shouldFire: { gates: [] },
        source: "user_chat",
        createdBy: OWNER,
        ownerVisible: true,
        escalation: { steps: [{ delayMinutes: 0, channelKey: "telegram" }] },
        metadata: { access: { ownerId: OWNER, accountId: "shop" } },
      });
      await coordinator.enroll(OWNER);
    },
  };
}

describe("Access plugin", () => {
  test("configured discovery enables startup while missing owner signer fails explicitly", async () => {
    expect(shouldEnable({ env: {}, config: {}, isNativePlatform: false })).toBe(
      false,
    );
    expect(
      shouldEnable({
        env: { ACCESS_REMOTE_URL: "https://access.test" },
        config: {},
        isNativePlatform: false,
      }),
    ).toBe(true);
    const runtime = new FixtureRuntime();
    runtime.setSetting("ACCESS_REMOTE_URL", "https://access.test");
    await expect(AccessService.start(runtime)).rejects.toMatchObject({
      code: "ACCESS_CONFIGURATION_REQUIRED",
    });
  });

  test("persisted owner tampering fails before context or event transport", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    const coordinator = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: noWatchers,
    });
    await coordinator.enroll(OWNER);
    const task = await runtime.getTask(coordinator.taskId(OWNER));
    if (!task) throw new Error("Owner task required");
    runtime.taskRows.set(coordinator.taskId(OWNER), {
      ...task,
      entityId: OTHER,
    });
    await expect(coordinator.context(OWNER)).rejects.toMatchObject({
      code: "ACCESS_TASK_SCOPE_INVALID",
    });
    await expect(coordinator.drain(OWNER)).rejects.toMatchObject({
      code: "ACCESS_TASK_SCOPE_INVALID",
    });
    expect(remote.requests).toBe(0);
  });

  test("watcher creation binds the canonical Telegram owner room and refuses another owner's selector", async () => {
    const runtime = new FixtureRuntime();
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    const roomId: UUID = "44444444-4444-4444-8444-444444444444";
    try {
      await runtime.createEntity({
        id: OWNER,
        names: ["Owner"],
        agentId: AGENT,
      });
      await runtime.createRooms([
        {
          id: roomId,
          source: "telegram",
          channelId: "private-owner-chat",
          type: ChannelType.DM,
          worldId: AGENT,
          metadata: { accountId: "aiko-bot" },
        },
      ]);
      await runtime.addParticipant(OWNER, roomId);
      await runtime.addParticipant(AGENT, roomId);
      registerScheduledTaskRunnerDeps(runtime, () => ({
        store: createInMemoryScheduledTaskStore(),
        logStore: createInMemoryScheduledTaskLogStore(),
        dispatcher: {
          async dispatch() {
            return { ok: true };
          },
        },
        ownerFacts: () => ({ timezone: "UTC" }),
        globalPause: { current: async () => ({ active: false }) },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
        channelKeys: () => new Set(["telegram"]),
        channelAvailable: () => true,
      }));
      await runtime.registerService(ScheduledTaskRunnerService);
      await runtime.getServiceLoadPromise(
        ScheduledTaskRunnerService.serviceType,
      );
      const scheduled = await scheduleAccessWatcher(runtime, OWNER, "shop", {
        id: OWNER,
        intent: "Tell me when shipping changes",
        channelKey: "telegram",
      });
      expect(scheduled.task.output).toEqual({
        destination: "channel",
        target: "telegram:private-owner-chat",
      });
      expect(scheduled.task.metadata).toMatchObject({
        chatDeliveryBinding: {
          roomId,
          accountId: "aiko-bot",
          audience: { ownerEntityId: OWNER, agentEntityId: AGENT },
        },
      });
      await expect(
        scheduleAccessWatcher(runtime, OTHER, "shop", {
          id: OTHER,
          intent: "Read another owner",
          channelKey: "telegram",
          roomId,
        }),
      ).rejects.toMatchObject({
        code: "ACCESS_TELEGRAM_OWNER_TARGET_REQUIRED",
      });
    } finally {
      await runtime.stop();
    }
  });

  test("real lazy service lifecycle and action SDK requests retain owner binding while provider stays local", async () => {
    const runtime = new FixtureRuntime();
    const secret = "owner-token-lifecycle-key-32-bytes-long";
    const verifier = createOwnerTokenVerifier({ secret });
    const received: Array<{ owner: string; id: string; kind: string }> = [];
    const server = createServer(async (req, res) => {
      const claims = await verifier.verify(
        req.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      if (!claims) {
        res.writeHead(401).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const input = JSON.parse(body);
      received.push({ owner: claims.ownerId, id: input.id, kind: input.kind });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: input.id,
          accountId: "shop",
          kind: input.kind,
          status: "pending",
          thread: `thread:${input.id}`,
          createdAt: 1,
          updatedAt: 1,
          output: null,
          error: null,
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TCP address required");
    runtime.setSetting("ACCESS_REMOTE_URL", `http://127.0.0.1:${address.port}`);
    runtime.setSetting("ACCESS_OWNER_TOKEN_SECRET", secret);
    try {
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
      await runtime.registerService(AccessService);
      const service = await runtime.getServiceLoadPromise("access");
      expect(runtime.getTaskWorker(ACCESS_DRAIN)).toBeDefined();
      const message = {
        id: OWNER,
        entityId: OWNER,
        agentId: AGENT,
        roomId: AGENT,
        content: { text: "Check my connected website" },
      };
      for (const action of accessActions) {
        expect(await action.validate(runtime, message)).toBe(true);
        const parameters: Record<string, string> =
          action.name === "ACCESS_CONNECT"
            ? { accountId: "shop" }
            : { accountId: "shop", intent: "Read the complete order status" };
        const result = await action.handler(runtime, message, undefined, {
          parameters,
        });
        expect(result).toMatchObject({
          success: true,
          data: { operation: { status: "pending" } },
        });
      }
      const connectAction = accessActions.find(
        (action) => action.name === "ACCESS_CONNECT",
      );
      if (!connectAction) throw new Error("Connect action required");
      await connectAction.handler(runtime, message, undefined, {
        parameters: { accountId: "shop" },
      });
      expect(received).toHaveLength(5);
      expect(received.every((call) => call.owner === OWNER)).toBe(true);
      expect(received[0]?.id).toBe(received[4]?.id);
      const own = await accessProvider.get(runtime, message, {
        values: {},
        data: {},
        text: "",
      });
      const other = await accessProvider.get(
        runtime,
        { ...message, entityId: OTHER },
        { values: {}, data: {}, text: "" },
      );
      expect(own.data).toMatchObject({ access: { status: "unavailable" } });
      expect(other.data).toMatchObject({
        access: { status: "unavailable", evidence: [] },
      });
      expect(received).toHaveLength(5);
      await service.stop();
      expect(runtime.getTaskWorker(ACCESS_DRAIN)).toBeUndefined();
    } finally {
      server.close();
      await once(server, "close");
      await runtime.stop();
    }
  });

  test("real authenticated routes isolate owner tokens and reject claimed owner fields and missing identity", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    const service = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: noWatchers,
    });
    const routes = createAccessRoutes(() => service);
    const call = async (
      method: "GET" | "POST",
      path: string,
      owner: UUID | null,
      body?: unknown,
      params = {},
    ) => {
      const route = routes.find(
        (entry) => entry.type === method && entry.path === path,
      );
      if (!route?.routeHandler) throw new Error("route missing");
      return route.routeHandler({
        runtime,
        method,
        path,
        params,
        query: {},
        headers: { authorization: "untrusted-forwarded-token" },
        inProcess: true,
        body,
        ...(owner === null
          ? {}
          : { accessContext: { requesterEntityId: owner } }),
      });
    };
    expect((await call("GET", "/accounts", null)).status).toBe(401);
    expect(remote.calls).toEqual([]);
    expect((await call("GET", "/accounts", OWNER)).status).toBe(200);
    expect((await call("GET", "/accounts", OTHER)).status).toBe(200);
    expect(remote.calls.map((call) => call.owner)).toEqual([OWNER, OTHER]);
    expect(runtime.taskRows.size).toBe(2);
    expect(
      (
        await call("POST", "/accounts", OWNER, {
          id: "shop",
          site: "shop.test",
          ownerId: OTHER,
        })
      ).status,
    ).toBe(400);
    const result = await call(
      "POST",
      "/accounts/:accountId/credentials/pending",
      OWNER,
      { id: "request", values: { password: "private-credential-answer" } },
      { accountId: "shop" },
    );
    expect(result.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain("private-credential-answer");
    expect(JSON.stringify([...runtime.taskRows.values()])).not.toContain(
      "private-credential-answer",
    );
    remote.setFail(true);
    const failed = await call("GET", "/accounts", OWNER);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed)).not.toContain("private-server-secret");
  });

  test("authenticated browser handoff routes preserve private frames, isolate owners, and reject arbitrary browser execution", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    const coordinator = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: noWatchers,
    });
    const routes = createAccessRoutes(() => coordinator);
    const call = async (
      method: "GET" | "POST",
      suffix: "frame" | "actions" | "resume",
      owner: UUID | null,
      body?: unknown,
    ) => {
      const path = `/accounts/:accountId/browser/handoffs/:handoffId/${suffix}`;
      const route = routes.find(
        (candidate) => candidate.type === method && candidate.path === path,
      );
      if (!route?.routeHandler) throw new Error("Browser route required");
      return route.routeHandler({
        runtime,
        method,
        path,
        params: { accountId: "shop", handoffId: AGENT },
        query: {},
        headers: {},
        body,
        inProcess: true,
        ...(owner === null
          ? {}
          : { accessContext: { requesterEntityId: owner } }),
      });
    };
    expect((await call("GET", "frame", null)).status).toBe(401);
    expect(remote.requests).toBe(0);
    const frame = await call("GET", "frame", OWNER);
    expect(frame).toMatchObject({
      status: 200,
      headers: { "cache-control": "no-store" },
      body: BROWSER_FRAME,
    });
    expect((await call("GET", "frame", OTHER)).status).toBe(404);
    expect(remote.calls.map((request) => request.owner)).toEqual([
      OWNER,
      OTHER,
    ]);
    const beforeInvalid = remote.requests;
    for (const action of [
      { kind: "exec", code: "read browser secrets" },
      { kind: "type", text: "secret password" },
      { kind: "press", key: "secret text" },
      { kind: "click", x: 2, y: 3, ownerId: OTHER },
    ])
      expect(
        (
          await call("POST", "actions", OWNER, {
            id: OWNER,
            version: 1,
            action,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await call("POST", "resume", OWNER, {
          id: OWNER,
          version: 1,
          ownerId: OTHER,
        })
      ).status,
    ).toBe(400);
    expect(remote.requests).toBe(beforeInvalid);
    expect(
      (
        await call("POST", "actions", OWNER, {
          id: OWNER,
          version: 1,
          action: { kind: "click", x: 2, y: 3 },
        })
      ).status,
    ).toBe(200);
    expect(
      await call("POST", "resume", OWNER, { id: OWNER, version: 1 }),
    ).toMatchObject({
      status: 200,
      body: { kind: "resume", status: "pending" },
    });
    expect(runtime.taskRows.size).toBe(0);
    expect(JSON.stringify(await coordinator.context(OWNER))).not.toContain(
      BROWSER_FRAME.image.base64,
    );
    remote.setFail(true);
    const failed = await call("GET", "frame", OWNER);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed)).not.toContain("private-server-secret");
  });

  test("context commits before watcher matching/delivery and reads never perform remote work", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    let service: AccessCoordinator;
    const order: string[] = [];
    service = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: {
        ...noWatchers,
        async match(owner) {
          expect((await service.context(owner)).evidence).toEqual(
            EVENT.evidence,
          );
          order.push("match");
          return ["watcher"];
        },
        async deliver(owner) {
          expect((await service.context(owner)).evidence).toEqual(
            EVENT.evidence,
          );
          order.push("deliver");
        },
      },
    });
    await Promise.all([service.enroll(OWNER), service.enroll(OWNER)]);
    expect(runtime.taskRows.size).toBe(1);
    service.start();
    expect(runtime.getTaskWorker(ACCESS_DRAIN)?.name).toBe(ACCESS_DRAIN);
    const scheduler = new TaskService(runtime);
    await scheduler.executeTaskById(service.taskId(OWNER));
    await Promise.all([service.drain(OWNER), service.drain(OWNER)]);
    expect(
      drainStateSchema.parse(
        (await runtime.getTask(service.taskId(OWNER)))?.metadata?.values
          ?.access,
      ).cursor,
    ).toBe(1);
    expect(order).toEqual(["match", "deliver"]);
    const requests = remote.requests;
    expect((await service.context(OWNER)).evidence).toEqual(EVENT.evidence);
    expect((await service.context(OTHER)).status).toBe("unavailable");
    expect(remote.requests).toBe(requests);
    await service.stop();
  });

  test("failed delivery retains pending context and restart retries before cursor advancement", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    let fail = true;
    const delivered: string[] = [];
    const watchers: AccessWatchers = {
      ...noWatchers,
      async match() {
        return ["watcher"];
      },
      async deliver(_owner, event) {
        if (fail) throw new Error("connector offline");
        delivered.push(event.id);
      },
    };
    const first = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers,
    });
    await first.enroll(OWNER);
    await expect(first.drain(OWNER)).rejects.toThrow("connector offline");
    const state = drainStateSchema.parse(
      (await runtime.getTask(first.taskId(OWNER)))?.metadata?.values?.access,
    );
    expect(state.cursor).toBe(0);
    expect(state.pending?.watcherIds).toEqual(["watcher"]);
    expect(state.context.evidence).toEqual(EVENT.evidence);
    fail = false;
    const restarted = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers,
    });
    await restarted.drain(OWNER);
    await restarted.drain(OWNER);
    expect(delivered).toEqual([EVENT.id]);
    expect(
      drainStateSchema.parse(
        (await runtime.getTask(first.taskId(OWNER)))?.metadata?.values?.access,
      ).cursor,
    ).toBe(1);
  });

  test("full evidence is retained and event identity deduplicates repeated notifications", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    const text = "large-observation-".repeat(20000);
    remote.setEvents([
      { ...EVENT, evidence: [{ ...EVIDENCE, text }] },
      { ...EVENT, cursor: 2 },
    ]);
    let deliveries = 0;
    const service = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: {
        ...noWatchers,
        async match() {
          return [];
        },
        async deliver() {
          deliveries++;
        },
      },
    });
    await service.enroll(OWNER);
    await service.drain(OWNER);
    expect((await service.context(OWNER)).evidence[0]?.text).toBe(text);
    expect(deliveries).toBe(1);
  });

  test("revocation removes only revoked account history and cancels its pending delivery after restart", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    remote.setActiveAccounts(["shop", "mail"]);
    const longHistory = "complete active history ".repeat(20000);
    const mailEvent = {
      ...EVENT,
      id: "mail-evidence",
      accountId: "mail",
      evidence: [{ ...EVIDENCE, accountId: "mail", text: longHistory }],
    };
    const shopEvent = { ...EVENT, cursor: 2 };
    remote.setEvents([mailEvent, shopEvent]);
    const delivered: string[] = [];
    const watchers: AccessWatchers = {
      ...noWatchers,
      async match() {
        return ["watcher"];
      },
      async deliver(_owner, event) {
        if (event.accountId === "shop") throw new Error("delivery paused");
        delivered.push(event.id);
      },
    };
    const first = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers,
    });
    await first.enroll(OWNER);
    await expect(first.drain(OWNER)).rejects.toThrow("delivery paused");
    expect(
      (await first.context(OWNER)).evidence.map((item) => item.accountId),
    ).toEqual(["mail", "shop"]);
    remote.setContextUnavailable(true);
    const restarted = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers,
    });
    await expect(restarted.drain(OWNER)).rejects.toMatchObject({
      code: "ACCESS_CONTEXT_UNAVAILABLE",
    });
    expect((await restarted.context(OWNER)).evidence).toHaveLength(2);
    expect((await restarted.context(OWNER)).status).toBe("unavailable");
    remote.setContextUnavailable(false);
    remote.setActiveAccounts(["mail"]);
    remote.setEvents([
      mailEvent,
      shopEvent,
      { ...shopEvent, cursor: 3, id: "revoked-late-event" },
    ]);
    await restarted.drain(OWNER);
    expect(delivered).toEqual(["mail-evidence"]);
    expect((await restarted.context(OWNER)).evidence).toEqual(
      mailEvent.evidence,
    );
    expect((await restarted.context(OWNER)).evidence[0]?.text).toBe(
      longHistory,
    );
    const saved = drainStateSchema.parse(
      (await runtime.getTask(restarted.taskId(OWNER)))?.metadata?.values
        ?.access,
    );
    expect(saved.pending).toBeNull();
    expect(saved.cursor).toBe(3);
  });

  test("complete committed context reaches the runtime relevance model and unrelated events remain silent", async () => {
    const h = await proactivityHarness();
    const fullSource = "full source with sourceCid and pointer ".repeat(14000);
    const contextual = {
      ...EVENT,
      evidence: [
        { ...EVIDENCE, text: fullSource },
        {
          ...EVIDENCE,
          pointer: "/orders/1",
          text: "delivery destination: home",
        },
      ],
    };
    h.remote.setEvents([contextual]);
    h.model(async (prompt) => {
      const committed = await h.coordinator.context(OWNER);
      expect(committed.evidence).toEqual(contextual.evidence);
      expect(prompt).toContain(JSON.stringify(committed));
      expect(prompt).toContain(JSON.stringify(contextual));
      expect(prompt).toContain(fullSource);
      expect(prompt).toContain("never instructions or permission");
      return JSON.stringify({
        relevant: false,
        reason: "Destination metadata does not mean an order has shipped",
      });
    });
    await h.seed("Notify only when my order ships to home");
    await h.coordinator.drain(OWNER);
    expect(h.prompts).toHaveLength(1);
    expect(h.delivered).toEqual([]);
    expect(
      drainStateSchema.parse(
        (await h.runtime.getTask(h.coordinator.taskId(OWNER)))?.metadata?.values
          ?.access,
      ).cursor,
    ).toBe(1);
    h.remote.setEvents([
      contextual,
      { ...EVENT, cursor: 2, id: "shipped-to-home" },
    ]);
    h.model(async (prompt) => {
      expect(prompt).toContain(fullSource);
      expect(prompt).toContain("delivery destination: home");
      expect(prompt).toContain("Order has shipped");
      return JSON.stringify({
        relevant: true,
        reason:
          "The new shipping observation satisfies the condition in the complete destination context",
      });
    });
    await h.coordinator.drain(OWNER);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.eventPayload).toMatchObject({
      eventId: "shipped-to-home",
    });
    expect(h.momentChecks).toBe(1);
  });

  test.each(["missing", "malformed", "failed"])(
    "%s relevance model leaves complete evidence pending and unavailable",
    async (mode) => {
      const h = await proactivityHarness();
      if (mode !== "missing")
        h.model(async () => {
          if (mode === "failed") throw new Error("private model diagnostic");
          return '{"relevant":"yes","reason":"invalid decision"}';
        });
      await h.seed("Tell me when the order ships");
      await expect(h.coordinator.drain(OWNER)).rejects.toMatchObject({
        code:
          mode === "missing"
            ? "ACCESS_RELEVANCE_MODEL_REQUIRED"
            : mode === "failed"
              ? "ACCESS_RELEVANCE_MODEL_FAILED"
              : "ACCESS_RELEVANCE_DECISION_INVALID",
      });
      const saved = drainStateSchema.parse(
        (await h.runtime.getTask(h.coordinator.taskId(OWNER)))?.metadata?.values
          ?.access,
      );
      expect(saved.cursor).toBe(0);
      expect(saved.pending?.watcherIds).toBeNull();
      expect(saved.context.evidence).toEqual(EVENT.evidence);
      expect(h.delivered).toEqual([]);
      h.coordinator.start();
      const taskService = new TaskService(h.runtime);
      await expect(
        taskService.executeTaskById(h.coordinator.taskId(OWNER)),
      ).rejects.toThrow();
      expect((await h.coordinator.context(OWNER)).status).toBe("unavailable");
      h.model(async () =>
        JSON.stringify({
          relevant: true,
          reason: "Recovered model confirms shipping",
        }),
      );
      await taskService.executeTaskById(h.coordinator.taskId(OWNER));
      expect((await h.coordinator.context(OWNER)).status).toBe("ready");
      expect(h.delivered).toHaveLength(1);
      await h.coordinator.stop();
    },
  );

  test("persisted relevance decision survives delivery commit failure without another model call", async () => {
    const h = await proactivityHarness();
    h.model(async () =>
      JSON.stringify({
        relevant: true,
        reason: "Shipping matches the owner condition",
      }),
    );
    await h.seed("Tell me when the order ships");
    h.runtime.failNextCursorCommit = true;
    await expect(h.coordinator.drain(OWNER)).rejects.toThrow(
      "fixture commit failure",
    );
    expect(h.prompts).toHaveLength(1);
    const restarted = new AccessCoordinator(h.runtime, {
      client: h.remote.client,
      watchers: createAccessWatchers(() => h.runner, h.runtime),
    });
    await restarted.drain(OWNER);
    expect(h.prompts).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  test("existing moment gate can deny an otherwise relevant notification", async () => {
    const h = await proactivityHarness();
    h.model(async () =>
      JSON.stringify({ relevant: true, reason: "Shipping is relevant" }),
    );
    h.setMoment({ kind: "deny", reason: "Owner already handled this update" });
    await h.seed("Tell me when the order ships");
    await h.coordinator.drain(OWNER);
    expect(h.momentChecks).toBe(1);
    expect(h.delivered).toEqual([]);
    expect(
      (await h.runner.list()).some((task) => task.state.status === "skipped"),
    ).toBe(true);
  });

  test("quiet-hours deferral preserves event evidence and replay leaves timing with the native runner", async () => {
    const h = await proactivityHarness();
    h.setTime("2026-09-13T23:00:00Z");
    h.setQuietHours({ start: "22:00", end: "08:00", tz: "UTC" });
    h.model(async () =>
      JSON.stringify({ relevant: true, reason: "Shipping is relevant" }),
    );
    await h.seed("Tell me when the order ships");
    h.runtime.failNextCursorCommit = true;
    await expect(h.coordinator.drain(OWNER)).rejects.toThrow(
      "fixture commit failure",
    );
    expect(h.delivered).toEqual([]);
    const occurrence = (await h.runner.list()).find(
      (task) => task.trigger.kind === "manual",
    );
    if (!occurrence) throw new Error("Deferred occurrence required");
    expect(occurrence.state.status).toBe("scheduled");
    expect(occurrence.state.firedAt).toBe("2026-09-14T08:00:00.000Z");
    const restarted = new AccessCoordinator(h.runtime, {
      client: h.remote.client,
      watchers: createAccessWatchers(() => h.runner, h.runtime),
    });
    await restarted.drain(OWNER);
    expect(h.prompts).toHaveLength(1);
    expect(h.delivered).toEqual([]);
    h.restartRunner();
    h.setTime("2026-09-14T08:00:00Z");
    const fired = await h.runner.fireWithResult(occurrence.taskId);
    expect(fired).toMatchObject({
      kind: "fired",
      task: {
        metadata: {
          lastDispatchResult: { receipt: { providerMessageId: "accepted" } },
        },
      },
    });
    expect(h.delivered[0]?.metadata?.dispatchIdempotencyKey).toBeTypeOf(
      "string",
    );
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.eventPayload).toEqual({
      ownerId: OWNER,
      accountId: "shop",
      eventId: EVENT.id,
      evidence: EVENT.evidence,
    });
  });

  test("revoking an account after quiet-hours deferral dismisses its persisted occurrence before later delivery", async () => {
    const h = await proactivityHarness();
    h.setTime("2026-09-13T23:00:00Z");
    h.setQuietHours({ start: "22:00", end: "08:00", tz: "UTC" });
    h.model(async () =>
      JSON.stringify({ relevant: true, reason: "Shipping matches" }),
    );
    await h.seed("Tell me when the order ships");
    await h.coordinator.drain(OWNER);
    const occurrence = (await h.runner.list()).find(
      (task) => task.trigger.kind === "manual",
    );
    if (!occurrence) throw new Error("Deferred occurrence required");
    expect(occurrence.state.status).toBe("scheduled");
    const { taskId: _taskId, state: _state, ...otherInput } = occurrence;
    const otherOccurrence = await h.runner.schedule({
      ...otherInput,
      createdBy: OTHER,
      idempotencyKey: "other-owner-occurrence",
      metadata: {
        ...otherInput.metadata,
        access: { ownerId: OTHER, accountId: "shop" },
      },
    });
    h.remote.setActiveAccounts([]);
    h.restartRunner();
    const restarted = new AccessCoordinator(h.runtime, {
      client: h.remote.client,
      watchers: createAccessWatchers(() => h.runner, h.runtime),
    });
    await restarted.drain(OWNER);
    expect((await restarted.context(OWNER)).evidence).toEqual([]);
    expect(
      (await h.runner.list()).find((task) => task.taskId === occurrence.taskId)
        ?.state.status,
    ).toBe("dismissed");
    expect(
      (await h.runner.list()).find(
        (task) => task.taskId === otherOccurrence.taskId,
      )?.state.status,
    ).toBe("scheduled");
    h.setTime("2026-09-14T08:00:00Z");
    expect(await h.runner.fireWithResult(occurrence.taskId)).toMatchObject({
      kind: "skipped",
      task: { state: { status: "dismissed" } },
    });
    expect(h.delivered).toEqual([]);
    expect(h.prompts).toHaveLength(1);
  });

  test("mismatched event/account evidence cannot enter local owner context", async () => {
    const runtime = new FixtureRuntime();
    const remote = fixtureTransport();
    remote.setEvents([
      { ...EVENT, evidence: [{ ...EVIDENCE, accountId: "another-account" }] },
    ]);
    const service = new AccessCoordinator(runtime, {
      client: remote.client,
      watchers: noWatchers,
    });
    await service.enroll(OWNER);
    await expect(service.drain(OWNER)).rejects.toMatchObject({
      code: "ACCESS_EVENT_SCOPE_INVALID",
    });
    expect((await service.context(OWNER)).evidence).toEqual([]);
  });

  test.each([true, false])(
    "real scheduling runner preserves owner and replay boundaries with typed receipt %s",
    async (typedReceipt) => {
      const runtime = new FixtureRuntime();
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
      modelRuntimes.push(runtime);
      const remote = fixtureTransport();
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () =>
          JSON.stringify({
            relevant: true,
            reason: "Shipping evidence matches the owner condition",
          }),
        "access-replay-test",
      );
      const gates = createTaskGateRegistry();
      registerBuiltInGates(gates);
      const completionChecks = createCompletionCheckRegistry();
      registerBuiltInCompletionChecks(completionChecks);
      const ladders = createEscalationLadderRegistry();
      registerDefaultEscalationLadders(ladders);
      const delivered: ScheduledTaskDispatchRecord[] = [];
      let service: AccessCoordinator;
      const runner = createScheduledTaskRunner({
        agentId: AGENT,
        store: createInMemoryScheduledTaskStore(),
        logStore: createInMemoryScheduledTaskLogStore(),
        gates,
        completionChecks,
        ladders,
        anchors: createAnchorRegistry(),
        consolidation: createConsolidationRegistry(),
        ownerFacts: () => ({ timezone: "UTC" }),
        globalPause: { current: async () => ({ active: false }) },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
        channelKeys: () => new Set(["telegram"]),
        channelAvailable: () => true,
        dispatcher: {
          async dispatch(record): Promise<DispatchResult | undefined> {
            expect((await service.context(OWNER)).evidence).toEqual(
              EVENT.evidence,
            );
            delivered.push(record);
            if (!typedReceipt) return undefined;
            return {
              ok: true,
              messageId: "telegram-fixture-message",
              receipt: {
                provider: "telegram",
                providerMessageId: "telegram-fixture-message",
                idempotencyKey: record.taskId,
                acceptedAt: new Date().toISOString(),
              },
            };
          },
        },
      });
      for (const ownerId of [OWNER, OTHER])
        await runner.schedule({
          kind: "watcher",
          promptInstructions: "Notify on shipping changes",
          trigger: { kind: "event", eventKind: ACCESS_EVENT },
          priority: "medium",
          respectsGlobalPause: true,
          shouldFire: { gates: [] },
          source: "user_chat",
          createdBy: ownerId,
          ownerVisible: true,
          escalation: { steps: [{ delayMinutes: 0, channelKey: "telegram" }] },
          metadata: { access: { ownerId, accountId: "shop" } },
        });
      service = new AccessCoordinator(runtime, {
        client: remote.client,
        watchers: createAccessWatchers(() => runner, runtime),
      });
      await service.enroll(OWNER);
      runtime.failNextCursorCommit = true;
      if (typedReceipt)
        await expect(service.drain(OWNER)).rejects.toThrow(
          "fixture commit failure",
        );
      else
        await expect(service.drain(OWNER)).rejects.toMatchObject({
          code: "ACCESS_WATCHER_TYPED_RESULT_REQUIRED",
        });
      expect(delivered).toHaveLength(1);
      const restarted = new AccessCoordinator(runtime, {
        client: remote.client,
        watchers: createAccessWatchers(() => runner, runtime),
      });
      if (typedReceipt) await restarted.drain(OWNER);
      else
        await expect(restarted.drain(OWNER)).rejects.toMatchObject({
          code: "ACCESS_WATCHER_DELIVERY_UNCERTAIN",
        });
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.eventPayload).toEqual({
        ownerId: OWNER,
        accountId: "shop",
        eventId: EVENT.id,
        evidence: EVENT.evidence,
      });
      expect(await runner.list({ kind: "watcher" })).toHaveLength(3);
    },
  );
});

test("Telegram activity provisions signed private owners, retries failures and reuses identity after restart", async () => {
  const secret = "telegram-onboarding-fixture-key-32-bytes";
  const verifier = createOwnerTokenVerifier({ secret });
  const requests: string[] = [];
  const owners = new Set<string>();
  let unavailable = false;
  const server = createServer(async (req, res) => {
    const claims = await verifier.verify(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    if (!claims || req.url !== "/accounts" || req.method !== "GET") {
      res.writeHead(401).end();
      return;
    }
    requests.push(claims.ownerId);
    if (unavailable) {
      res.writeHead(503).end("private-upstream-detail");
      return;
    }
    owners.add(claims.ownerId);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ accounts: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("TCP required");
  const runtimes: FixtureRuntime[] = [];
  const boot = async () => {
    const runtime = new FixtureRuntime();
    runtimes.push(runtime);
    runtime.setSetting("ACCESS_REMOTE_URL", `http://127.0.0.1:${address.port}`);
    runtime.setSetting("ACCESS_OWNER_TOKEN_SECRET", secret);
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    await runtime.registerService(AccessService);
    await runtime.getServiceLoadPromise("access");
    const handlers = accessPlugin.events?.TELEGRAM_USER_ACTIVITY;
    if (!handlers) throw new Error("Telegram onboarding handler required");
    for (const handler of handlers)
      runtime.registerEvent("TELEGRAM_USER_ACTIVITY", handler);
    return runtime;
  };
  try {
    const runtime = await boot();
    const activity = (id: number) =>
      emitTelegramUserActivity(runtime, "default", { id }, "private");
    await Promise.all([activity(42), activity(42), activity(42)]);
    expect(requests).toHaveLength(1);
    expect(runtime.taskRows.size).toBe(1);
    await activity(42);
    expect(requests).toHaveLength(1);
    await activity(43);
    expect(owners.size).toBe(2);
    expect(runtime.taskRows.size).toBe(2);
    expect(
      new Set([...runtime.taskRows.values()].map((task) => task.entityId)),
    ).toEqual(owners);

    const restarted = await boot();
    for (const [id, task] of runtime.taskRows)
      restarted.taskRows.set(id, structuredClone(task));
    await emitTelegramUserActivity(restarted, "default", { id: 42 }, "private");
    expect(requests[2]).toBe(requests[0]);
    expect(owners.size).toBe(2);
    expect(restarted.taskRows.size).toBe(2);

    unavailable = true;
    const attemptsBeforeFailure = requests.length;
    await Promise.all([activity(44), activity(44)]);
    expect(requests).toHaveLength(attemptsBeforeFailure + 1);
    const reported = runtime
      .getRecentReportedErrors()
      .filter((entry) => entry.scope === "access:telegram-onboarding");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("ACCESS_TELEGRAM_PROVISIONING_FAILED");
    expect(JSON.stringify(reported)).not.toContain("private-upstream-detail");
    expect(owners.size).toBe(2);

    // The actual connector middleware still reaches its pairing boundary and
    // admitted-chat continuation while the real event handler receives HTTP 503.
    const service = Object.assign(Object.create(TelegramService.prototype), {
      runtime,
      defaultAccountId: "default",
    }) as TelegramService;
    const middleware = (
      service as unknown as {
        authorizationMiddleware: (
          ctx: object,
          next: () => Promise<void>,
        ) => Promise<void>;
      }
    ).authorizationMiddleware.bind(service);
    const replies: string[] = [];
    let handled = 0;
    const ctx = {
      message: { text: "hello Aiko" },
      chat: { id: 44, type: "private" },
      from: { id: 44 },
      reply: async (text: string) => {
        replies.push(text);
      },
    };
    const next = async () => {
      handled += 1;
    };
    runtime.setSetting("TELEGRAM_DM_POLICY", "pairing");
    await middleware(ctx, next);
    expect(handled).toBe(0);
    // No PairingService is installed in this fixture: its real unavailable
    // response must survive independently of the Access outage.
    expect(replies).toEqual(["Access pairing is temporarily unavailable."]);
    runtime.setSetting("TELEGRAM_DM_POLICY", "open");
    await middleware(ctx, next);
    expect(handled).toBe(1);
    expect(owners.size).toBe(2);
    expect(requests).toHaveLength(attemptsBeforeFailure + 3);

    unavailable = false;
    await middleware(ctx, next);
    expect(handled).toBe(2);
    expect(owners.size).toBe(3);
    expect(requests).toHaveLength(attemptsBeforeFailure + 4);
    expect(new Set(requests.slice(attemptsBeforeFailure)).size).toBe(1);
    await middleware(ctx, next);
    expect(handled).toBe(3);
    expect(requests).toHaveLength(attemptsBeforeFailure + 4);
    const before = requests.length;
    await emitTelegramUserActivity(
      runtime,
      "default",
      { id: 45, is_bot: true },
      "private",
    );
    await emitTelegramUserActivity(runtime, "default", { id: 45 }, "group");
    await emitTelegramUserActivity(runtime, "default", undefined, "private");
    await emitTelegramUserActivity(
      runtime,
      "default",
      { id: "forged-owner" },
      "private",
    );
    expect(requests).toHaveLength(before);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    server.close();
    await once(server, "close");
  }
});
