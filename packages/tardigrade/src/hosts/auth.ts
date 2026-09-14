/**
 * Owner tokens: the application-to-host delegation Aiko already uses for
 * Access. A trusted backend signs a short-lived HS256 JWT naming one owner;
 * the Worker verifies it and scopes every route to that owner. The wire
 * format matches `access/server-auth` byte for byte (header, claim order,
 * canonical base64url, one-minute default lifetime) so one issuer serves
 * both hosts; only the audience differs per deployment.
 *
 * A deployment may also keep the static `TARDIGRADE_TOKEN` bearer for
 * operators: it reaches unscoped instances exactly as before. Nothing here
 * grants an owner from a request body, a thread id, or a URL alone.
 */

import { ElizaError } from "@elizaos/core/edge";
import { validateOwner } from "./identity";

export const TARDIGRADE_OWNER_TOKEN_CONFIG = "TARDIGRADE_OWNER_TOKEN_CONFIG";

export interface OwnerTokenOptions {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

export interface OwnerIdentity {
  readonly ownerId: string;
  readonly issuer: string;
  readonly scopes: ReadonlyArray<string>;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export interface AuthenticatedOwner extends OwnerIdentity {
  readonly mode: "owner-token";
  readonly token: string;
}

export type Authenticate<WorkerEnv> = (
  request: Request,
  env: WorkerEnv,
) => Promise<AuthenticatedOwner | null>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_ISSUER = "aiko";
const DEFAULT_AUDIENCE = "eliza";
const DEFAULT_TTL_MS = 60_000;
const MAX_TOKEN_LENGTH = 4096;
const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]+( [A-Za-z0-9_.:-]+)*$/;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ElizaError("Owner token segment is not base64url", {
      code: TARDIGRADE_OWNER_TOKEN_CONFIG,
    });
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const HEADER = encode(
  encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
);

interface Claims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly scope: string;
}

function isClaims(value: unknown): value is Claims {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "aud,exp,iat,iss,scope,sub") return false;
  return (
    typeof record.iss === "string" &&
    record.iss.length > 0 &&
    typeof record.aud === "string" &&
    record.aud.length > 0 &&
    typeof record.sub === "string" &&
    Number.isSafeInteger(record.iat) &&
    (record.iat as number) >= 0 &&
    Number.isSafeInteger(record.exp) &&
    (record.exp as number) > 0 &&
    typeof record.scope === "string" &&
    SCOPE_PATTERN.test(record.scope)
  );
}

function configure(options: OwnerTokenOptions) {
  const secret = encoder.encode(options.secret);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (secret.length < 32) {
    throw new ElizaError(
      "Owner token signing key must contain at least 32 bytes",
      {
        code: TARDIGRADE_OWNER_TOKEN_CONFIG,
      },
    );
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) {
    throw new ElizaError(
      "Owner token lifetime must be between one second and five minutes",
      {
        code: TARDIGRADE_OWNER_TOKEN_CONFIG,
        context: { ttlMs },
      },
    );
  }
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  for (const [name, value] of [
    ["issuer", issuer],
    ["audience", audience],
  ] as const) {
    if (value.length === 0 || value.length > 200) {
      throw new ElizaError(`Owner token ${name} must be 1-200 characters`, {
        code: TARDIGRADE_OWNER_TOKEN_CONFIG,
        context: { [name]: value },
      });
    }
  }
  const now = () => {
    const value = (options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ElizaError("Owner token clock is invalid", {
        code: TARDIGRADE_OWNER_TOKEN_CONFIG,
      });
    }
    return Math.floor(value / 1000);
  };
  const key = crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return { issuer, audience, lifetime: Math.floor(ttlMs / 1000), now, key };
}

/** Signs one owner delegation; call only after the application authenticated the owner. */
export function createOwnerTokenIssuer(options: OwnerTokenOptions) {
  const config = configure(options);
  return {
    async issue(ownerId: string, scope = "eliza"): Promise<string> {
      if (!SCOPE_PATTERN.test(scope)) {
        throw new ElizaError(
          "Owner token scope must be space-separated scope names",
          {
            code: TARDIGRADE_OWNER_TOKEN_CONFIG,
            context: { scope },
          },
        );
      }
      const now = config.now();
      const payload: Claims = {
        iss: config.issuer,
        aud: config.audience,
        sub: validateOwner(ownerId),
        iat: now,
        exp: now + config.lifetime,
        scope,
      };
      const message = `${HEADER}.${encode(encoder.encode(JSON.stringify(payload)))}`;
      const signature = await crypto.subtle.sign(
        "HMAC",
        await config.key,
        encoder.encode(message),
      );
      return `${message}.${encode(new Uint8Array(signature))}`;
    },
  };
}

/** Verifies an owner delegation; any defect yields null, never a partial identity. */
export function createOwnerTokenVerifier(options: OwnerTokenOptions) {
  const config = configure(options);
  return {
    async verify(token: string): Promise<OwnerIdentity | null> {
      try {
        if (token.length > MAX_TOKEN_LENGTH) return null;
        const parts = token.split(".");
        const [protectedHeader, payload, signature] = parts;
        if (
          parts.length !== 3 ||
          protectedHeader !== HEADER ||
          payload === undefined ||
          signature === undefined
        ) {
          return null;
        }
        const bytes = decode(signature);
        if (bytes.length !== 32 || encode(bytes) !== signature) return null;
        const valid = await crypto.subtle.verify(
          "HMAC",
          await config.key,
          bytes,
          encoder.encode(`${HEADER}.${payload}`),
        );
        if (!valid) return null;
        const claims: unknown = JSON.parse(decoder.decode(decode(payload)));
        if (!isClaims(claims)) return null;
        const now = config.now();
        if (
          claims.iss !== config.issuer ||
          claims.aud !== config.audience ||
          claims.iat > now ||
          claims.exp <= now ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > config.lifetime
        ) {
          return null;
        }
        return {
          ownerId: validateOwner(claims.sub),
          issuer: claims.iss,
          scopes: claims.scope.split(" "),
          expiresAt: claims.exp,
        };
      } catch {
        // error-policy:J3 Invalid signed input is rejected without echoing bearer material.
        return null;
      }
    },
  };
}

/** The bearer credential of a request, or null when absent or malformed. */
export function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/i.exec(header);
  return match === null ? null : (match[1] as string);
}

export interface OwnerTokenEnv {
  readonly ELIZA_OWNER_TOKEN_SECRET?: string;
  readonly ELIZA_OWNER_TOKEN_ISSUER?: string;
  readonly ELIZA_OWNER_TOKEN_AUDIENCE?: string;
}

/** Owner-token authentication from the deployment's environment. */
export function ownerTokenAuthenticate<
  WorkerEnv extends OwnerTokenEnv,
>(): Authenticate<WorkerEnv> {
  const verifiers = new Map<
    string,
    ReturnType<typeof createOwnerTokenVerifier>
  >();
  return async (request, env) => {
    const secret = env.ELIZA_OWNER_TOKEN_SECRET;
    if (!secret) return null;
    const token = bearerOf(request);
    if (token === null) return null;
    const issuer = env.ELIZA_OWNER_TOKEN_ISSUER ?? DEFAULT_ISSUER;
    const audience = env.ELIZA_OWNER_TOKEN_AUDIENCE ?? DEFAULT_AUDIENCE;
    const cacheKey = `${issuer} ${audience} ${secret}`;
    let verifier = verifiers.get(cacheKey);
    if (verifier === undefined) {
      verifier = createOwnerTokenVerifier({
        secret,
        issuer,
        audience,
        ttlMs: 300_000,
      });
      verifiers.set(cacheKey, verifier);
    }
    const identity = await verifier.verify(token);
    return identity === null
      ? null
      : { ...identity, mode: "owner-token", token };
  };
}
