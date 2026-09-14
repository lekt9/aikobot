/**
 * Bun host owner registry: one owner runtime per owner, each on its own
 * `bun:sqlite` file under the storage directory, opened on first use and
 * shared by every thread of that owner in the process. The port it hands a
 * thread layer is the same keyed-invocation contract the Cloudflare owner
 * object implements over RPC.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { validateOwner } from "../hosts/identity";
import type { OwnerInvocation, OwnerRuntimePortService } from "./port";
import {
  createOwnerRuntime,
  type OwnerRuntime,
  type OwnerRuntimeOptions,
} from "./runtime";
import { type SqliteBackend, sqliteBackend } from "./sqlite-backend";

export interface BunOwnerRegistryOptions {
  /** Directory holding one SQLite file per owner. */
  readonly dir: string;
  /** Everything but the owner and backend, which the registry supplies. */
  readonly build: (
    owner: string,
  ) => Omit<OwnerRuntimeOptions, "owner" | "backend">;
}

export interface BunOwnerRegistry {
  forOwner(owner: string): OwnerRuntime;
  portFor(owner: string): OwnerRuntimePortService;
  /** The SQLite path an owner's state lives at. */
  pathFor(owner: string): string;
  close(): Promise<void>;
}

export function bunOwnerRegistry(
  options: BunOwnerRegistryOptions,
): BunOwnerRegistry {
  const runtimes = new Map<
    string,
    { runtime: OwnerRuntime; backend: SqliteBackend }
  >();
  const pathFor = (owner: string) =>
    join(
      options.dir,
      `${createHash("sha256").update(validateOwner(owner)).digest("hex")}.sqlite`,
    );
  const forOwner = (owner: string): OwnerRuntime => {
    validateOwner(owner);
    let entry = runtimes.get(owner);
    if (entry === undefined) {
      const backend = sqliteBackend(pathFor(owner));
      entry = {
        runtime: createOwnerRuntime({
          ...options.build(owner),
          owner,
          backend,
        }),
        backend,
      };
      runtimes.set(owner, entry);
    }
    return entry.runtime;
  };
  return {
    forOwner,
    pathFor,
    portFor: (owner) => ({
      owner,
      invoke: (invocation: OwnerInvocation) =>
        Effect.promise(() => forOwner(owner).invoke(invocation)),
    }),
    close: async () => {
      for (const [owner, entry] of runtimes) {
        await entry.runtime.close();
        entry.backend.close();
        runtimes.delete(owner);
      }
    },
  };
}
