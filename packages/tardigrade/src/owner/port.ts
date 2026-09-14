/**
 * The port through which actor threads reach their owner's elizaOS runtime.
 * Every call is keyed: the owner runtime records a started receipt before
 * work and a completed receipt with the output after, so a repeated key is
 * answered from the receipt, a reused key with a different payload is
 * refused, and a receipt left at started — the host died mid-effect — refuses
 * automatic replay with `TARDIGRADE_EFFECT_OUTCOME_UNKNOWN` instead of running
 * the effect twice. Hosts implement the port over Durable Object RPC or an
 * in-process registry; the contract is the same.
 */

import { Context, Effect } from "effect";
import type { Event } from "tardie/core/event";
import { validateOwner } from "../hosts/identity";

export const TARDIGRADE_INVOCATION_KEY_REUSED =
  "TARDIGRADE_INVOCATION_KEY_REUSED";
export const TARDIGRADE_INVOCATION_UNKNOWN_KIND =
  "TARDIGRADE_INVOCATION_UNKNOWN_KIND";
export const TARDIGRADE_INVOCATION_FAILED = "TARDIGRADE_INVOCATION_FAILED";

/** What the owner runtime is asked to do; kinds are registered executors. */
export interface OwnerInvocation {
  /** Stable across retries: actor, instance, thread, and call id. */
  readonly key: string;
  readonly kind: string;
  readonly name: string;
  readonly thread: string;
  readonly turn: string;
  readonly payload: unknown;
}

export interface OwnerInvocationResult {
  readonly result: unknown;
  /** Events the executor asks the thread to append, in order. */
  readonly events: ReadonlyArray<Event>;
  /** True when answered from a completed receipt rather than executed. */
  readonly replayed: boolean;
}

export interface OwnerRuntimePortService {
  readonly owner: string;
  readonly invoke: (
    invocation: OwnerInvocation,
  ) => Effect.Effect<OwnerInvocationResult, never>;
}

/** Per-thread service: the owner's runtime, supplied by the host layer. */
export class OwnerRuntimePort extends Context.Service<
  OwnerRuntimePort,
  OwnerRuntimePortService
>()("elizaos/tardigrade/OwnerRuntimePort") {}

export interface OwnerObjectStub {
  invoke(
    owner: string,
    invocation: OwnerInvocation,
  ): Promise<OwnerInvocationResult>;
}

export interface OwnerObjectNamespace {
  getByName(name: string): OwnerObjectStub;
}

/** The thread-side port that forwards keyed invocations to the owner's object. */
export function ownerObjectPort(
  namespace: OwnerObjectNamespace,
  owner: string,
): OwnerRuntimePortService {
  validateOwner(owner);
  return {
    owner,
    invoke: (invocation) =>
      Effect.promise(() =>
        namespace.getByName(owner).invoke(owner, invocation),
      ),
  };
}
