/**
 * Owner identity and owner-token contracts: a real HS256 verifier against a
 * token minted by the access repository's issuer (fixed vector), the scoped
 * instance naming round trip, and the Durable Object namespace guard.
 * Deterministic: a fixed clock and secret; no network, no host.
 */

import { describe, expect, test } from "bun:test";
import {
  bearerOf,
  createOwnerTokenIssuer,
  createOwnerTokenVerifier,
  ownerTokenAuthenticate,
  TARDIGRADE_OWNER_TOKEN_CONFIG,
} from "../src/hosts/auth";
import {
  instanceName,
  instanceOwner,
  isScopedInstance,
  isScopedObject,
  objectOwner,
  ownerOfInstance,
  scopedNamespace,
  TARDIGRADE_FOREIGN_OWNER,
  TARDIGRADE_INSTANCE_UNSCOPED,
  TARDIGRADE_OWNER_INVALID,
  userInstance,
  validateOwner,
} from "../src/hosts/identity";

// Minted by access/src/server-auth createOwnerTokenIssuer with this secret,
// issuer "aiko", audience "eliza", ttl 60s, at 1789344000000 for owner-alpha.
const VECTOR = {
  secret: "eliza-tardigrade-owner-token-compat-fixture-secret-0123456789",
  issuedAtMs: 1789344000000,
  token:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhaWtvIiwiYXVkIjoiZWxpemEiLCJzdWIiOiJvd25lci1hbHBoYSIsImlhdCI6MTc4OTM0NDAwMCwiZXhwIjoxNzg5MzQ0MDYwLCJzY29wZSI6ImFjY2VzcyBhY2Nlc3M6Y3JlZGVudGlhbHMifQ.WQIxSz6SiCNlhHb8vCOzXMBwqN9IKF5YQ7nAi-OF4_s",
};

const verifierAt = (nowMs: number, overrides: Record<string, unknown> = {}) =>
  createOwnerTokenVerifier({
    secret: VECTOR.secret,
    issuer: "aiko",
    audience: "eliza",
    ttlMs: 60_000,
    clock: () => nowMs,
    ...overrides,
  });

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("owner tokens", () => {
  test("verifies a token minted by the access issuer", async () => {
    const identity = await verifierAt(VECTOR.issuedAtMs + 30_000).verify(
      VECTOR.token,
    );
    expect(identity).toEqual({
      ownerId: "owner-alpha",
      issuer: "aiko",
      scopes: ["access", "access:credentials"],
      expiresAt: 1789344060,
    });
  });

  test("refuses expiry, clock skew, audience, issuer, tampering, and malformed tokens", async () => {
    expect(
      await verifierAt(VECTOR.issuedAtMs + 61_000).verify(VECTOR.token),
    ).toBeNull();
    expect(
      await verifierAt(VECTOR.issuedAtMs - 1_000).verify(VECTOR.token),
    ).toBeNull();
    expect(
      await verifierAt(VECTOR.issuedAtMs + 30_000, {
        audience: "access",
      }).verify(VECTOR.token),
    ).toBeNull();
    expect(
      await verifierAt(VECTOR.issuedAtMs + 30_000, {
        issuer: "someone",
      }).verify(VECTOR.token),
    ).toBeNull();
    expect(
      await verifierAt(VECTOR.issuedAtMs + 30_000, { ttlMs: 30_000 }).verify(
        VECTOR.token,
      ),
    ).toBeNull();
    const [header, payload, signature] = VECTOR.token.split(".") as [
      string,
      string,
      string,
    ];
    const forgedPayload = payload.replace(/.$/, (char) =>
      char === "A" ? "B" : "A",
    );
    expect(
      await verifierAt(VECTOR.issuedAtMs + 30_000).verify(
        `${header}.${forgedPayload}.${signature}`,
      ),
    ).toBeNull();
    const forgedSignature = signature.replace(/.$/, (char) =>
      char === "A" ? "B" : "A",
    );
    expect(
      await verifierAt(VECTOR.issuedAtMs + 30_000).verify(
        `${header}.${payload}.${forgedSignature}`,
      ),
    ).toBeNull();
    for (const bad of [
      "",
      "abc",
      `${header}.${payload}`,
      `x.${payload}.${signature}`,
      "a".repeat(5000),
    ]) {
      expect(
        await verifierAt(VECTOR.issuedAtMs + 30_000).verify(bad),
      ).toBeNull();
    }
  });

  test("the native issuer round-trips with the verifier and refuses bad configuration", async () => {
    const clock = () => 1_800_000_000_000;
    const issuer = createOwnerTokenIssuer({ secret: VECTOR.secret, clock });
    const token = await issuer.issue("alice@example", "eliza");
    const identity = await createOwnerTokenVerifier({
      secret: VECTOR.secret,
      clock,
    }).verify(token);
    expect(identity?.ownerId).toBe("alice@example");
    expect(identity?.scopes).toEqual(["eliza"]);
    expect(identity?.expiresAt).toBe(1_800_000_000 + 60);
    expect(codeOf(() => createOwnerTokenIssuer({ secret: "short" }))).toBe(
      TARDIGRADE_OWNER_TOKEN_CONFIG,
    );
    expect(
      codeOf(() =>
        createOwnerTokenIssuer({ secret: VECTOR.secret, ttlMs: 10 }),
      ),
    ).toBe(TARDIGRADE_OWNER_TOKEN_CONFIG);
    await expect(issuer.issue("../etc")).rejects.toMatchObject({
      code: TARDIGRADE_OWNER_INVALID,
    });
  });

  test("authenticate reads the bearer and the deployment environment", async () => {
    const authenticate = ownerTokenAuthenticate<{
      ELIZA_OWNER_TOKEN_SECRET?: string;
      ELIZA_OWNER_TOKEN_ISSUER?: string;
      ELIZA_OWNER_TOKEN_AUDIENCE?: string;
    }>();
    const issuer = createOwnerTokenIssuer({ secret: VECTOR.secret });
    const token = await issuer.issue("bob");
    const request = new Request(
      "https://eliza.example/v1/actors/home/threads",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const env = { ELIZA_OWNER_TOKEN_SECRET: VECTOR.secret };
    expect(await authenticate(request, env)).toMatchObject({
      mode: "owner-token",
      ownerId: "bob",
      token,
    });
    expect(await authenticate(request, {})).toBeNull();
    expect(
      await authenticate(new Request("https://eliza.example/v1/metadata"), env),
    ).toBeNull();
    expect(
      await authenticate(
        new Request("https://eliza.example/v1/metadata", {
          headers: { authorization: `Bearer ${token}` },
        }),
        { ...env, ELIZA_OWNER_TOKEN_AUDIENCE: "access" },
      ),
    ).toBeNull();
    expect(
      bearerOf(
        new Request("https://x/", { headers: { authorization: "Basic abc" } }),
      ),
    ).toBeNull();
  });
});

describe("owner-scoped instances", () => {
  test("scoped names round-trip and unscoped names are their own owner", () => {
    const scoped = userInstance("alice@example", "home");
    expect(isScopedInstance(scoped)).toBe(true);
    expect(instanceOwner(scoped)).toBe("alice@example");
    expect(instanceName(scoped)).toBe("home");
    expect(ownerOfInstance(scoped)).toBe("alice@example");
    expect(ownerOfInstance("smoke-owner")).toBe("smoke-owner");
    expect(isScopedInstance("smoke-owner")).toBe(false);
    expect(codeOf(() => instanceOwner("smoke-owner"))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );
    expect(codeOf(() => instanceOwner("user.YWxpY2U=.aG9tZQ"))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );
  });

  test("owner ids follow the shared alphabet", () => {
    expect(validateOwner("owner-alpha")).toBe("owner-alpha");
    for (const bad of ["", "../x", "-lead", "a".repeat(201), 42, null]) {
      expect(codeOf(() => validateOwner(bad))).toBe(TARDIGRADE_OWNER_INVALID);
    }
    expect(codeOf(() => userInstance("alice", "a/b"))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );
  });

  test("Durable Object coordinates resolve to their owner and refuse foreign or raw lookups", () => {
    const alice = userInstance("alice", "home");
    const bob = userInstance("bob", "home");
    const coordinate = (instance: string) =>
      JSON.stringify(["eliza", instance, "main"]);
    expect(objectOwner(coordinate(alice))).toBe("alice");
    expect(isScopedObject(coordinate(alice))).toBe(true);
    expect(isScopedObject(coordinate("plain"))).toBe(false);
    expect(isScopedObject("not json")).toBe(false);
    expect(codeOf(() => objectOwner("not json"))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );
    expect(codeOf(() => objectOwner(coordinate("plain")))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );

    const seen: string[] = [];
    const namespace = {
      getByName: (name: string) => {
        seen.push(name);
        return { name };
      },
      get: () => "raw",
      idFromName: () => "raw",
      jurisdiction: () => "eu",
    };
    const guarded = scopedNamespace(namespace, "alice");
    expect(guarded.getByName(coordinate(alice))).toEqual({
      name: coordinate(alice),
    });
    expect(codeOf(() => guarded.getByName(coordinate(bob)))).toBe(
      TARDIGRADE_FOREIGN_OWNER,
    );
    expect(codeOf(() => guarded.getByName(coordinate("plain")))).toBe(
      TARDIGRADE_INSTANCE_UNSCOPED,
    );
    expect(codeOf(() => guarded.get())).toBe(TARDIGRADE_FOREIGN_OWNER);
    expect(codeOf(() => guarded.idFromName())).toBe(TARDIGRADE_FOREIGN_OWNER);
    expect(guarded.jurisdiction()).toBe("eu");
    expect(seen).toEqual([coordinate(alice)]);
  });
});
