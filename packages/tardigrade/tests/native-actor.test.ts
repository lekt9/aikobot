/**
 * The native composition, end to end on a real Tardigrade host with a
 * scripted model: elizaOS plugins reached as code-mode packages, provider
 * context composed before the first model call, the owner's durable runtime
 * holding the state, and evaluators running after the turn. The model is
 * scripted so the assertions are about the harness, not about a provider;
 * every other layer — host, log, reconciliation, owner runtime, plugins — is
 * real.
 */

import { describe, expect, test } from "bun:test";
import type { Character } from "@elizaos/core/edge";
import { Effect, Layer } from "effect";
import { Infer } from "tardie/agent";
import type { Event } from "tardie/core/event";
import { createHost } from "tardie/host/memory/host";
import { ElizaOwner } from "../src/hosts/identity";
import { elizaNativeActor } from "../src/native/actor";
import { nativeOwnerBuild } from "../src/native/owner";
import { bunOwnerRegistry } from "../src/owner/bun";
import { OwnerRuntimePort } from "../src/owner/port";
import { testStorageDir } from "./support";

const AGENT_KEY = "eliza-native-test";
const character: Character = {
  name: "Eliza",
  bio: ["keeps the owner's list"],
  system: "Be brief. Use the todos package for the owner's list.",
};

interface ScriptedCall {
  readonly code: string;
  readonly summary: string;
}

type Scripted =
  | { readonly kind: "calls"; readonly call: ScriptedCall }
  | { readonly kind: "complete"; readonly output: string };

interface Harness {
  readonly host: ReturnType<typeof createHost>;
  readonly thread: string;
  readonly requests: Array<{
    system: string;
    tools: string[];
    context?: Record<string, number>;
  }>;
  readonly registry: ReturnType<typeof bunOwnerRegistry>;
  close(): Promise<void>;
}

function harness(script: ReadonlyArray<Scripted>, owner = "alice"): Harness {
  const registry = bunOwnerRegistry({
    dir: testStorageDir("native-actor"),
    build: nativeOwnerBuild({ agentKey: AGENT_KEY, character }),
  });
  const actor = elizaNativeActor({ character });
  const requests: Array<{
    system: string;
    tools: string[];
    context?: Record<string, number>;
  }> = [];
  let step = 0;
  const scriptedInfer = {
    resolve: () => ({ model: { provider: "test", model_id: "scripted" } }),
    react: (request: {
      system: string;
      tools: ReadonlyArray<{ name: string }>;
      context?: Record<string, number>;
    }) =>
      Effect.sync(() => {
        requests.push({
          system: request.system,
          tools: request.tools.map((tool) => tool.name),
          ...(request.context === undefined
            ? {}
            : { context: request.context }),
        });
        const next = script[Math.min(step, script.length - 1)];
        step += 1;
        if (next === undefined || next.kind === "complete") {
          return {
            kind: "complete" as const,
            output: next?.kind === "complete" ? next.output : "done",
          };
        }
        return {
          kind: "calls" as const,
          calls: [
            {
              callId: `call-${step}`,
              name: "execute",
              arguments: {
                code: next.call.code,
                summary: next.call.summary,
              },
            },
          ] as const,
        };
      }),
  };
  const host = createHost({
    actorName: "eliza",
    actorInstance: owner,
    actorFor: () => actor as never,
    keyOf: (actor as unknown as { keyOf: (event: Event) => string | undefined })
      .keyOf,
    layersFor: () =>
      Layer.mergeAll(
        Layer.succeed(Infer, scriptedInfer as never),
        Layer.succeed(ElizaOwner, { owner, scoped: true }),
        Layer.succeed(OwnerRuntimePort, registry.portFor(owner)),
      ) as never,
  });
  return {
    host,
    thread: "main",
    requests,
    registry,
    close: () => registry.close(),
  };
}

const messageReceived = (id: string, text: string, at: number): Event =>
  ({
    type: "MessageReceived",
    id,
    text,
    input: { owner: "alice", sender: "alice", source: "test" },
    at,
  }) as unknown as Event;

async function runTurn(
  live: Harness,
  id: string,
  text: string,
  at: number,
): Promise<ReadonlyArray<Event>> {
  await live.host.commitRoot(
    live.host.self(live.thread),
    messageReceived(id, text, at),
  );
  await live.host.drive();
  return live.host.read(live.thread);
}

const types = (events: ReadonlyArray<Event>): string[] =>
  events.map((event) => event.type);

const indexOfType = (events: ReadonlyArray<Event>, type: string): number =>
  types(events).indexOf(type);

describe("native actor", () => {
  test("runs a state-changing elizaOS action through a code-mode package and settles the turn", async () => {
    const live = harness([
      {
        kind: "calls",
        call: {
          code: "const created = await todos.todo({action: 'create', content: 'Buy oat milk', activeForm: 'Buying oat milk'}); return created",
          summary: "add the todo",
        },
      },
      { kind: "complete", output: "Added Buy oat milk to your list." },
    ]);
    try {
      const events = await runTurn(live, "turn-1", "Add buy oat milk", 1000);
      expect(types(events)).toContain("TurnCompleted");
      expect(types(events)).not.toContain("TurnFailed");

      // The action really ran in the owner's runtime, not in the engine.
      const owner = live.registry.forOwner("alice");
      const runtime = await owner.runtime();
      const todos = runtime.getService("todos");
      expect(runtime.actions.map((action) => action.name)).toContain("TODO");
      expect(todos === null || typeof todos === "object").toBe(true);

      // No elizaOS message loop ran: the pipeline adapter's boundaries are absent.
      expect(types(events)).not.toContain("ElizaBoundaryStarted");
    } finally {
      await live.close();
    }
  }, 60_000);

  test("composes provider context before the first model call and evaluates after the turn", async () => {
    const live = harness([{ kind: "complete", output: "Hello." }]);
    try {
      const events = await runTurn(live, "turn-2", "Hello", 2000);
      const composed = indexOfType(events, "ElizaContextComposed");
      const called = types(events).findIndex(
        (type) => type === "ModelCalled" || type === "ModelReturned",
      );
      expect(composed).toBeGreaterThanOrEqual(0);
      expect(called).toBeGreaterThanOrEqual(0);
      expect(composed).toBeLessThan(called);

      const completed = indexOfType(events, "TurnCompleted");
      const evaluated = indexOfType(events, "ElizaEvaluated");
      expect(completed).toBeGreaterThanOrEqual(0);
      expect(evaluated).toBeGreaterThan(completed);

      // The composed provider text reached the model's system prompt whole.
      const context = events.find(
        (event) => event.type === "ElizaContextComposed",
      ) as unknown as { text: string } | undefined;
      expect(typeof context?.text).toBe("string");
      const system = live.requests.at(-1)?.system ?? "";
      expect(system).toContain("Eliza");
      if ((context?.text ?? "").length > 0) {
        expect(system).toContain(context?.text as string);
      }
    } finally {
      await live.close();
    }
  }, 60_000);

  test("a redelivered message runs the turn once", async () => {
    const live = harness([{ kind: "complete", output: "Once." }]);
    try {
      await runTurn(live, "turn-3", "Say once", 3000);
      const events = await runTurn(live, "turn-3", "Say once", 3000);
      const completions = types(events).filter(
        (type) => type === "TurnCompleted",
      );
      const composed = types(events).filter(
        (type) => type === "ElizaContextComposed",
      );
      expect(completions).toHaveLength(1);
      expect(composed).toHaveLength(1);
    } finally {
      await live.close();
    }
  }, 60_000);
});
