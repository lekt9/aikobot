/**
 * Turn runner contract on the genuine edge AgentRuntime: a plain reply, a read
 * action, and a state-changing action run through journaled boundaries, and
 * a replay of the same turn from its recorded journal performs no external
 * calls. The model, todo store, and delivery are deterministic fakes; the
 * pipeline is real.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/edge";
import type { Event } from "tardie/core/event";
import { turnOutputDelivery } from "../src/delivery";
import { journalFromLog } from "../src/journal";
import {
  type ElizaTurnConfig,
  type ElizaTurnRequest,
  runElizaTurn,
  TARDIGRADE_TURN_MODEL_FAILED,
  TARDIGRADE_TURN_REPLY_INVALID,
} from "../src/turn";
import {
  memoryTodoStore,
  recordingDeliveryPort,
  type ScriptedModelPort,
  scriptedModelPort,
  testPlugins,
} from "./support";

const AGENT = "tardigrade-test-agent";

function turnRequest(
  log: Event[],
  overrides: Partial<ElizaTurnRequest> & { turn: string; text: string },
): ElizaTurnRequest {
  return {
    epoch: 0,
    owner: "owner-1",
    sender: "owner-1",
    source: "tardigrade-test",
    roomKey: "thread-1",
    history: [],
    tasks: [],
    journal: journalFromLog(log, overrides.turn, overrides.epoch ?? 0),
    append: async (events) => {
      log.push(...events);
    },
    ...overrides,
  };
}

function configWith(
  model: ScriptedModelPort,
  plugins = testPlugins(),
): ElizaTurnConfig & { plugins: typeof plugins.plugins } {
  return {
    agentKey: AGENT,
    character: {
      name: "Tardiza",
      system: "You are Tardiza, a concise assistant.",
    },
    plugins: plugins.plugins,
    model,
    delivery: turnOutputDelivery,
    host: { bindings: [], secrets: [] },
    now: () => 1_700_000_000_000,
  };
}

const boundaryTypes = (log: Event[]) =>
  log.map(
    (event) => `${event.type}:${(event as Record<string, unknown>).kind ?? ""}`,
  );

describe("runElizaTurn", () => {
  let model: ScriptedModelPort;
  beforeEach(() => {
    model = scriptedModelPort({ replyText: "Hello from Tardiza." });
  });

  test("a plain reply records its model boundary and delivery", async () => {
    const log: Event[] = [];
    const outcome = await runElizaTurn(
      configWith(model),
      turnRequest(log, { turn: "t1", text: "hi" }),
    );
    expect(outcome.reply).toBe("Hello from Tardiza.");
    expect(outcome.responded).toBe(true);
    expect(model.calls).toBeGreaterThanOrEqual(1);
    expect(outcome.stats.executed).toBe(model.calls + outcome.delivered.length);
    expect(outcome.stats.replayed).toBe(0);
    expect(
      boundaryTypes(log).filter((type) =>
        type.startsWith("ElizaBoundaryStarted"),
      ),
    ).toContain("ElizaBoundaryStarted:model");
    expect(boundaryTypes(log)).toContain("ElizaBoundaryRecorded:delivery");
    const recordedModel = log.find(
      (event) =>
        event.type === "ElizaBoundaryRecorded" &&
        (event as Record<string, unknown>).kind === "model",
    ) as Record<string, unknown>;
    const stored = recordedModel.result as {
      toolCalls: Array<{ name: string }>;
    };
    expect(stored.toolCalls[0]?.name).toBe("HANDLE_RESPONSE");
    const started = log.find(
      (event) => event.type === "ElizaBoundaryStarted",
    ) as Record<string, unknown>;
    expect(started.turn).toBe("t1");
    expect(String(started.key)).toBe("t1/0/model/0");
  });

  test("a read action and a state-changing action run through journaled boundaries", async () => {
    const plugins = testPlugins();
    model = scriptedModelPort((request) =>
      request.tools?.some((tool) => tool.name === "TODO") ||
      request.modelType === "ACTION_PLANNER"
        ? {
            candidateActionNames: ["TODO"],
            replyText: "",
            plans: [
              {
                action: "TODO",
                parameters: { action: "create", content: "buy milk" },
              },
            ],
            finishText: "Added buy milk to your list.",
          }
        : {
            candidateActionNames: ["TODO"],
            replyText: "",
            finishText: "Added buy milk to your list.",
          },
    );
    const log: Event[] = [];
    const outcome = await runElizaTurn(
      configWith(model, plugins),
      turnRequest(log, { turn: "t2", text: "add buy milk to my todos" }),
    );
    expect(plugins.store.todos.map((todo) => todo.content)).toEqual([
      "buy milk",
    ]);
    expect(plugins.store.applied).toHaveLength(1);
    expect(
      outcome.actionResults.some(
        (result) => result.data?.actionName === "TODO" || result.success,
      ),
    ).toBe(true);
    expect(outcome.reply.length).toBeGreaterThan(0);
    const actionStart = log.find(
      (event) =>
        event.type === "ElizaBoundaryStarted" &&
        (event as Record<string, unknown>).kind === "action",
    ) as Record<string, unknown>;
    expect(actionStart.name).toBe("TODO");
    expect(actionStart.policy).toBe("idempotent");
    expect(boundaryTypes(log)).toContain("ElizaBoundaryRecorded:action");

    const searchModel = scriptedModelPort({
      candidateActionNames: ["WEB_SEARCH"],
      contexts: ["web"],
      replyText: "",
      plans: [
        { action: "WEB_SEARCH", parameters: { query: "latest elizaOS news" } },
      ],
      finishText: "A new elizaOS release was announced today.",
    });
    const searchLog: Event[] = [];
    const searched = await runElizaTurn(
      configWith(searchModel, plugins),
      turnRequest(searchLog, {
        turn: "t3",
        text: "what is the latest elizaOS news?",
      }),
    );
    expect(plugins.searches).toEqual(["latest elizaOS news"]);
    expect(searched.reply).toContain("elizaOS release");
    const searchStart = searchLog.find(
      (event) =>
        event.type === "ElizaBoundaryStarted" &&
        (event as Record<string, unknown>).kind === "action",
    ) as Record<string, unknown>;
    expect(searchStart.name).toBe("WEB_SEARCH");
    expect(searchStart.policy).toBe("read");
  });

  test("replaying a recorded turn performs zero external calls and yields the same reply", async () => {
    const plugins = testPlugins();
    const script = {
      candidateActionNames: ["TODO"],
      replyText: "",
      plans: [
        {
          action: "TODO",
          parameters: { action: "create", content: "call mom" },
        },
      ],
      finishText: "Added call mom to your list.",
    };
    model = scriptedModelPort(script);
    const delivery = recordingDeliveryPort();
    const log: Event[] = [];
    const config = { ...configWith(model, plugins), delivery };
    const first = await runElizaTurn(
      config,
      turnRequest(log, { turn: "t4", text: "remind me to call mom" }),
    );
    expect(plugins.store.applied).toHaveLength(1);
    expect(delivery.deliveries).toHaveLength(1);
    const liveCalls = model.calls;

    const replayModel = scriptedModelPort(script);
    const replayStore = memoryTodoStore();
    const replayPlugins = testPlugins({ store: replayStore });
    const replayLog = [...log];
    const appended: Event[] = [];
    const replayed = await runElizaTurn(
      { ...configWith(replayModel, replayPlugins), delivery },
      {
        ...turnRequest(replayLog, {
          turn: "t4",
          text: "remind me to call mom",
        }),
        append: async (events) => {
          appended.push(...events);
        },
      },
    );
    expect(replayModel.calls).toBe(0);
    expect(replayStore.applied).toHaveLength(0);
    expect(delivery.deliveries).toHaveLength(1);
    expect(replayed.reply).toBe(first.reply);
    expect(replayed.stats.executed).toBe(0);
    expect(replayed.stats.replayed).toBe(liveCalls + 1 + 1);
    expect(replayed.diverged).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("a turn whose model boundary failed ends failed even though Eliza delivered an apology", async () => {
    model = scriptedModelPort({ replyText: "Sorry, I hit a problem." });
    model.failNext(new Error("upstream 503"));
    const log: Event[] = [];
    const failure = await runElizaTurn(
      configWith(model),
      turnRequest(log, { turn: "t5", text: "hello" }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(TARDIGRADE_TURN_MODEL_FAILED);
    const failedModel = log.filter(
      (event) =>
        event.type === "ElizaBoundaryRecorded" &&
        (event as Record<string, unknown>).kind === "model" &&
        (event as Record<string, unknown>).outcome === "failed",
    );
    expect(failedModel).toHaveLength(1);
    expect(String((failedModel[0] as Record<string, unknown>).error)).toContain(
      "upstream 503",
    );
    expect(
      log.some(
        (event) =>
          event.type === "ElizaBoundaryRecorded" &&
          (event as Record<string, unknown>).kind === "delivery",
      ),
    ).toBe(true);
    expect((failure as ElizaError).context?.reply).toBeDefined();
  });

  test("a reply made of provider control-token markup is refused and the turn fails with the action result preserved", async () => {
    const plugins = testPlugins();
    model = scriptedModelPort({
      candidateActionNames: ["TODO"],
      replyText: "",
      plans: [
        {
          action: "TODO",
          parameters: { action: "create", content: "feed the cat" },
        },
      ],
      finishText:
        '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="TODO">\n</｜｜DSML｜｜ calls>',
    });
    const delivery = recordingDeliveryPort();
    const log: Event[] = [];
    const failure = await runElizaTurn(
      { ...configWith(model, plugins), delivery },
      turnRequest(log, { turn: "t6", text: "add feed the cat to my list" }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(TARDIGRADE_TURN_REPLY_INVALID);
    expect(plugins.store.todos.map((todo) => todo.content)).toEqual([
      "feed the cat",
    ]);
    expect(delivery.deliveries).toHaveLength(0);
    const refusedDelivery = log.find(
      (event) =>
        event.type === "ElizaBoundaryRecorded" &&
        (event as Record<string, unknown>).kind === "delivery" &&
        (event as Record<string, unknown>).outcome === "failed",
    ) as Record<string, unknown> | undefined;
    expect(String(refusedDelivery?.error)).toContain("control tokens");
    const context = (failure as ElizaError).context as {
      actionResults: Array<{ success: boolean }>;
    };
    expect(context.actionResults.some((result) => result.success)).toBe(true);
  });
});
