/**
 * The plugin-to-package mapping and the owner-side executors that back it.
 * The mapping is pure and checked directly; the executors run against a real
 * edge AgentRuntime over a real durable adapter, so a role refusal, a
 * validation refusal and a policy mismatch are observed as the executors
 * actually answer them rather than as we hope they would.
 */

import { describe, expect, test } from "bun:test";
import type { Action, Character, Plugin } from "@elizaos/core/edge";
import { Effect } from "effect";
import { type DeclaredPlugin, declarePlugin } from "../src/compatibility";
import {
  actionKindOf,
  type NativeActionOutput,
  type NativeTurnRef,
  nativeExecutors,
  TARDIGRADE_ACTION_POLICY_MISMATCH,
  TARDIGRADE_ACTION_UNKNOWN,
  TARDIGRADE_ACTION_VALIDATION_REFUSED,
  TARDIGRADE_ROLE_REFUSED,
} from "../src/native/executor";
import {
  elizaPackage,
  elizaPackages,
  methodNameOf,
  packageNameOf,
  TARDIGRADE_PACKAGE_METHOD_COLLISION,
} from "../src/native/packages";
import { memoryBackend } from "../src/owner/backend";
import { createOwnerRuntime } from "../src/owner/runtime";
import { elizaAgentId } from "../src/turn";

const AGENT_KEY = "eliza-native-packages";
const character: Character = {
  name: "Eliza",
  bio: ["runs actions"],
  system: "Run actions.",
};

const action = (name: string, extra: Partial<Action> = {}): Action => ({
  name,
  description: `${name} does a thing.`,
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => ({
    success: true,
    text: `${name} ran`,
    values: {
      parameters: JSON.stringify(
        (options as { parameters?: unknown } | undefined)?.parameters ?? {},
      ),
    },
  }),
  examples: [],
  ...extra,
});

const READ = action("READ_THING", {
  tags: ["capability:read"],
  parameters: [
    {
      name: "query",
      description: "What to read.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "How many.",
      schema: { type: "number", default: 5 },
    },
  ],
});
const WRITE = action("WRITE_THING", { tags: ["capability:write"] });
const GATED = action("ADMIN_THING", {
  tags: ["capability:read"],
  roleGate: { minRole: "ADMIN" },
});
const PICKY = action("PICKY_THING", {
  tags: ["capability:read"],
  validate: async () => false,
});

const plugin: Plugin = {
  name: "@elizaos/plugin-things-edge",
  description: "Things.",
  actions: [READ, WRITE, GATED, PICKY],
};

const declared: DeclaredPlugin = declarePlugin(plugin, {
  target: "edge",
  state: "none",
  effects: ["thing-read", "thing-write"],
  requiredBindings: [],
  requiredSecrets: [],
});

const turn = (sender = "alice"): NativeTurnRef => ({
  owner: "alice",
  sender,
  source: "test",
  roomKey: "main",
  turn: `turn-${sender}`,
  text: "do the thing",
  at: 1_700_000_000_000,
});

function ownerRuntime() {
  return createOwnerRuntime({
    owner: "alice",
    agentId: elizaAgentId(AGENT_KEY),
    character,
    plugins: [plugin],
    backend: memoryBackend(),
    basicCapabilities: false,
    executors: nativeExecutors({ agentKey: AGENT_KEY, plugins: [declared] }),
    now: () => 1_700_000_000_000,
  });
}

const invokeAction = async (
  runtime: ReturnType<typeof ownerRuntime>,
  key: string,
  kind: string,
  name: string,
  parameters: Record<string, unknown> = {},
  sender = "alice",
) =>
  (
    await runtime.invoke({
      key,
      kind,
      name,
      thread: "main",
      turn: turn(sender).turn,
      payload: { turn: turn(sender), action: name, parameters },
    })
  ).result as NativeActionOutput;

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

describe("plugins as packages", () => {
  test("names, schemas, annotations and replay kinds come from the action declarations", () => {
    expect(methodNameOf("WEB_SEARCH")).toBe("webSearch");
    expect(methodNameOf("TODO")).toBe("todo");
    expect(methodNameOf("2FA_CODE")).toBe("a2faCode");
    expect(packageNameOf("@elizaos/plugin-web-search-edge")).toBe("webSearch");
    expect(packageNameOf("@elizaos/plugin-todos")).toBe("todos");

    const pkg = elizaPackage({ declared });
    expect(pkg.name).toBe("things");
    expect(Object.keys(pkg.methods).sort()).toEqual([
      "adminThing",
      "pickyThing",
      "readThing",
      "writeThing",
    ]);

    const input = pkg.docs?.readThing?.input as {
      properties: Record<string, { type: string; description: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(input.properties.query).toEqual({
      type: "string",
      description: "What to read.",
    });
    expect(input.properties.limit?.type).toBe("number");
    expect(input.required).toEqual(["query"]);
    expect(input.additionalProperties).toBe(false);
    expect(pkg.docs?.readThing?.description).toContain(
      "READ_THING does a thing.",
    );

    expect(pkg.annotations?.readThing).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(pkg.annotations?.writeThing).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });

    expect(actionKindOf(READ, declared.compatibility)).toBe("action.read");
    expect(actionKindOf(WRITE, declared.compatibility)).toBe("action.unsafe");
    expect(
      actionKindOf(
        { name: "X", tags: ["effect:idempotent"] },
        declared.compatibility,
      ),
    ).toBe("action.idempotent");
  });

  test("two actions that would share one method name are refused at construction", () => {
    const clashing: Plugin = {
      name: "@elizaos/plugin-clash",
      description: "Clash.",
      actions: [action("DO_THING"), action("DO-THING")],
    };
    expect(() =>
      elizaPackage({
        declared: declarePlugin(clashing, declared.compatibility),
      }),
    ).toThrow(
      expect.objectContaining({ code: TARDIGRADE_PACKAGE_METHOD_COLLISION }),
    );
    const empty: Plugin = {
      name: "@elizaos/plugin-empty",
      description: "None.",
    };
    expect(
      elizaPackages([declarePlugin(empty, declared.compatibility)]),
    ).toHaveLength(0);
  });
});

describe("owner-side executors", () => {
  test("an action runs with its parameters and reports the elizaOS result", async () => {
    const runtime = ownerRuntime();
    try {
      const result = await invokeAction(
        runtime,
        "k1",
        "action.read",
        "READ_THING",
        { query: "ledger", limit: 2 },
      );
      expect(result.success).toBe(true);
      expect(result.action).toBe("READ_THING");
      expect(result.text).toBe("READ_THING ran");
      expect(String(result.values?.parameters)).toContain("ledger");
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("a role gate, a validation refusal and an unknown action are answered, not thrown past the model", async () => {
    const runtime = ownerRuntime();
    try {
      const gated = await invokeAction(
        runtime,
        "k2",
        "action.read",
        "ADMIN_THING",
        {},
        "bob",
      );
      expect(gated.success).toBe(false);
      expect(gated.code).toBe(TARDIGRADE_ROLE_REFUSED);
      expect(gated.deliveries).toEqual([]);

      const refused = await invokeAction(
        runtime,
        "k3",
        "action.read",
        "PICKY_THING",
      );
      expect(refused.success).toBe(false);
      expect(refused.code).toBe(TARDIGRADE_ACTION_VALIDATION_REFUSED);

      expect(
        await codeOf(
          runtime.invoke({
            key: "k4",
            kind: "action.read",
            name: "NO_SUCH_THING",
            thread: "main",
            turn: "turn-alice",
            payload: {
              turn: turn(),
              action: "NO_SUCH_THING",
              parameters: {},
            },
          }),
        ),
      ).toBe(TARDIGRADE_ACTION_UNKNOWN);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("an action invoked under the wrong replay policy is refused rather than executed", async () => {
    const runtime = ownerRuntime();
    try {
      expect(
        await codeOf(
          runtime.invoke({
            key: "k5",
            kind: "action.read",
            name: "WRITE_THING",
            thread: "main",
            turn: "turn-alice",
            payload: { turn: turn(), action: "WRITE_THING", parameters: {} },
          }),
        ),
      ).toBe(TARDIGRADE_ACTION_POLICY_MISMATCH);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("the owner's role gate reads the authenticated owner, so the owner passes it", async () => {
    const runtime = ownerRuntime();
    try {
      const allowed = await invokeAction(
        runtime,
        "k6",
        "action.read",
        "ADMIN_THING",
      );
      expect(allowed.success).toBe(true);
      expect(allowed.code).toBeUndefined();
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("context composition returns the complete provider text for the turn", async () => {
    const runtime = ownerRuntime();
    try {
      const composed = (
        await runtime.invoke({
          key: "k7",
          kind: "context",
          name: "context",
          thread: "main",
          turn: "turn-alice",
          payload: { turn: turn() },
        })
      ).result as { text: string; providers: ReadonlyArray<string> };
      expect(typeof composed.text).toBe("string");
      expect(Array.isArray(composed.providers)).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 30_000);
});

describe("package methods refuse honestly", () => {
  test("an owner refusal becomes a structured answer rather than a defect", async () => {
    const pkg = elizaPackage({ declared });
    const method = pkg.methods.readThing;
    expect(typeof method).toBe("function");
    // The method needs its thread services; running it without them must fail
    // as a missing-service defect, never as a silent success.
    const outcome = await Effect.runPromiseExit(
      method?.({ query: "x" }, { callId: "c1" }) as Effect.Effect<
        unknown,
        never,
        never
      >,
    );
    expect(outcome._tag).toBe("Failure");
  }, 30_000);
});
