/**
 * Workerd fixture for the owner Durable Object: a minimal Worker that mounts
 * `OwnerDO` with two executors — remember (unsafe write) and recall (read) —
 * over the real edge AgentRuntime and durable adapter, so scripts can prove
 * persistence across an object restart and owner isolation without the full
 * actor. Not a product entry; scripts/owner-storage.mjs drives it through
 * wrangler.owner-test.jsonc.
 */

import {
  type Character,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core/edge";
import { Effect } from "effect";
import { defineOwnerObject } from "../../src/hosts/user-do";
import { type OwnerInvocation, ownerObjectPort } from "../../src/owner/port";

interface FixtureEnv {
  readonly OWNERS: {
    getByName(name: string): {
      invoke(owner: string, invocation: OwnerInvocation): Promise<unknown>;
    };
  };
}

const AGENT = stringToUuid("owner-fixture-agent") as UUID;
const roomId = stringToUuid("owner-fixture-room") as UUID;
const character: Character = {
  name: "Fixture",
  bio: ["remembers"],
  system: "Remember facts.",
};

export const OwnerDO = defineOwnerObject<FixtureEnv>({
  build: () => ({
    agentId: AGENT,
    character,
    plugins: [],
    basicCapabilities: false,
    executors: {
      remember: {
        policy: "unsafe",
        run: async ({ runtime, invocation }) => {
          const text = String((invocation.payload as { text: string }).text);
          const memory: Memory = {
            id: stringToUuid(`${invocation.key}/memory`) as UUID,
            entityId: stringToUuid(invocation.thread) as UUID,
            agentId: AGENT,
            roomId,
            content: { text },
            createdAt: Date.now(),
          };
          await runtime.createMemory(memory, "messages");
          const count = (
            await runtime.getMemories({
              roomId,
              tableName: "messages",
              count: 1000,
            })
          ).length;
          return { result: { count } };
        },
      },
      recall: {
        policy: "read",
        run: async ({ runtime }) => ({
          result: (
            await runtime.getMemories({
              roomId,
              tableName: "messages",
              count: 1000,
            })
          ).map((memory) => memory.content.text),
        }),
      },
    },
  }),
});

const json = (value: unknown, status = 200) => Response.json(value, { status });

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    const match = /^\/owners\/([^/]+)\/(remember|recall|foreign)$/.exec(
      url.pathname,
    );
    if (match === null) return json({ error: "not found" }, 404);
    const owner = decodeURIComponent(match[1] as string);
    const action = match[2] as "remember" | "recall" | "foreign";
    try {
      if (action === "foreign") {
        // Another owner's object must refuse this owner's invocation outright.
        await env.OWNERS.getByName("someone-else").invoke(owner, {
          key: `${owner}/foreign`,
          kind: "recall",
          name: "recall",
          thread: owner,
          turn: "foreign",
          payload: {},
        });
        return json({ error: "foreign invocation was accepted" }, 500);
      }
      const port = ownerObjectPort(env.OWNERS as never, owner);
      const body =
        action === "remember"
          ? ((await request.json()) as { key: string; text: string })
          : { key: url.searchParams.get("key") ?? "recall", text: "" };
      const result = await Effect.runPromise(
        port.invoke({
          key: `${owner}/${body.key}`,
          kind: action,
          name: action,
          thread: owner,
          turn: body.key,
          payload: action === "remember" ? { text: body.text } : {},
        }),
      );
      return json(result);
    } catch (cause) {
      // error-policy:J1 The fixture boundary reports the failure it saw.
      return json(
        {
          error: cause instanceof Error ? cause.message : String(cause),
          code: (cause as { code?: string }).code ?? null,
        },
        409,
      );
    }
  },
};
