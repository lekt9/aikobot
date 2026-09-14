/**
 * One owner's elizaOS runtime container: the real edge `AgentRuntime` with
 * the durable adapter, kept alive across invocations and driven only through
 * keyed invocations. Each invocation writes a started receipt, runs the
 * registered executor for its kind, persists the adapter, then writes the
 * completed receipt with the output, so a retry after any interruption is
 * answered from the receipt or refused as uncertain — never executed twice.
 * Invocations serialize per owner; the runtime never starts timers
 * (`serverless`), host wakeups arrive as invocations too.
 */

import { createHash } from "node:crypto";
import {
  AgentRuntime,
  type Character,
  ElizaError,
  type IAgentRuntime,
  type Plugin,
  stableStringify,
  type UUID,
} from "@elizaos/core/edge";
import type { Event } from "tardie/core/event";
import { TARDIGRADE_EFFECT_OUTCOME_UNKNOWN } from "../journal";
import type { StateBackend } from "./backend";
import {
  DurableElizaDatabaseAdapter,
  OWNER_ADAPTER_KEY,
} from "./durable-adapter";
import {
  type OwnerInvocation,
  type OwnerInvocationResult,
  TARDIGRADE_INVOCATION_FAILED,
  TARDIGRADE_INVOCATION_KEY_REUSED,
  TARDIGRADE_INVOCATION_UNKNOWN_KIND,
} from "./port";

export const RECEIPT_PREFIX = "/eliza/receipts/";

/** Whether a failed attempt may run again: reads and idempotent work may, unsafe work may not. */
export type OwnerEffectPolicy = "read" | "idempotent" | "unsafe";

export interface OwnerExecutorContext {
  readonly owner: string;
  readonly runtime: AgentRuntime;
  readonly adapter: DurableElizaDatabaseAdapter;
  readonly invocation: OwnerInvocation;
  readonly now: () => number;
}

export interface OwnerExecutorOutput {
  readonly result: unknown;
  readonly events?: ReadonlyArray<Event>;
}

export interface OwnerExecutor {
  readonly policy: OwnerEffectPolicy;
  readonly run: (context: OwnerExecutorContext) => Promise<OwnerExecutorOutput>;
}

export interface OwnerRuntimeOptions {
  readonly owner: string;
  readonly agentId: UUID;
  readonly character: Character;
  readonly plugins: ReadonlyArray<Plugin>;
  readonly backend: StateBackend;
  readonly executors: Readonly<Record<string, OwnerExecutor>>;
  readonly now?: () => number;
  /** Core basic capabilities need a model plugin; fixtures without one turn them off. */
  readonly basicCapabilities?: boolean;
}

export interface OwnerReceipt {
  readonly key: string;
  readonly signature: string;
  readonly kind: string;
  readonly name: string;
  readonly state: "started" | "complete";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly output?: {
    readonly result: unknown;
    readonly events: ReadonlyArray<Event>;
  };
}

export interface OwnerRuntime {
  readonly owner: string;
  invoke(invocation: OwnerInvocation): Promise<OwnerInvocationResult>;
  /** The live runtime, initialized on first use. */
  runtime(): Promise<AgentRuntime>;
  receipt(key: string): OwnerReceipt | undefined;
  close(): Promise<void>;
}

export function invocationSignature(invocation: OwnerInvocation): string {
  return createHash("sha256")
    .update(
      stableStringify({
        kind: invocation.kind,
        name: invocation.name,
        thread: invocation.thread,
        turn: invocation.turn,
        payload: invocation.payload ?? null,
      }),
    )
    .digest("hex");
}

export function receiptKey(key: string): string {
  return `${RECEIPT_PREFIX}${createHash("sha256").update(key).digest("hex")}.json`;
}

/** Builds the owner's container; nothing is opened until the first invocation. */
export function createOwnerRuntime(options: OwnerRuntimeOptions): OwnerRuntime {
  const now = options.now ?? (() => Date.now());
  let opened:
    | Promise<{ runtime: AgentRuntime; adapter: DurableElizaDatabaseAdapter }>
    | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const open = () => {
    opened ??= (async () => {
      const adapter = DurableElizaDatabaseAdapter.open({
        agentId: options.agentId,
        backend: options.backend,
        key: OWNER_ADAPTER_KEY,
      });
      const runtime = new AgentRuntime({
        agentId: options.agentId,
        character: options.character,
        adapter,
        plugins: [...options.plugins],
        logLevel: "error",
        disableBasicCapabilities: options.basicCapabilities === false,
        actionPlanning: true,
        checkShouldRespond: true,
        enableAutonomy: false,
        enableDocuments: false,
        enableRelationships: false,
        enableTrajectories: false,
      });
      // Host wakeups arrive as invocations; the runtime must start no timer.
      (runtime as IAgentRuntime).serverless = true;
      await runtime.initialize({ skipMigrations: true });
      return { runtime, adapter };
    })();
    return opened;
  };

  const readReceipt = (key: string): OwnerReceipt | undefined => {
    const stored = options.backend.read(receiptKey(key));
    return stored === undefined
      ? undefined
      : (JSON.parse(stored) as OwnerReceipt);
  };
  const writeReceipt = (receipt: OwnerReceipt) => {
    options.backend.write(receiptKey(receipt.key), JSON.stringify(receipt));
  };

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };

  const execute = async (
    invocation: OwnerInvocation,
  ): Promise<OwnerInvocationResult> => {
    const executor = options.executors[invocation.kind];
    if (executor === undefined) {
      throw new ElizaError(
        `No executor is registered for owner invocation kind ${invocation.kind}`,
        {
          code: TARDIGRADE_INVOCATION_UNKNOWN_KIND,
          context: {
            owner: options.owner,
            kind: invocation.kind,
            name: invocation.name,
          },
        },
      );
    }
    const signature = invocationSignature(invocation);
    const existing = readReceipt(invocation.key);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new ElizaError(
          "Owner invocation key was reused with a different payload",
          {
            code: TARDIGRADE_INVOCATION_KEY_REUSED,
            context: {
              owner: options.owner,
              key: invocation.key,
              kind: existing.kind,
              name: existing.name,
            },
          },
        );
      }
      if (existing.state === "complete" && existing.output !== undefined) {
        return {
          result: existing.output.result,
          events: existing.output.events,
          replayed: true,
        };
      }
      throw new ElizaError(
        "A prior attempt of this owner invocation has an uncertain outcome; automatic replay refused",
        {
          code: TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
          context: {
            owner: options.owner,
            key: invocation.key,
            kind: existing.kind,
            name: existing.name,
            startedAt: existing.startedAt,
          },
        },
      );
    }
    const { runtime, adapter } = await open();
    const startedAt = now();
    writeReceipt({
      key: invocation.key,
      signature,
      kind: invocation.kind,
      name: invocation.name,
      state: "started",
      startedAt,
    });
    let output: OwnerExecutorOutput;
    try {
      output = await executor.run({
        owner: options.owner,
        runtime,
        adapter,
        invocation,
        now,
      });
    } catch (cause) {
      // error-policy:J2 A read or idempotent attempt may run again, so its started
      // receipt is withdrawn; an unsafe attempt keeps it, refusing silent replay.
      if (executor.policy !== "unsafe")
        options.backend.delete(receiptKey(invocation.key));
      throw new ElizaError(
        `Owner invocation ${invocation.kind}/${invocation.name} failed`,
        {
          code: TARDIGRADE_INVOCATION_FAILED,
          cause: cause instanceof Error ? cause : new Error(String(cause)),
          context: {
            owner: options.owner,
            key: invocation.key,
            policy: executor.policy,
          },
        },
      );
    }
    const events = output.events ?? [];
    // Adapter state and the completed receipt land together: a crash between
    // them leaves the receipt at started, which the next attempt refuses.
    adapter.persist();
    writeReceipt({
      key: invocation.key,
      signature,
      kind: invocation.kind,
      name: invocation.name,
      state: "complete",
      startedAt,
      completedAt: now(),
      output: { result: output.result, events },
    });
    return { result: output.result, events, replayed: false };
  };

  return {
    owner: options.owner,
    invoke: (invocation) => serial(() => execute(invocation)),
    runtime: () => open().then((state) => state.runtime),
    receipt: readReceipt,
    close: async () => {
      if (opened === undefined) return;
      const { runtime } = await opened;
      await runtime.stop();
      opened = undefined;
    },
  };
}
