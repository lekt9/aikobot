/**
 * The Access capability, end to end on a real Tardigrade host with a scripted
 * model and a fake Access deployment. The model writes JavaScript that calls
 * the `access` package; the owner runtime runs the real `plugin-access`
 * action, which submits an account-bound operation to the fake host over the
 * fetch client and returns the operation to the model. Every layer but the
 * model and the Access host itself is real: the engine loop, the log, the
 * owner runtime, the scheduler, and plugin-access.
 *
 * This is the "talk, and it does things through Access" path: a turn reaches
 * an ACCESS action and the operation lands on the remote host, with no VM in
 * the runtime because the browser work stays on that host.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Character } from "@elizaos/core/edge";
import { Effect, Layer } from "effect";
import { Infer } from "tardie/agent";
import type { Event } from "tardie/core/event";
import { createHost } from "tardie/host/memory/host";
import { ElizaOwner } from "../src/hosts/identity";
import {
  type AccessOwnerOptions,
  accessCharacter,
  accessOptionsFromEnv,
  accessOwnerPlugins,
  TARDIGRADE_ACCESS_CONFIG,
} from "../src/native/access";
import { elizaNativeActor } from "../src/native/actor";
import {
  nativeDeclarationPlugins,
  nativeOwnerBuild,
} from "../src/native/owner";
import { bunOwnerRegistry } from "../src/owner/bun";
import { OwnerRuntimePort } from "../src/owner/port";
import { testStorageDir } from "./support";

const OWNER_TOKEN_SECRET =
  "native-access-fixture-owner-token-secret-0123456789ab";
const character: Character = {
  name: "Aiko",
  bio: ["a secretary who acts through Access"],
  system: "Use the access package to act on the owner's connected accounts.",
};

interface FakeAccess {
  readonly url: string;
  readonly operations: () => ReadonlyArray<{ accountId: string; kind: string }>;
  stop(): void;
}

/** A minimal Access host that accepts any owner token and records operations. */
function fakeAccessHost(): FakeAccess {
  const operations: Array<{ accountId: string; kind: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/accounts" && request.method === "GET") {
        return json({
          accounts: [
            { id: "work", site: "eatigo.com", label: "Work", active: true },
          ],
        });
      }
      if (url.pathname === "/events" && request.method === "GET") {
        return json({ events: [], nextCursor: 0, hasMore: false });
      }
      if (url.pathname === "/context" && request.method === "GET") {
        return json({ cursor: 0, evidence: [], status: "ready", error: null });
      }
      const submit = /^\/accounts\/([^/]+)\/operations$/.exec(url.pathname);
      if (submit && request.method === "POST") {
        const body = (await request.json()) as { id: string; kind: string };
        const accountId = decodeURIComponent(submit[1] as string);
        // Only the connected account exists; anything else is refused, which
        // is what the "unknown account" turn must survive and report.
        if (accountId !== "work") {
          return json({ error: "unknown account" }, 404);
        }
        operations.push({ accountId, kind: body.kind });
        return json({
          id: body.id,
          accountId,
          kind: body.kind,
          status: "pending",
          thread: `access-${body.id}`,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          output: null,
          error: null,
        });
      }
      return json({ error: "not found" }, 404);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    operations: () => operations,
    stop: () => server.stop(true),
  };
}

interface Harness {
  readonly events: () => ReadonlyArray<Event>;
  readonly requests: ReadonlyArray<{ system: string; packages: string }>;
  close(): Promise<void>;
}

async function runTurn(
  access: AccessOwnerOptions,
  code: string,
): Promise<Harness> {
  const registry = bunOwnerRegistry({
    dir: testStorageDir("native-access"),
    build: nativeOwnerBuild({ agentKey: "aiko-access", character, access }),
  });
  const actor = elizaNativeActor({
    character,
    plugins: accessOwnerPlugins(nativeDeclarationPlugins()),
  });
  const requests: Array<{ system: string; packages: string }> = [];
  let step = 0;
  const scripted = {
    resolve: () => ({ model: { provider: "test", model_id: "scripted" } }),
    react: (request: { system: string }) =>
      Effect.sync(() => {
        requests.push({
          system: request.system,
          packages:
            /The packages in scope[\s\S]*/u.exec(request.system)?.[0] ?? "",
        });
        step += 1;
        if (step === 1) {
          return {
            kind: "calls" as const,
            calls: [
              {
                callId: "call-1",
                name: "execute",
                arguments: { code, summary: "act through access" },
              },
            ] as const,
          };
        }
        return { kind: "complete" as const, output: "Done." };
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
  await host.commitRoot(host.self("main"), {
    type: "MessageReceived",
    id: "turn-1",
    text: "Book me a table through my work account",
    input: { owner: "alice", sender: "alice", source: "test" },
    at: 1_700_000_000_000,
  } as unknown as Event);
  await host.drive();
  return {
    events: () => host.read("main"),
    requests,
    close: () => registry.close(),
  };
}

describe("Access as a native capability", () => {
  let access: FakeAccess;
  beforeAll(() => {
    access = fakeAccessHost();
  });
  afterAll(() => {
    access.stop();
  });

  test("the model reaches an ACCESS action through the package and the operation lands on the host", async () => {
    const harness = await runTurn(
      { remoteUrl: access.url, ownerTokenSecret: OWNER_TOKEN_SECRET },
      "const op = await access.accessRun({ accountId: 'work', intent: 'book a table for two at 7pm' }); return op;",
    );
    try {
      const events = harness.events();
      const types = events.map((event) => event.type);
      expect(types).toContain("TurnCompleted");
      expect(types).not.toContain("TurnFailed");

      // The access package was offered to the model and called.
      expect(harness.requests[0]?.packages).toContain("access.accessRun");
      const called = events
        .filter((event) => event.type === "PackageCalled")
        .map((event) => String((event as { name?: unknown }).name ?? ""));
      expect(called).toContain("access.accessRun");

      // The real plugin-access action submitted a run operation to the host.
      expect(access.operations()).toContainEqual({
        accountId: "work",
        kind: "run",
      });

      // The action's own verdict is success, and its result carried the
      // operation the host recorded, not an error.
      const returned = events.find(
        (event) => event.type === "PackageReturned",
      ) as unknown as {
        result?: {
          success?: boolean;
          action?: string;
          data?: { operation?: { kind?: string } };
        };
      };
      expect(returned?.result?.success).toBe(true);
      expect(returned?.result?.action).toBe("ACCESS_RUN");
      expect(returned?.result?.data?.operation?.kind).toBe("run");

      // No scheduled drain failed: the proactive sync path is satisfied too.
      expect(types).not.toContain("ElizaTickFailed");
    } finally {
      await harness.close();
    }
  }, 60_000);

  test("an unknown account is answered, not a dead turn", async () => {
    const harness = await runTurn(
      { remoteUrl: access.url, ownerTokenSecret: OWNER_TOKEN_SECRET },
      "const op = await access.accessRun({ accountId: 'personal', intent: 'x' }); return op;",
    );
    try {
      const events = harness.events();
      // The account is not in the fake host's list, so the host answers 404;
      // the turn still completes and the model gets the failure as data.
      expect(events.map((event) => event.type)).toContain("TurnCompleted");
      expect(events.map((event) => event.type)).not.toContain("TurnFailed");
      const returned = events.find(
        (event) => event.type === "PackageReturned",
      ) as unknown as { result?: { success?: boolean } };
      expect(returned?.result?.success).toBe(false);
    } finally {
      await harness.close();
    }
  }, 60_000);
});

describe("Access is opt-in", () => {
  test("an unconfigured environment mounts no Access, so a base turn is unaffected", () => {
    expect(accessOptionsFromEnv({})).toBeNull();
    expect(
      accessOptionsFromEnv({ ACCESS_REMOTE_URL: "https://access.example" }),
    ).toBeNull();
    expect(
      accessOptionsFromEnv({
        ACCESS_REMOTE_URL: "https://access.example",
        ACCESS_OWNER_TOKEN_SECRET: OWNER_TOKEN_SECRET,
      }),
    ).toEqual({
      remoteUrl: "https://access.example",
      ownerTokenSecret: OWNER_TOKEN_SECRET,
    });

    // The base declaration set has no access package.
    const names = accessOwnerPlugins(nativeDeclarationPlugins()).map(
      (declared) => declared.plugin.name,
    );
    expect(names).toContain("access");
    expect(nativeDeclarationPlugins().map((d) => d.plugin.name)).not.toContain(
      "access",
    );
  });

  test("misconfigured Access is refused at build, not at turn time", () => {
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(
      codeOf(() =>
        accessCharacter(character, {
          remoteUrl: "",
          ownerTokenSecret: OWNER_TOKEN_SECRET,
        }),
      ),
    ).toBe(TARDIGRADE_ACCESS_CONFIG);
    expect(
      codeOf(() =>
        accessCharacter(character, {
          remoteUrl: "https://x",
          ownerTokenSecret: "short",
        }),
      ),
    ).toBe(TARDIGRADE_ACCESS_CONFIG);
  });
});
