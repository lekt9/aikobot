/**
 * Wraps a declared plugin so every action handler executes through the effect
 * journal. The wrapper hands the handler its stable operation id and attempt
 * kind in `options`, which a store-backed action can forward as its own
 * idempotency key; validators, providers, and evaluators are left untouched
 * because they observe rather than act.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core/edge";
import { type DeclaredPlugin, effectPolicyOf } from "./compatibility";
import type { BoundaryRecorder } from "./journal";

export const TARDIGRADE_OPERATION_ID_OPTION = "tardigradeOperationId";
export const TARDIGRADE_ATTEMPT_OPTION = "tardigradeAttempt";

function parametersOf(options: Parameters<Action["handler"]>[3]): unknown {
  if (!options || typeof options !== "object") return null;
  const record = options as Record<string, unknown>;
  return record.parameters === undefined ? null : record.parameters;
}

function durableAction(
  action: Action,
  declared: DeclaredPlugin,
  recorder: BoundaryRecorder,
): Action {
  const policy = effectPolicyOf(action, declared.compatibility);
  const handler = async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Parameters<Action["handler"]>[3],
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult | undefined> =>
    recorder.record<ActionResult | undefined>({
      kind: "action",
      name: action.name,
      policy,
      input: {
        action: action.name,
        messageId: message.id ?? null,
        text: message.content.text ?? "",
        parameters: parametersOf(options),
      },
      execute: (context) =>
        action.handler(
          runtime,
          message,
          state,
          {
            ...(options ?? {}),
            [TARDIGRADE_OPERATION_ID_OPTION]: context.operationId,
            [TARDIGRADE_ATTEMPT_OPTION]: context.attempt,
          } as HandlerOptions,
          callback,
          responses,
        ),
    });
  return { ...action, handler };
}

/** The declared plugin with journaled action handlers. */
export function durablePlugin(
  declared: DeclaredPlugin,
  recorder: BoundaryRecorder,
): Plugin {
  const { plugin } = declared;
  if (!plugin.actions?.length) return plugin;
  return {
    ...plugin,
    actions: plugin.actions.map((action) =>
      durableAction(action, declared, recorder),
    ),
  };
}
