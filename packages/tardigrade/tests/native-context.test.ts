/**
 * The two context contracts of the native composition, checked against
 * Tardigrade's own renderer rather than against our belief about it.
 *
 * Model-facing content is never shortened: a package result far past the
 * default 6,000-character render cap reaches the model whole, and the same
 * trajectory rendered under the default policy is truncated — the positive
 * control that proves this check can fail.
 *
 * Provider context is composed once per turn, before the first model call,
 * and its complete text appears in the system prompt the binding receives.
 */

import { describe, expect, test } from "bun:test";
import type { Action, Character, Plugin } from "@elizaos/core/edge";
import { Effect, Layer } from "effect";
import { type AgentMessage, Infer, renderMessages } from "tardie/agent";
import type { Event } from "tardie/core/event";
import { createHost } from "tardie/host/memory/host";
import { declarePlugin } from "../src/compatibility";
import { ElizaOwner } from "../src/hosts/identity";
import { elizaNativeActor } from "../src/native/actor";
import { LOSSLESS_RENDER_CAP } from "../src/native/context";
import { nativeOwnerBuild } from "../src/native/owner";
import { bunOwnerRegistry } from "../src/owner/bun";
import { OwnerRuntimePort } from "../src/owner/port";
import { testStorageDir } from "./support";

const PAYLOAD = "the-owner's-ledger ".repeat(1200); // ~22k chars, far past 6k
const AGENT_KEY = "eliza-native-context";
const character: Character = {
  name: "Eliza",
  bio: ["reads long records"],
  system: "Answer from the record.",
};

const bigAction: Action = {
  name: "BIG_RECORD",
  description: "Return the owner's complete record.",
  tags: ["capability:read"],
  validate: async () => true,
  handler: async () => ({
    success: true,
    text: PAYLOAD,
    values: { length: PAYLOAD.length },
  }),
  examples: [],
};

const bigPlugin: Plugin = {
  name: "@elizaos/plugin-record",
  description: "One long record.",
  actions: [bigAction],
};

const declared = [
  declarePlugin(bigPlugin, {
    target: "edge",
    state: "none",
    effects: ["record-read"],
    requiredBindings: [],
    requiredSecrets: [],
    effectPolicies: { BIG_RECORD: "read" },
  }),
];

interface Captured {
  readonly trajectory: ReadonlyArray<Event>;
  readonly system: string;
  readonly context: Record<string, number> | undefined;
}

async function runBigRecordTurn(): Promise<{
  readonly events: ReadonlyArray<Event>;
  readonly captured: ReadonlyArray<Captured>;
}> {
  const registry = bunOwnerRegistry({
    dir: testStorageDir("native-context"),
    build: nativeOwnerBuild({
      agentKey: AGENT_KEY,
      character,
      plugins: () => declared,
    }),
  });
  const actor = elizaNativeActor({ character, plugins: declared });
  const captured: Captured[] = [];
  let step = 0;
  const scripted = {
    resolve: () => ({ model: { provider: "test", model_id: "scripted" } }),
    react: (request: {
      trajectory: ReadonlyArray<Event>;
      system: string;
      context?: Record<string, number>;
    }) =>
      Effect.sync(() => {
        captured.push({
          trajectory: request.trajectory,
          system: request.system,
          context: request.context,
        });
        step += 1;
        if (step === 1) {
          return {
            kind: "calls" as const,
            calls: [
              {
                callId: "call-1",
                name: "execute",
                arguments: {
                  code: "const value = await record.bigRecord({}); return value",
                  summary: "read the record",
                },
              },
            ] as const,
          };
        }
        return { kind: "complete" as const, output: "Read it." };
      }),
  };
  const host = createHost({
    actorName: "eliza",
    actorInstance: "alice",
    actorFor: () => actor as never,
    keyOf: (actor as unknown as { keyOf: (event: Event) => string | undefined })
      .keyOf,
    layersFor: () =>
      Layer.mergeAll(
        Layer.succeed(Infer, scripted as never),
        Layer.succeed(ElizaOwner, { owner: "alice", scoped: true }),
        Layer.succeed(OwnerRuntimePort, registry.portFor("alice")),
      ) as never,
  });
  try {
    await host.commitRoot(host.self("main"), {
      type: "MessageReceived",
      id: "big-1",
      text: "Read my record",
      input: { owner: "alice", sender: "alice", source: "test" },
      at: 1000,
    } as unknown as Event);
    await host.drive();
    return { events: host.read("main"), captured };
  } finally {
    await registry.close();
  }
}

const toolContent = (messages: ReadonlyArray<AgentMessage>): string =>
  messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""))
    .join("\n");

describe("native context is lossless", () => {
  test("a result far past the default cap reaches the model whole, and the default policy would truncate it", async () => {
    const { events, captured } = await runBigRecordTurn();
    expect(events.map((event) => event.type)).toContain("TurnCompleted");

    // The engine told its binding not to cut anything.
    const policy = captured.at(-1)?.context;
    expect(policy?.resultRenderCap).toBe(LOSSLESS_RENDER_CAP);
    expect(policy?.messageRenderCap).toBe(LOSSLESS_RENDER_CAP);

    // The code execution really ran the action, and the durable events hold
    // the whole value rather than a spill pointer.
    const settled = events.find(
      (event) => event.type === "CodeSettled",
    ) as unknown as { error?: string } | undefined;
    expect(settled?.error).toBeUndefined();
    const returned = events.find(
      (event) => event.type === "ToolReturned",
    ) as unknown as { result?: { tmp?: string } } | undefined;
    expect(JSON.stringify(returned?.result ?? {})).toContain(
      PAYLOAD.slice(0, 64),
    );
    expect(returned?.result?.tmp).toBeUndefined();

    // Rendered under this agent's policy, the model sees every character.
    const trajectory = captured.at(-1)?.trajectory ?? [];
    const lossless = renderMessages(trajectory, policy ?? {});
    const losslessTool = toolContent(lossless);
    expect(losslessTool).toContain(PAYLOAD);
    expect(losslessTool).not.toContain("[truncated at");

    // Positive control: the same trajectory under the default policy is cut,
    // so the assertion above is measuring something real.
    const defaulted = toolContent(renderMessages(trajectory, {}));
    expect(defaulted).toContain("[truncated at");
    expect(defaulted).not.toContain(PAYLOAD);
  }, 60_000);

  test("provider context is composed once, before the model call, and reaches the system prompt whole", async () => {
    const { events, captured } = await runBigRecordTurn();
    const composed = events.filter(
      (event) => event.type === "ElizaContextComposed",
    ) as unknown as Array<{ text: string; providers: string[] }>;
    expect(composed).toHaveLength(1);
    const order = events.map((event) => event.type);
    expect(order.indexOf("ElizaContextComposed")).toBeLessThan(
      order.indexOf("ModelCalled"),
    );
    const system = captured.at(0)?.system ?? "";
    expect(system).toContain("Answer from the record.");
    if (composed[0] !== undefined && composed[0].text.length > 0) {
      expect(system).toContain(composed[0].text);
    }
  }, 60_000);
});
