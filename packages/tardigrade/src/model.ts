/**
 * Model port and the journaled model plugin. The port is the only inference
 * surface a host provides; the plugin registers it under Eliza's canonical
 * text model types and routes every call through the effect journal, so a
 * recovered turn replays the recorded response instead of paying for a second
 * generation. The request handed to the port is the serializable projection of
 * `GenerateTextParams` — complete prompt, messages, and tools, never a slice —
 * and the completeness assertion runs inside the boundary so a truncated
 * output is recorded as the failure it is.
 */

import {
  assertModelOutputComplete,
  type ChatMessage,
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
  type ToolChoice,
  type ToolDefinition,
} from "@elizaos/core/edge";
import type { BoundaryRecorder } from "./journal";

export interface ModelPortToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelPortUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelPortRequest {
  readonly modelType: string;
  readonly prompt?: string;
  readonly messages?: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly toolChoice?: ToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly responseFormat?: GenerateTextParams["responseFormat"];
  readonly stopSequences?: ReadonlyArray<string>;
}

export interface ModelPortResult {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<ModelPortToolCall>;
  readonly finishReason: string;
  readonly model: string;
  readonly usage?: ModelPortUsage;
}

export interface ElizaModelPort {
  readonly provider: string;
  generate(
    request: ModelPortRequest,
    signal?: AbortSignal,
  ): Promise<ModelPortResult>;
}

export const JOURNALED_MODEL_TYPES = [
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_LARGE,
] as const;

/** Projects the runtime's generation params onto the serializable port request. */
export function modelPortRequest(
  modelType: string,
  params: GenerateTextParams,
): ModelPortRequest {
  return {
    modelType,
    ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    ...(params.messages === undefined ? {} : { messages: params.messages }),
    ...(params.tools === undefined ? {} : { tools: params.tools }),
    ...(params.toolChoice === undefined
      ? {}
      : { toolChoice: params.toolChoice }),
    ...(typeof params.maxTokens === "number"
      ? { maxTokens: params.maxTokens }
      : {}),
    ...(typeof params.temperature === "number"
      ? { temperature: params.temperature }
      : {}),
    ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
    ...(params.responseFormat === undefined
      ? {}
      : { responseFormat: params.responseFormat }),
    ...(params.stopSequences === undefined
      ? {}
      : { stopSequences: params.stopSequences }),
  };
}

/**
 * The digest input for a model boundary. Prompts embed host-clock providers
 * (`CURRENT_TIME`) that legitimately differ between the live attempt and a
 * recovered one, so replay identity is structural: the model type, the tool
 * surface offered, the tool choice, and the shape of the transcript. A missing
 * tool on the recovered host still surfaces as a divergence; a moved clock
 * does not.
 */
export function modelRequestFingerprint(
  request: ModelPortRequest,
): Record<string, unknown> {
  return {
    modelType: request.modelType,
    tools: (request.tools ?? []).map((tool) => tool.name).sort(),
    toolChoice: request.toolChoice ?? null,
    responseFormat: request.responseFormat ?? null,
    messages: (request.messages ?? []).map((message) => message.role),
    prompt: request.prompt === undefined ? null : "present",
  };
}

/** Core's native text result carries tool calls beside the text under a string-typed contract. */
interface NativeTextModelResult {
  readonly text: string;
  readonly toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  readonly finishReason: string;
  readonly usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  readonly providerMetadata: { modelName: string };
}

export interface JournaledModelPluginOptions {
  readonly port: ElizaModelPort;
  readonly recorder: BoundaryRecorder;
}

export function createJournaledModelPlugin(
  options: JournaledModelPluginOptions,
): Plugin {
  const handlerFor =
    (modelType: string) =>
    async (
      _runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      const request = modelPortRequest(modelType, params);
      const result = await options.recorder.record<ModelPortResult>({
        kind: "model",
        name: modelType,
        policy: "read",
        input: modelRequestFingerprint(request),
        execute: async () => {
          const generated = await options.port.generate(request, params.signal);
          assertModelOutputComplete({
            finishReason: generated.finishReason,
            provider: options.port.provider,
            model: generated.model,
          });
          return generated;
        },
      });
      if (result.toolCalls.length === 0) return result.text;
      const native: NativeTextModelResult = {
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        finishReason: result.finishReason,
        usage: {
          promptTokens: result.usage?.inputTokens,
          completionTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        },
        providerMetadata: { modelName: result.model },
      };
      return native as unknown as string;
    };
  return {
    name: "tardigrade-journaled-model",
    description: "Journaled text generation through the host's model port.",
    models: Object.fromEntries(
      JOURNALED_MODEL_TYPES.map((type) => [type, handlerFor(type)]),
    ),
    modelMetadata: Object.fromEntries(
      JOURNALED_MODEL_TYPES.map((type) => [type, { streamable: false }]),
    ),
  };
}
