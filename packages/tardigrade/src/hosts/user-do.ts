/**
 * The owner Durable Object: one per owner, holding that owner's elizaOS
 * runtime and its SQLite-backed adapter. Actor threads reach it through the
 * `OWNERS` namespace with the keyed invocation contract; the object checks
 * that the caller's owner is its own identity before opening any state, and
 * syncs storage after every committed invocation so a completed receipt is
 * durable before the thread continues.
 */

import { DurableObject } from "cloudflare:workers";
import type { StateBackend } from "../owner/backend";
import {
  type OwnerInvocation,
  type OwnerInvocationOutcome,
  TARDIGRADE_INVOCATION_FAILED,
} from "../owner/port";
import {
  createOwnerRuntime,
  type OwnerRuntime,
  type OwnerRuntimeOptions,
} from "../owner/runtime";
import { validateOwner } from "./identity";
import { durableObjectBackend } from "./storage";

export interface OwnerObjectOptions<WorkerEnv> {
  /** Everything but the owner and backend; the object opens its own backend. */
  readonly build: (
    owner: string,
    env: WorkerEnv,
    backend: StateBackend,
  ) => Omit<OwnerRuntimeOptions, "owner" | "backend">;
}

/** Defines the `OwnerDO` class a Worker exports and binds as `OWNERS`. */
export function defineOwnerObject<WorkerEnv>(
  options: OwnerObjectOptions<WorkerEnv>,
) {
  return class OwnerDO extends DurableObject<WorkerEnv> {
    private owner: OwnerRuntime | undefined;

    private runtimeFor(owner: string): OwnerRuntime {
      if (this.ctx.id.name !== validateOwner(owner)) {
        throw new Error(
          "owner object identity mismatch: foreign owner refused",
        );
      }
      const backend = durableObjectBackend(this.ctx.storage);
      this.owner ??= createOwnerRuntime({
        ...options.build(owner, this.env, backend),
        owner,
        backend,
      });
      return this.owner;
    }

    async invoke(
      owner: string,
      invocation: OwnerInvocation,
    ): Promise<OwnerInvocationOutcome> {
      // A foreign owner is a routing invariant, not a turn-level refusal: it
      // rejects hard and must never resolve to an outcome.
      const runtime = this.runtimeFor(owner);
      try {
        try {
          return { ok: true, value: await runtime.invoke(invocation) };
        } catch (cause) {
          // The owner runtime already re-raised the executor's own code; carry
          // it back as data so it survives the RPC boundary intact.
          const error = cause as { code?: unknown; message?: unknown };
          return {
            ok: false,
            code:
              typeof error?.code === "string"
                ? error.code
                : TARDIGRADE_INVOCATION_FAILED,
            message:
              typeof error?.message === "string"
                ? error.message
                : String(cause),
          };
        }
      } finally {
        await this.ctx.storage.sync();
      }
    }
  };
}
