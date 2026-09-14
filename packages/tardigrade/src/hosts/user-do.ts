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
import type { OwnerInvocation, OwnerInvocationResult } from "../owner/port";
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
    ): Promise<OwnerInvocationResult> {
      const runtime = this.runtimeFor(owner);
      try {
        return await runtime.invoke(invocation);
      } finally {
        await this.ctx.storage.sync();
      }
    }
  };
}
