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

import { Context, Data, Effect } from "effect";
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

/**
 * A refused or failed invocation. It is a typed failure rather than a defect
 * so a caller can answer the model honestly — an uncertain effect must be
 * reported, never retried behind the model's back or silently swallowed.
 */
export class OwnerInvocationError extends Data.TaggedError(
  "OwnerInvocationError",
)<{
  readonly owner: string;
  readonly key: string;
  readonly kind: string;
  readonly name: string;
  readonly code: string;
  readonly message: string;
}> {}

/** Wraps whatever an owner runtime threw as a typed invocation failure. */
export function ownerInvocationError(
  owner: string,
  invocation: OwnerInvocation,
  cause: unknown,
): OwnerInvocationError {
  const error = cause as { code?: string; message?: string };
  return new OwnerInvocationError({
    owner,
    key: invocation.key,
    kind: invocation.kind,
    name: invocation.name,
    code:
      typeof error?.code === "string"
        ? error.code
        : "TARDIGRADE_INVOCATION_FAILED",
    message: typeof error?.message === "string" ? error.message : String(cause),
  });
}

export interface OwnerRuntimePortService {
  readonly owner: string;
  readonly invoke: (
    invocation: OwnerInvocation,
  ) => Effect.Effect<OwnerInvocationResult, OwnerInvocationError>;
}

/** Per-thread service: the owner's runtime, supplied by the host layer. */
export class OwnerRuntimePort extends Context.Service<
  OwnerRuntimePort,
  OwnerRuntimePortService
>()("elizaos/tardigrade/OwnerRuntimePort") {}

/**
 * What one owner Durable Object hands back across the RPC boundary. A thrown
 * Error loses its custom `code` in transit, so a refused invocation is
 * returned as data rather than thrown: `ok: false` carries the executor's own
 * code to the caller, and only a hard routing refusal (a foreign owner) still
 * rejects the promise.
 */
export type OwnerInvocationOutcome =
  | { readonly ok: true; readonly value: OwnerInvocationResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface OwnerObjectStub {
  invoke(
    owner: string,
    invocation: OwnerInvocation,
  ): Promise<OwnerInvocationOutcome>;
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
      Effect.tryPromise({
        // A rejected promise is a transport or routing failure (a foreign
        // owner), never a plain executor refusal; either way it is a typed
        // failure the caller can answer, not a defect that kills the turn.
        try: () => namespace.getByName(owner).invoke(owner, invocation),
        catch: (cause) => ownerInvocationError(owner, invocation, cause),
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok
            ? Effect.succeed(outcome.value)
            : Effect.fail(
                new OwnerInvocationError({
                  owner,
                  key: invocation.key,
                  kind: invocation.kind,
                  name: invocation.name,
                  code: outcome.code,
                  message: outcome.message,
                }),
              ),
        ),
      ),
  };
}
