/** Binds hosted Access accounts to trusted runtime identities using the host's durable encrypted connector store. Passwords are committed before registration, and sessions never enter tasks or model context. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type Service,
  type UUID,
} from "@elizaos/core";
import { AccessClientError, createAccessClient } from "access/client";
import { z } from "zod";
import { accessFailure, ownerSchema } from "./contracts.ts";

/** Structural boundary supplied by the application host, never an in-memory secret fallback. */
export interface HostedCredentialStore {
  has(ref: string): Promise<boolean>;
  get(ref: string): Promise<string>;
  putSecret(input: {
    vaultRef: string;
    agentId: string;
    provider: string;
    accountId: string;
    credentialType: string;
    value: string;
    caller: string;
  }): Promise<string>;
}
const sessionSchema = z
  .object({
    ownerId: z.string().min(1),
    username: z.string().min(3),
    token: z
      .string()
      .min(1)
      .refine((value) => !/\s/.test(value)),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const registrationSchema = sessionSchema.extend({
  recoveryCode: z.string().min(1),
});
const identitySchema = z
  .object({
    format: z.literal("aiko.hosted-access-identity/v1"),
    baseUrl: z.string(),
    agentId: ownerSchema,
    entityId: ownerSchema,
    username: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
    password: z.string().min(32).max(256),
    ownerId: z.string().min(1).nullable(),
    recoveryCode: z.string().nullable(),
    session: sessionSchema.nullable(),
    retryAt: z.number().nonnegative(),
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
type Session = z.infer<typeof sessionSchema>;
type Fetch = NonNullable<Parameters<typeof createAccessClient>[0]["fetch"]>;
const queues = new Map<string, Promise<void>>();

export function hostedBaseUrl(value: string): string {
  // Reuse the SDK's URL policy before any credential can leave the backend.
  createAccessClient({ baseUrl: value, token: () => "validation-only" });
  return new URL(value).href.replace(/\/$/, "");
}

export class HostedAccessAuth {
  readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      baseUrl: string;
      agentId: UUID;
      store: () => HostedCredentialStore;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {
    this.baseUrl = hostedBaseUrl(options.baseUrl);
    ownerSchema.parse(options.agentId);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private ref(owner: UUID): string {
    ownerSchema.parse(owner);
    const scope = createHash("sha256")
      .update(JSON.stringify([this.baseUrl, owner]))
      .digest("hex");
    return `connector.${this.options.agentId}.access-hosted.${scope}.identity`;
  }
  private async save(owner: UUID, record: Identity): Promise<void> {
    const ref = this.ref(owner);
    const value = JSON.stringify(identitySchema.parse(record));
    const store = this.options.store();
    const written = await store.putSecret({
      vaultRef: ref,
      agentId: this.options.agentId,
      provider: "access-hosted",
      accountId: owner,
      credentialType: "identity",
      value,
      caller: "access:hosted-auth",
    });
    if (written !== ref || (await store.get(ref)) !== value)
      throw accessFailure("ACCESS_IDENTITY_PERSISTENCE_FAILED");
  }
  private async read(owner: UUID): Promise<Identity> {
    const ref = this.ref(owner);
    const store = this.options.store();
    if (!(await store.has(ref))) {
      const record: Identity = {
        format: "aiko.hosted-access-identity/v1",
        baseUrl: this.baseUrl,
        agentId: this.options.agentId,
        entityId: owner,
        username: `aiko_${randomUUID().replaceAll("-", "")}`,
        password: randomBytes(48).toString("base64url"),
        ownerId: null,
        recoveryCode: null,
        session: null,
        retryAt: 0,
      };
      await this.save(owner, record);
      return record;
    }
    const record = identitySchema.parse(JSON.parse(await store.get(ref)));
    if (
      record.baseUrl !== this.baseUrl ||
      record.agentId !== this.options.agentId ||
      record.entityId !== owner
    )
      throw accessFailure("ACCESS_IDENTITY_SCOPE_INVALID");
    if (
      record.session &&
      (record.session.ownerId !== record.ownerId ||
        record.session.username !== record.username)
    )
      throw accessFailure("ACCESS_IDENTITY_SCOPE_INVALID");
    return record;
  }

  private async exchange<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // error-policy:J1 HTTP diagnostics may include passwords or session tokens.
      throw new AccessClientError("unavailable", 0);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccessClientError(
        response.status === 401
          ? "unauthorized"
          : response.status === 409
            ? "conflict"
            : "unavailable",
        response.status,
      );
    }
    try {
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error("JSON required");
      }
      return schema.parse(await response.json());
    } catch {
      // error-policy:J3 Reject invalid auth responses without disclosing their fields.
      throw new AccessClientError("invalid_response", response.status);
    }
  }
  private async authenticate(owner: UUID, record: Identity): Promise<Session> {
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        username: record.username,
        password: record.password,
      }),
    };
    let session: Session;
    let recoveryCode = record.recoveryCode;
    if (record.ownerId === null) {
      try {
        const registration = await this.exchange(
          "/auth/register",
          registrationSchema,
          init,
        );
        recoveryCode = registration.recoveryCode;
        const { recoveryCode: _recovery, ...registered } = registration;
        session = registered;
      } catch (error) {
        // error-policy:J4 Only an unfinished registration may resolve a duplicate using its already-persisted password.
        if (!(error instanceof AccessClientError) || error.status !== 409)
          throw error;
        session = await this.exchange("/auth/login", sessionSchema, init);
      }
    } else {
      session = await this.exchange("/auth/login", sessionSchema, init);
    }
    if (
      session.username !== record.username ||
      (record.ownerId !== null && session.ownerId !== record.ownerId) ||
      session.expiresAt * 1000 <= this.now()
    )
      throw accessFailure("ACCESS_IDENTITY_SCOPE_INVALID");
    // Preserve the one-time recovery code before another network request can fail.
    await this.save(owner, {
      ...record,
      ownerId: session.ownerId,
      recoveryCode,
      session: null,
    });
    const identity = await this.exchange(
      "/auth/me",
      z.object({ ownerId: z.string(), username: z.string() }).strict(),
      {
        headers: {
          authorization: `Bearer ${session.token}`,
          accept: "application/json",
        },
      },
    );
    if (
      identity.ownerId !== session.ownerId ||
      identity.username !== record.username
    )
      throw accessFailure("ACCESS_IDENTITY_SCOPE_INVALID");
    await this.save(owner, {
      ...record,
      ownerId: session.ownerId,
      recoveryCode,
      session,
      retryAt: 0,
    });
    return session;
  }

  /** Backend-only bearer resolver; the caller must supply a connector or HTTP-authenticated entity. */
  async token(owner: UUID, rejectedToken?: string): Promise<string> {
    const key = this.ref(owner);
    const previous = queues.get(key) ?? Promise.resolve();
    const work = previous.then(async () => {
      try {
        const record = await this.read(owner);
        if (record.retryAt > this.now())
          throw new AccessClientError("unavailable", 429);
        if (
          record.session &&
          record.session.expiresAt * 1000 > this.now() + 30_000 &&
          record.session.token !== rejectedToken
        )
          return record.session.token;
        try {
          return (await this.authenticate(owner, record)).token;
        } catch (error) {
          // error-policy:J2 Persist hosted throttling across restarts; ordinary login failure never starts a new registration.
          if (error instanceof AccessClientError && error.status === 429)
            await this.save(owner, {
              ...(await this.read(owner)),
              retryAt: this.now() + 600_000,
            });
          throw error;
        }
      } catch (error) {
        // error-policy:J2 Preserve reviewed codes while redacting every storage/schema diagnostic and nested cause.
        if (error instanceof AccessClientError) throw error;
        const code =
          error instanceof ElizaError &&
          [
            "ACCESS_CREDENTIAL_STORE_REQUIRED",
            "ACCESS_IDENTITY_SCOPE_INVALID",
            "ACCESS_IDENTITY_PERSISTENCE_FAILED",
          ].includes(error.code)
            ? error.code
            : "ACCESS_HOSTED_IDENTITY_FAILED";
        throw accessFailure(code, error);
      }
    });
    // Both branches settle the queue; callers observe the original work rejection below.
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    try {
      return await work;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
    }
  }

  client(owner: UUID) {
    return createAccessClient({
      baseUrl: this.baseUrl,
      token: () => this.token(owner),
      fetch: async (input, init) => {
        const response = await this.fetchImpl(input, init);
        if (response.status !== 401) return response;
        await response.body?.cancel();
        const headers = new Headers(init?.headers);
        const rejected = headers.get("authorization")?.replace(/^Bearer /, "");
        headers.set(
          "authorization",
          `Bearer ${await this.token(owner, rejected)}`,
        );
        // The hosted boundary rejects authentication before dispatch; retry only that explicit refusal, once.
        return this.fetchImpl(input, { ...init, headers });
      },
    });
  }
}

export function runtimeHostedAuth(
  runtime: IAgentRuntime,
  baseUrl: string,
): HostedAccessAuth {
  return new HostedAccessAuth({
    baseUrl,
    agentId: runtime.agentId,
    store: () => {
      const service = runtime.getService<Service & HostedCredentialStore>(
        "connector_credential_store",
      );
      if (!service)
        throw new ElizaError(
          "Start the durable connector credential store before hosted Access onboarding",
          { code: "ACCESS_CREDENTIAL_STORE_REQUIRED" },
        );
      return service;
    },
  });
}
