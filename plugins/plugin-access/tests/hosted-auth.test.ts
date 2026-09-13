/** Exercises hosted auth and the real Access HTTP SDK with encrypted PGlite persistence and an isolated deterministic auth server; no live credentials or Telegram messages are used. */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  createCharacter,
  Service,
  type UUID,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { inMemoryMasterKey } from "../../../packages/vault/src/master-key.ts";
import { PgliteVaultImpl } from "../../../packages/vault/src/pglite-vault.ts";
import { emitTelegramUserActivity } from "../../plugin-telegram/src/user-activity.ts";
import { ACCESS_DRAIN } from "../src/contracts.ts";
import {
  HostedAccessAuth,
  type HostedCredentialStore,
} from "../src/hosted-auth.ts";
import { accessPlugin } from "../src/index.ts";
import { AccessService } from "../src/service.ts";

const AGENT: UUID = "33333333-3333-4333-8333-333333333333";
const OWNER: UUID = "11111111-1111-4111-8111-111111111111";
const OTHER: UUID = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "aiko-hosted-auth-"));
  const key = randomBytes(32);
  const openVault = () =>
    new PgliteVaultImpl({
      dataDir: join(dir, "vault"),
      masterKey: inMemoryMasterKey(Buffer.from(key)),
      auditPath: join(dir, "audit.jsonl"),
    });
  let vault = openVault();
  let failWrite = false;
  const store: HostedCredentialStore = {
    has: (ref) => vault.has(ref),
    get: (ref) => vault.get(ref),
    putSecret: async (input) => {
      if (failWrite) throw new Error("private-store-diagnostic");
      await vault.set(input.vaultRef, input.value, { sensitive: true });
      return input.vaultRef;
    },
  };
  const users = new Map<
    string,
    { ownerId: string; password: string; recoveryCode: string }
  >();
  const sessions = new Map<string, { ownerId: string; username: string }>();
  const accounts = new Map<
    string,
    Array<{ id: string; site: string; label: string; active: boolean }>
  >();
  const calls: Array<{ path: string; ownerId: string | null }> = [];
  let clock = Date.now();
  let loseRegistration = false;
  let foreignLogin = false;
  let rejectLogin = false;
  let throttle = false;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    const current = sessions.get(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    calls.push({ path, ownerId: current?.ownerId ?? null });
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const input = raw ? JSON.parse(raw) : null;
    const send = (status: number, value: object) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (path === "/auth/register" || path === "/auth/login") {
      if (throttle) {
        send(429, { error: "throttled" });
        return;
      }
      let user = users.get(input.username);
      if (path === "/auth/register") {
        if (user) {
          send(409, { error: "unavailable" });
          return;
        }
        user = {
          ownerId: `remote-${users.size + 1}`,
          password: input.password,
          recoveryCode: randomBytes(32).toString("hex"),
        };
        users.set(input.username, user);
        accounts.set(user.ownerId, []);
        if (loseRegistration) {
          loseRegistration = false;
          req.socket.destroy();
          return;
        }
      } else if (!user || user.password !== input.password || rejectLogin) {
        send(401, { error: "private-login-diagnostic" });
        return;
      }
      if (!user) throw new Error("Auth fixture user required");
      const ownerId =
        foreignLogin && path === "/auth/login" ? "foreign-owner" : user.ownerId;
      const token = randomBytes(32).toString("hex");
      sessions.set(token, { ownerId, username: input.username });
      send(200, {
        ownerId,
        username: input.username,
        token,
        expiresAt: Math.floor(clock / 1000) + 3600,
        ...(path === "/auth/register"
          ? { recoveryCode: user.recoveryCode }
          : {}),
      });
      return;
    }
    if (!current) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (path === "/auth/me") {
      send(200, current);
      return;
    }
    if (path === "/accounts") {
      const own = accounts.get(current.ownerId);
      if (!own) throw new Error("Fixture owner accounts required");
      if (req.method === "POST") {
        const account = {
          ...input,
          label: input.label ?? input.site,
          active: true,
        };
        own.push(account);
        send(200, { account });
      } else send(200, { accounts: own });
      return;
    }
    send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP required");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const auth = () =>
    new HostedAccessAuth({
      baseUrl,
      agentId: AGENT,
      store: () => store,
      now: () => clock,
    });
  return {
    baseUrl,
    store,
    auth,
    calls,
    users,
    registrations: () =>
      calls.filter((call) => call.path === "/auth/register").length,
    logins: () => calls.filter((call) => call.path === "/auth/login").length,
    expire: () => {
      clock += 3600_000;
    },
    revoke: () => sessions.clear(),
    loseRegistration: () => {
      loseRegistration = true;
    },
    foreignLogin: () => {
      foreignLogin = true;
    },
    rejectLogin: () => {
      rejectLogin = true;
    },
    throttle: () => {
      throttle = true;
    },
    failWrite: () => {
      failWrite = true;
    },
    restart: async () => {
      await vault.close();
      vault = openVault();
    },
    audit: async () => readFile(join(dir, "audit.jsonl"), "utf8"),
    descriptions: async () =>
      Promise.all((await vault.list()).map((ref) => vault.describe(ref))),
    corruptScope: async () => {
      const refs = await vault.list();
      const ref = refs[0];
      if (!ref) throw new Error("Identity required");
      const data = JSON.parse(await vault.get(ref));
      data.entityId = OTHER;
      await vault.set(ref, JSON.stringify(data), { sensitive: true });
    },
    close: async () => {
      server.close();
      await once(server, "close");
      await vault.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("first contact registers once, isolates users and reopens encrypted identity after restart", async () => {
  const f = await fixture();
  try {
    const a = f.auth();
    const b = f.auth();
    await Promise.all([
      a.client(OWNER).accounts.list(),
      b.client(OWNER).accounts.list(),
      a.client(OTHER).accounts.list(),
    ]);
    expect(f.registrations()).toBe(2);
    await a.client(OWNER).accounts.add({ id: "work", site: "example.test" });
    expect((await a.client(OTHER).accounts.list()).accounts).toHaveLength(0);
    await f.restart();
    expect(
      (await f.auth().client(OWNER).accounts.list()).accounts,
    ).toHaveLength(1);
    expect(f.registrations()).toBe(2);
    expect(f.logins()).toBe(0);
    expect(
      (await f.descriptions()).every((entry) => entry?.sensitive === true),
    ).toBe(true);
    const audit = await f.audit();
    for (const user of f.users.values()) {
      expect(audit.includes(user.password)).toBe(false);
      expect(audit.includes(user.recoveryCode)).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test("expired or revoked sessions renew behind the SDK and preserve the same owner", async () => {
  const f = await fixture();
  try {
    const client = f.auth().client(OWNER);
    await client.accounts.add({ id: "work", site: "example.test" });
    f.expire();
    await Promise.all([client.accounts.list(), client.accounts.list()]);
    expect(f.logins()).toBe(1);
    f.revoke();
    await Promise.all([client.accounts.list(), client.accounts.list()]);
    expect(f.logins()).toBe(2);
    expect(f.registrations()).toBe(1);
    expect((await client.accounts.list()).accounts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a lost registration response recovers from committed credentials after restart", async () => {
  const f = await fixture();
  try {
    f.loseRegistration();
    await expect(f.auth().client(OWNER).accounts.list()).rejects.toMatchObject({
      status: 0,
    });
    await f.restart();
    await f.auth().client(OWNER).accounts.list();
    expect(f.users.size).toBe(1);
    expect(f.logins()).toBe(1);
  } finally {
    await f.close();
  }
});

test("vault write failure prevents registration and redacts its diagnostics", async () => {
  const f = await fixture();
  try {
    f.failWrite();
    await expect(f.auth().client(OWNER).accounts.list()).rejects.toMatchObject({
      code: "ACCESS_HOSTED_IDENTITY_FAILED",
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test.each(["owner", "password", "stored-scope"] as const)(
  "rejects changed %s without registering a replacement",
  async (failure) => {
    const f = await fixture();
    try {
      await f.auth().client(OWNER).accounts.list();
      f.expire();
      if (failure === "owner") f.foreignLogin();
      if (failure === "password") f.rejectLogin();
      if (failure === "stored-scope") await f.corruptScope();
      await expect(
        f.auth().client(OWNER).accounts.list(),
      ).rejects.toBeInstanceOf(Error);
      expect(f.registrations()).toBe(1);
      expect(f.calls.filter((call) => call.path === "/accounts")).toHaveLength(
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test("hosted throttling is retained across restart without retry storms", async () => {
  const f = await fixture();
  try {
    f.throttle();
    await expect(f.auth().client(OWNER).accounts.list()).rejects.toMatchObject({
      status: 429,
    });
    await f.restart();
    await expect(f.auth().client(OWNER).accounts.list()).rejects.toMatchObject({
      status: 429,
    });
    expect(f.registrations()).toBe(1);
  } finally {
    await f.close();
  }
});

test("the real service and Telegram activity provision hosted users without an owner-signing key or Bun polling", async () => {
  const f = await fixture();
  class Credentials extends Service implements HostedCredentialStore {
    static serviceType = "connector_credential_store";
    capabilityDescription = "Encrypted fixture credentials";
    static async start(runtime: AgentRuntime) {
      return new Credentials(runtime);
    }
    async stop() {}
    has = (ref: string) => f.store.has(ref);
    get = (ref: string) => f.store.get(ref);
    putSecret = (input: Parameters<HostedCredentialStore["putSecret"]>[0]) =>
      f.store.putSecret(input);
  }
  const runtime = new AgentRuntime({
    agentId: AGENT,
    character: createCharacter({ name: "Hosted fixture" }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  try {
    runtime.setSetting("ACCESS_REMOTE_URL", f.baseUrl);
    runtime.setSetting("ACCESS_AUTH_MODE", "hosted");
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    await runtime.registerService(Credentials);
    await runtime.getServiceLoadPromise("connector_credential_store");
    await runtime.registerService(AccessService);
    await runtime.getServiceLoadPromise("access");
    for (const handler of accessPlugin.events?.TELEGRAM_USER_ACTIVITY ?? [])
      runtime.registerEvent("TELEGRAM_USER_ACTIVITY", handler);
    await emitTelegramUserActivity(runtime, "default", { id: 42 }, "private");
    await emitTelegramUserActivity(runtime, "default", { id: 42 }, "private");
    expect(f.users.size).toBe(1);
    expect(f.registrations()).toBe(1);
    expect(runtime.getTaskWorker(ACCESS_DRAIN)).toBeUndefined();
    expect(
      f.calls.every((call) =>
        ["/auth/register", "/auth/me", "/accounts"].includes(call.path),
      ),
    ).toBe(true);
  } finally {
    await runtime.stop();
    await f.close();
  }
});
