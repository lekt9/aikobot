/**
 * Complete-context proof on the genuine pipeline: a long projected history
 * and a long current message reach the model verbatim and in order, a
 * registered provider's output is in the prompt, a registered evaluator runs
 * after the response, and actions execute — no window, cap, or summary.
 */

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@elizaos/core/edge";
import type { Event } from "tardie/core/event";
import { turnOutputDelivery } from "../src/delivery";
import type { TurnHistoryEntry } from "../src/history";
import { journalFromLog } from "../src/journal";
import { runElizaTurn } from "../src/turn";
import { scriptedModelPort, testPlugins } from "./support";

const PROVIDER_MARKER = "PROVIDER-MARKER-7f3c1a";

function observerPlugin(seen: {
  evaluations: number;
  providerCalls: number;
  processed: number;
}): Plugin {
  return {
    name: "context-observer",
    description: "Observes provider and evaluator participation.",
    providers: [
      {
        name: "CONTEXT_OBSERVER",
        description: "Emits a marker the prompt must carry.",
        alwaysInResponseState: true,
        get: async () => {
          seen.providerCalls += 1;
          return {
            text: `# Observer\n${PROVIDER_MARKER}`,
            values: {},
            data: {},
          };
        },
      },
    ],
    evaluators: [
      {
        name: "CONTEXT_OBSERVER_EVALUATOR",
        description: "Counts post-response evaluation.",
        schema: { type: "object", properties: { noted: { type: "boolean" } } },
        shouldRun: async () => {
          seen.evaluations += 1;
          return true;
        },
        prompt: () => 'Return {"noted": true}.',
        parse: () => ({ noted: true }),
        processors: [
          {
            name: "count",
            process: async () => {
              seen.processed += 1;
              return undefined;
            },
          },
        ],
      },
    ],
  };
}

describe("complete context", () => {
  test("long history and a long message reach the model verbatim with providers, actions, and evaluators live", async () => {
    const history: TurnHistoryEntry[] = [];
    const base = Date.now() - 200_000;
    for (let index = 0; index < 60; index += 1) {
      history.push({
        turn: `h-${index}`,
        text: `history user marker ${index} ${"filler ".repeat(40)}`.trim(),
        at: base + index * 1_000,
        output: `history assistant marker ${index}`,
        outputAt: base + index * 1_000 + 500,
      });
    }
    const currentMessage = `current message start ${"payload ".repeat(3_000)}current message end`;
    const seen = { evaluations: 0, providerCalls: 0, processed: 0 };
    const plugins = testPlugins();
    const model = scriptedModelPort({
      candidateActionNames: ["TODO"],
      contexts: ["simple"],
      replyText: "",
      plans: [
        {
          action: "TODO",
          parameters: { action: "create", content: "context check" },
        },
      ],
      finishText: "Done with the context check.",
    });
    const log: Event[] = [];
    const outcome = await runElizaTurn(
      {
        agentKey: "eliza-context",
        character: { name: "Tardiza", system: "You are Tardiza." },
        plugins: plugins.plugins,
        model,
        delivery: turnOutputDelivery,
        host: { bindings: [], secrets: [] },
        observers: [observerPlugin(seen)],
      },
      {
        turn: "current",
        epoch: 0,
        text: currentMessage,
        owner: "owner-1",
        sender: "owner-1",
        source: "context-test",
        roomKey: "thread",
        history,
        tasks: [],
        journal: journalFromLog(log, "current", 0),
        append: async (events) => {
          log.push(...events);
        },
      },
    );
    expect(outcome.reply).toBe("Done with the context check.");
    expect(plugins.store.todos.map((todo) => todo.content)).toEqual([
      "context check",
    ]);
    expect(seen.providerCalls).toBeGreaterThan(0);
    expect(seen.evaluations).toBeGreaterThan(0);

    const stageOne = model.requests[0];
    expect(stageOne.modelType).toBe("RESPONSE_HANDLER");
    const prompt = JSON.stringify(stageOne.messages);
    expect(prompt).toContain(PROVIDER_MARKER);
    expect(prompt).toContain(JSON.stringify(currentMessage).slice(1, -1));
    let cursor = -1;
    for (let index = 0; index < 60; index += 1) {
      const user = prompt.indexOf(`history user marker ${index} `);
      const assistant = prompt.indexOf(`history assistant marker ${index}`);
      expect(user).toBeGreaterThan(cursor);
      expect(assistant).toBeGreaterThan(user);
      cursor = assistant;
    }
    expect(prompt.indexOf("current message start")).toBeGreaterThan(cursor);
    const recordedModelInputs = log.filter(
      (event) =>
        event.type === "ElizaBoundaryRecorded" &&
        (event as Record<string, unknown>).kind === "model",
    );
    expect(recordedModelInputs.length).toBe(model.calls);
    expect(log.some((event) => event.type === "ElizaReplayDiverged")).toBe(
      false,
    );
  });
});
