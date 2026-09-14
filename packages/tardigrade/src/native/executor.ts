/**
 * The elizaOS half of the native adapter: what actually runs inside an
 * owner's runtime when the Tardigrade engine decides to do something. The
 * engine never holds an `IAgentRuntime`; it sends keyed invocations, and
 * these executors turn each one into real elizaOS work — composing provider
 * context, validating and running one action with its callback deliveries,
 * or running the evaluator pipeline over a completed turn.
 *
 * Replay policy is carried by the invocation kind, because the owner
 * runtime's receipt table treats reads and idempotent work as retryable and
 * unsafe work as unknown-outcome after an interruption. An action is routed
 * to `action.read` / `action.idempotent` / `action.unsafe` by the same
 * `effectPolicyOf` classification the journaled boundaries already use, so
 * one declaration governs both hosts.
 *
 * Nothing here truncates model-facing content: provider text is returned
 * whole, and an action's result keeps every field its handler produced.
 */

import {
  ChannelType,
  type Content,
  createMessageMemory,
  ElizaError,
  type Evaluator,
  type HandlerCallback,
  type Memory,
  resolveEntityRole,
  type State,
  type UUID,
} from "@elizaos/core/edge";
import { satisfiesRoleGate } from "@elizaos/core/runtime/context-gates";
import type {
  DeclaredPlugin,
  TardigradePluginCompatibility,
} from "../compatibility";
import { effectPolicyOf } from "../compatibility";
import type { ElizaEffectPolicy } from "../events";
import type { OwnerExecutor, OwnerExecutorContext } from "../owner/runtime";
import {
  elizaAssistantMemoryId,
  elizaPrincipalEntityId,
  elizaRoomId,
  elizaUserMemoryId,
  elizaWorldId,
} from "../turn";

export const TARDIGRADE_ACTION_UNKNOWN = "TARDIGRADE_ACTION_UNKNOWN";
export const TARDIGRADE_ACTION_POLICY_MISMATCH =
  "TARDIGRADE_ACTION_POLICY_MISMATCH";
export const TARDIGRADE_EVALUATOR_SERVICE_MISSING =
  "TARDIGRADE_EVALUATOR_SERVICE_MISSING";
export const TARDIGRADE_ROLE_REFUSED = "TARDIGRADE_ROLE_REFUSED";
export const TARDIGRADE_ACTION_VALIDATION_REFUSED =
  "TARDIGRADE_ACTION_VALIDATION_REFUSED";

/** The conversation coordinates one native turn runs in. */
export interface NativeTurnRef {
  readonly owner: string;
  readonly sender: string;
  readonly source: string;
  readonly roomKey: string;
  readonly turn: string;
  readonly text: string;
  readonly at: number;
}

export interface NativeContextInput {
  readonly turn: NativeTurnRef;
  /** Provider names to include; omitted means the runtime's default set. */
  readonly providers?: ReadonlyArray<string>;
}

export interface NativeContextOutput {
  /** The complete composed provider text, never truncated. */
  readonly text: string;
  readonly values: Record<string, unknown>;
  readonly providers: ReadonlyArray<string>;
}

export interface NativeActionInput {
  readonly turn: NativeTurnRef;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
}

export interface NativeActionOutput {
  readonly success: boolean;
  readonly action: string;
  readonly text?: string;
  readonly values?: Record<string, unknown>;
  readonly data?: unknown;
  readonly error?: string;
  readonly code?: string;
  /** Every content the handler delivered through its callback, in order. */
  readonly deliveries: ReadonlyArray<DeliveredContent>;
  readonly effectReceipts?: ReadonlyArray<unknown>;
  readonly userFacingText?: string;
  readonly verifiedUserFacing?: boolean;
  readonly userFacingEffectReceiptIds?: ReadonlyArray<string>;
}

export interface DeliveredContent {
  readonly text: string;
  readonly actionName?: string;
}

export interface NativeEvaluateInput {
  readonly turn: NativeTurnRef;
  /** The user-facing reply the engine settled on for this turn. */
  readonly reply: string;
}

export interface NativeEvaluateOutput {
  readonly skipped: boolean;
  readonly activeEvaluators: ReadonlyArray<string>;
  readonly processedEvaluators: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<{
    readonly evaluatorName: string;
    readonly error: string;
  }>;
}

export interface NativeExecutorOptions {
  readonly agentKey: string;
  /** The deployment's declared plugin set; its compatibility fixes each action's policy. */
  readonly plugins: ReadonlyArray<DeclaredPlugin>;
}

const ACTION_KIND_BY_POLICY: Record<ElizaEffectPolicy, string> = {
  read: "action.read",
  idempotent: "action.idempotent",
  unsafe: "action.unsafe",
};

/** The invocation kind an action must be sent as, from its declared effects. */
export function actionKindOf(
  action: { readonly name: string; readonly tags?: string[] },
  compatibility: TardigradePluginCompatibility,
): string {
  return ACTION_KIND_BY_POLICY[effectPolicyOf(action, compatibility)];
}

/** Action name to the compatibility declaration of the plugin that owns it. */
export function actionCompatibilityIndex(
  plugins: ReadonlyArray<DeclaredPlugin>,
): ReadonlyMap<string, TardigradePluginCompatibility> {
  const index = new Map<string, TardigradePluginCompatibility>();
  for (const declared of plugins) {
    for (const action of declared.plugin.actions ?? []) {
      index.set(action.name, declared.compatibility);
    }
  }
  return index;
}

interface Principals {
  readonly ownerEntityId: UUID;
  readonly senderEntityId: UUID;
  readonly roomId: UUID;
  readonly worldId: UUID;
}

/**
 * Binds the owner and sender to the thread's room. The host authenticated
 * the owner before the invocation reached this runtime, which is the manual
 * source core requires before it honors an explicit OWNER grant.
 */
async function connectPrincipals(
  context: OwnerExecutorContext,
  options: NativeExecutorOptions,
  turn: NativeTurnRef,
): Promise<Principals> {
  const { runtime } = context;
  const roomId = elizaRoomId(options.agentKey, turn.roomKey);
  const worldId = elizaWorldId(options.agentKey, turn.roomKey);
  const ownerEntityId = elizaPrincipalEntityId(options.agentKey, turn.owner);
  const senderEntityId = elizaPrincipalEntityId(options.agentKey, turn.sender);
  const roles: Record<string, string> = { [ownerEntityId]: "OWNER" };
  const roleSources: Record<string, string> = { [ownerEntityId]: "manual" };
  if (senderEntityId !== ownerEntityId) {
    roles[senderEntityId] = "GUEST";
    roleSources[senderEntityId] = "manual";
  }
  for (const [entityId, userName] of [
    [ownerEntityId, turn.owner],
    ...(senderEntityId === ownerEntityId
      ? []
      : [[senderEntityId, turn.sender] as const]),
  ] as const) {
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      userName,
      source: turn.source,
      type: ChannelType.DM,
      metadata: { roles, roleSources },
    });
  }
  return { ownerEntityId, senderEntityId, roomId, worldId };
}

/** The turn's inbound message, recorded once so later turns recall it. */
async function inboundMemory(
  context: OwnerExecutorContext,
  turn: NativeTurnRef,
  principals: Principals,
): Promise<Memory> {
  const message = createMessageMemory({
    id: elizaUserMemoryId(turn.turn),
    entityId: principals.senderEntityId,
    agentId: context.runtime.agentId,
    roomId: principals.roomId,
    content: {
      text: turn.text,
      source: turn.source,
      channelType: ChannelType.DM,
      chatIdempotency: { version: 1, clientMessageId: turn.turn },
    },
  });
  message.createdAt = turn.at;
  if (message.metadata) message.metadata.timestamp = turn.at;
  const existing = await context.adapter.getMemoriesByIds([message.id as UUID]);
  if (existing.length === 0) {
    await context.adapter.createMemories([
      { tableName: "messages", memory: message },
    ]);
  }
  return message;
}

async function senderRoles(
  context: OwnerExecutorContext,
  principals: Principals,
): Promise<string[]> {
  const world = await context.runtime.getWorld(principals.worldId);
  const metadata = world?.metadata as
    | Parameters<typeof resolveEntityRole>[2]
    | undefined;
  const role = await resolveEntityRole(
    context.runtime,
    world,
    metadata,
    principals.senderEntityId,
  );
  return [String(role)];
}

function actionOf(context: OwnerExecutorContext, name: string) {
  const action = context.runtime.actions.find(
    (candidate) => candidate.name === name,
  );
  if (action === undefined) {
    throw new ElizaError(`No declared action named ${name} is registered`, {
      code: TARDIGRADE_ACTION_UNKNOWN,
      context: {
        owner: context.owner,
        action: name,
        available: context.runtime.actions.map((candidate) => candidate.name),
      },
    });
  }
  return action;
}

/** Runs one action, capturing everything it delivered through its callback. */
async function runAction(
  context: OwnerExecutorContext,
  options: NativeExecutorOptions,
  compatibilities: ReadonlyMap<string, TardigradePluginCompatibility>,
  expected: ElizaEffectPolicy,
): Promise<{ result: NativeActionOutput }> {
  const input = context.invocation.payload as NativeActionInput;
  const action = actionOf(context, input.action);
  const compatibility = compatibilities.get(action.name);
  if (compatibility === undefined) {
    throw new ElizaError(
      `Action ${action.name} belongs to no declared plugin, so it has no effect policy`,
      {
        code: TARDIGRADE_ACTION_UNKNOWN,
        context: { owner: context.owner, action: action.name },
      },
    );
  }
  const policy = effectPolicyOf(action, compatibility);
  if (policy !== expected) {
    // The engine routes by declared policy; a mismatch would silently change
    // this call's replay semantics, so it is refused rather than executed.
    throw new ElizaError(
      `Action ${action.name} is declared ${policy} but was invoked as ${expected}`,
      {
        code: TARDIGRADE_ACTION_POLICY_MISMATCH,
        context: {
          owner: context.owner,
          action: action.name,
          policy,
          expected,
        },
      },
    );
  }
  const principals = await connectPrincipals(context, options, input.turn);
  const message = await inboundMemory(context, input.turn, principals);
  const roles = await senderRoles(context, principals);
  if (!satisfiesRoleGate(roles as never, action.roleGate)) {
    return {
      result: {
        success: false,
        action: action.name,
        code: TARDIGRADE_ROLE_REFUSED,
        error: `${input.turn.sender} holds ${roles.join(", ")}, which does not satisfy the role gate of ${action.name}`,
        deliveries: [],
      },
    };
  }
  const state: State = await context.runtime.composeState(message, undefined);
  const parameters = input.parameters ?? {};
  const valid = await action.validate(context.runtime, message, state, {
    parameters,
  } as never);
  if (!valid) {
    return {
      result: {
        success: false,
        action: action.name,
        code: TARDIGRADE_ACTION_VALIDATION_REFUSED,
        error: `${action.name} refused these parameters`,
        deliveries: [],
      },
    };
  }
  const deliveries: DeliveredContent[] = [];
  const callback: HandlerCallback = async (
    content: Content,
    actionName?: string,
  ) => {
    const text = typeof content.text === "string" ? content.text : "";
    if (text.length > 0) {
      deliveries.push(
        actionName === undefined ? { text } : { text, actionName },
      );
    }
    return [];
  };
  const result = await action.handler(
    context.runtime,
    message,
    state,
    { parameters } as never,
    callback,
  );
  return {
    result: {
      success: result?.success === true,
      action: action.name,
      deliveries,
      ...(result?.text === undefined ? {} : { text: result.text }),
      ...(result?.values === undefined
        ? {}
        : { values: result.values as Record<string, unknown> }),
      ...(result?.data === undefined ? {} : { data: result.data }),
      ...(result?.error === undefined
        ? {}
        : {
            error:
              result.error instanceof Error
                ? result.error.message
                : String(result.error),
          }),
      ...(result?.effectReceipts === undefined
        ? {}
        : { effectReceipts: result.effectReceipts }),
      ...(result?.userFacingText === undefined
        ? {}
        : { userFacingText: result.userFacingText }),
      ...(result?.verifiedUserFacing === undefined
        ? {}
        : { verifiedUserFacing: result.verifiedUserFacing }),
      ...(result?.userFacingEffectReceiptIds === undefined
        ? {}
        : { userFacingEffectReceiptIds: result.userFacingEffectReceiptIds }),
    },
  };
}

/**
 * The executors an owner runtime registers for the native engine. Hosts may
 * merge further kinds (scheduling ticks, remote packages) into this map.
 */
export function nativeExecutors(
  options: NativeExecutorOptions,
): Record<string, OwnerExecutor> {
  const compatibilities = actionCompatibilityIndex(options.plugins);
  return {
    context: {
      policy: "read",
      run: async (context) => {
        const input = context.invocation.payload as NativeContextInput;
        const principals = await connectPrincipals(
          context,
          options,
          input.turn,
        );
        const message = await inboundMemory(context, input.turn, principals);
        const state = await context.runtime.composeState(
          message,
          input.providers === undefined ? undefined : [...input.providers],
        );
        const composed: NativeContextOutput = {
          text: typeof state.text === "string" ? state.text : "",
          values: (state.values ?? {}) as Record<string, unknown>,
          providers:
            input.providers === undefined
              ? context.runtime.providers.map((provider) => provider.name)
              : [...input.providers],
        };
        return { result: composed };
      },
    },
    "action.read": {
      policy: "read",
      run: (context) => runAction(context, options, compatibilities, "read"),
    },
    "action.idempotent": {
      policy: "idempotent",
      run: (context) =>
        runAction(context, options, compatibilities, "idempotent"),
    },
    "action.unsafe": {
      policy: "unsafe",
      run: (context) => runAction(context, options, compatibilities, "unsafe"),
    },
    evaluate: {
      policy: "idempotent",
      run: async (context) => {
        const input = context.invocation.payload as NativeEvaluateInput;
        const principals = await connectPrincipals(
          context,
          options,
          input.turn,
        );
        const message = await inboundMemory(context, input.turn, principals);
        if (input.reply.length > 0) {
          const replyId = elizaAssistantMemoryId(input.turn.turn);
          const existing = await context.adapter.getMemoriesByIds([replyId]);
          if (existing.length === 0) {
            const reply = createMessageMemory({
              id: replyId,
              entityId: context.runtime.agentId,
              agentId: context.runtime.agentId,
              roomId: principals.roomId,
              content: {
                text: input.reply,
                source: input.turn.source,
                channelType: ChannelType.DM,
                inReplyTo: message.id as UUID,
              },
            });
            reply.createdAt = context.now();
            await context.adapter.createMemories([
              { tableName: "messages", memory: reply },
            ]);
          }
        }
        const evaluators = context.runtime.evaluators as ReadonlyArray<
          Evaluator<unknown, unknown>
        >;
        if (evaluators.length === 0) {
          const empty: NativeEvaluateOutput = {
            skipped: true,
            activeEvaluators: [],
            processedEvaluators: [],
            errors: [],
          };
          return { result: empty };
        }
        const service = context.runtime.getService("evaluator") as {
          run?: (
            message: Memory,
            state?: State,
            options?: Record<string, unknown>,
          ) => Promise<{
            skipped: boolean;
            activeEvaluators: string[];
            processedEvaluators: string[];
            errors: Array<{ evaluatorName: string; error: string }>;
          }>;
        } | null;
        if (service?.run === undefined) {
          throw new ElizaError(
            "The owner runtime registered evaluators without an evaluator service",
            {
              code: TARDIGRADE_EVALUATOR_SERVICE_MISSING,
              context: {
                owner: context.owner,
                evaluators: evaluators.map((evaluator) => evaluator.name),
              },
            },
          );
        }
        const state = await context.runtime.composeState(message, undefined);
        const outcome = await service.run(message, state);
        const summary: NativeEvaluateOutput = {
          skipped: outcome.skipped,
          activeEvaluators: outcome.activeEvaluators,
          processedEvaluators: outcome.processedEvaluators,
          errors: outcome.errors.map((entry) => ({
            evaluatorName: entry.evaluatorName,
            error: entry.error,
          })),
        };
        return { result: summary };
      },
    },
  };
}
