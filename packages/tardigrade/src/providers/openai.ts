/**
 * OpenAI-compatible chat-completions model port over `fetch`, so the same
 * code serves the Bun host and the Cloudflare Worker without a Node SDK.
 * Messages, tools, and tool choice are projected onto the wire format; the
 * response's text, tool calls, finish reason, and usage are returned complete.
 * Transport and provider failures surface as typed errors, never as an empty
 * reply.
 */

import {
  type ChatMessage,
  ElizaError,
  type ToolChoice,
} from "@elizaos/core/edge";
import type {
  ElizaModelPort,
  ModelPortRequest,
  ModelPortResult,
  ModelPortToolCall,
} from "../model";

export interface OpenAICompatibleModelPortOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly fetch?: typeof fetch;
  /** Extra headers, e.g. OpenRouter attribution. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Sent as `reasoning_effort`. Reasoning gateways such as Codegraff's
   * `deepseek-flash` reject `tool_choice: "required"` unless thinking is
   * suppressed with `"none"`.
   */
  readonly reasoningEffort?: string;
}

export const TARDIGRADE_MODEL_TRANSPORT_FAILED =
  "TARDIGRADE_MODEL_TRANSPORT_FAILED";
export const TARDIGRADE_MODEL_RESPONSE_INVALID =
  "TARDIGRADE_MODEL_RESPONSE_INVALID";

interface WireToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface WireResponse {
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<WireToolCall>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string;
  };
}

function wireToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required")
    return choice;
  if ("type" in choice && choice.type === "function") return choice;
  const name = "name" in choice ? choice.name : undefined;
  return name === undefined
    ? undefined
    : { type: "function", function: { name } };
}

export const TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED =
  "TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED";

type WirePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const unsupported = (role: string, part: unknown): never => {
  throw new ElizaError(
    `Chat message part cannot be sent to a chat-completions endpoint (role ${role})`,
    {
      code: TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED,
      context: {
        role,
        partType: (part as { type?: unknown })?.type ?? typeof part,
      },
    },
  );
};

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as { type?: unknown; value?: unknown };
    if (record.type === "text" && typeof record.value === "string")
      return record.value;
    if (record.type === "json") return JSON.stringify(record.value);
  }
  return JSON.stringify(output);
}

function argumentsText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

/**
 * Projects core's chat messages onto the chat-completions wire form: assistant
 * `tool-call` parts become `tool_calls`, each `tool-result` part becomes one
 * `tool` message, text and image parts keep their content, and any part the
 * wire cannot carry is a typed error rather than a dropped part of the prompt.
 */
export function wireMessages(request: ModelPortRequest): unknown[] {
  if (request.messages === undefined)
    return [{ role: "user", content: request.prompt ?? "" }];
  const wire: unknown[] = [];
  for (const message of request.messages as ReadonlyArray<ChatMessage>) {
    const role = message.role === "developer" ? "system" : message.role;
    const content = message.content;
    if (role === "tool") {
      if (!Array.isArray(content)) {
        wire.push({
          role,
          tool_call_id: message.toolCallId ?? "",
          content: content ?? "",
        });
        continue;
      }
      for (const part of content) {
        const record = part as Record<string, unknown>;
        if (record.type === "tool-result") {
          wire.push({
            role,
            tool_call_id: String(record.toolCallId ?? message.toolCallId ?? ""),
            content: toolOutputText(record.output ?? record.result),
          });
        } else if (record.type === "text") {
          wire.push({
            role,
            tool_call_id: message.toolCallId ?? "",
            content: String(record.text),
          });
        } else {
          unsupported(role, part);
        }
      }
      continue;
    }
    if (role === "assistant") {
      const text: string[] = [];
      const toolCalls = (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: argumentsText(call.arguments) },
      }));
      if (typeof content === "string") text.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          const record = part as Record<string, unknown>;
          if (record.type === "text") text.push(String(record.text));
          else if (record.type === "tool-call") {
            toolCalls.push({
              id: String(record.toolCallId),
              type: "function",
              function: {
                name: String(record.toolName),
                arguments: argumentsText(
                  record.input ?? record.args ?? record.arguments,
                ),
              },
            });
          } else unsupported(role, part);
        }
      }
      wire.push({
        role,
        content: text.length > 0 ? text.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (
      typeof content === "string" ||
      content === undefined ||
      content === null
    ) {
      wire.push({ role, content: content ?? "" });
      continue;
    }
    const parts: WirePart[] = content.map((part) => {
      const record = part as Record<string, unknown>;
      if (record.type === "text")
        return { type: "text", text: String(record.text) };
      if (record.type === "image" && typeof record.image === "string") {
        return { type: "image_url", image_url: { url: record.image } };
      }
      return unsupported(role, part);
    });
    wire.push(
      role === "system"
        ? {
            role,
            content: parts
              .map((part) =>
                part.type === "text" ? part.text : unsupported(role, part),
              )
              .join(""),
          }
        : { role, content: parts },
    );
  }
  return wire;
}

function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // error-policy:J3 a provider may return non-JSON tool arguments; the
    // exact string is preserved so the planner's own validation rejects it.
    return raw;
  }
}

/** A chat-completions port for OpenAI, OpenRouter, Cerebras, and compatible gateways. */
export function createOpenAICompatibleModelPort(
  options: OpenAICompatibleModelPortOptions,
): ElizaModelPort {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/+$/u,
    "",
  );
  const provider = options.provider ?? "openai";
  const doFetch = options.fetch ?? fetch;
  return {
    provider,
    async generate(request, signal): Promise<ModelPortResult> {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: wireMessages(request),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  ...(tool.description
                    ? { description: tool.description }
                    : {}),
                  parameters: tool.parameters ?? {
                    type: "object",
                    properties: {},
                  },
                  ...(tool.strict === true ? { strict: true } : {}),
                },
              })),
            }
          : {}),
        ...(request.tools?.length && request.toolChoice !== undefined
          ? { tool_choice: wireToolChoice(request.toolChoice) }
          : {}),
        ...(typeof request.maxTokens === "number"
          ? { max_completion_tokens: request.maxTokens }
          : {}),
        ...(typeof request.temperature === "number"
          ? { temperature: request.temperature }
          : {}),
        ...(typeof request.topP === "number" ? { top_p: request.topP } : {}),
        ...(request.stopSequences?.length
          ? { stop: [...request.stopSequences] }
          : {}),
        ...(request.responseFormat && typeof request.responseFormat === "object"
          ? { response_format: request.responseFormat }
          : {}),
        ...(options.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      };
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            ...options.headers,
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // error-policy:J2 the transport failure is wrapped with the provider
        // and model so the turn's failure names the boundary that broke.
        throw new ElizaError(
          `[${provider}] model request failed before a response`,
          {
            code: TARDIGRADE_MODEL_TRANSPORT_FAILED,
            context: { provider, model: options.model, baseUrl },
            cause: error,
          },
        );
      }
      const text = await response.text();
      let payload: WireResponse;
      try {
        payload = JSON.parse(text) as WireResponse;
      } catch (error) {
        throw new ElizaError(
          `[${provider}] model response was not JSON (${response.status})`,
          {
            code: TARDIGRADE_MODEL_RESPONSE_INVALID,
            context: {
              provider,
              model: options.model,
              status: response.status,
              body: text,
            },
            cause: error,
          },
        );
      }
      if (!response.ok || payload.error) {
        throw new ElizaError(
          `[${provider}] model request rejected (${response.status}): ${payload.error?.message ?? text}`,
          {
            code: TARDIGRADE_MODEL_RESPONSE_INVALID,
            context: {
              provider,
              model: options.model,
              status: response.status,
              ...(payload.error ? { error: payload.error } : {}),
            },
          },
        );
      }
      const choice = payload.choices?.[0];
      if (!choice?.message) {
        throw new ElizaError(`[${provider}] model response carried no choice`, {
          code: TARDIGRADE_MODEL_RESPONSE_INVALID,
          context: { provider, model: options.model, body: text },
        });
      }
      const toolCalls: ModelPortToolCall[] = (
        choice.message.tool_calls ?? []
      ).flatMap((call, index) =>
        call.function?.name
          ? [
              {
                id: call.id ?? `call-${index}`,
                name: call.function.name,
                arguments: parseArguments(call.function.arguments),
              },
            ]
          : [],
      );
      return {
        text: choice.message.content ?? "",
        toolCalls,
        finishReason: choice.finish_reason ?? "stop",
        model: payload.model ?? options.model,
        usage: {
          inputTokens: payload.usage?.prompt_tokens,
          outputTokens: payload.usage?.completion_tokens,
          totalTokens: payload.usage?.total_tokens,
        },
      };
    },
  };
}

/** Reads the port configuration from a host environment map. */
export function openAICompatibleModelPortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ElizaModelPort {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ElizaError(
      "OPENAI_API_KEY is required for the Tardigrade model port",
      {
        code: "TARDIGRADE_MODEL_CREDENTIAL_MISSING",
        context: { variable: "OPENAI_API_KEY" },
      },
    );
  }
  return createOpenAICompatibleModelPort({
    apiKey,
    model: env.ELIZA_TARDIGRADE_MODEL ?? "gpt-5-mini",
    ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
    provider: env.ELIZA_TARDIGRADE_MODEL_PROVIDER ?? "openai",
    ...(env.ELIZA_TARDIGRADE_REASONING_EFFORT
      ? { reasoningEffort: env.ELIZA_TARDIGRADE_REASONING_EFFORT }
      : {}),
  });
}
