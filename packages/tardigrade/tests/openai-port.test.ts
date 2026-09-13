/**
 * OpenAI-compatible model port contract against a local HTTP boundary: the
 * wire request carries complete messages and tools, tool calls and usage come
 * back typed, and transport, rejection, and malformed responses are typed
 * errors. Deterministic; Bun.serve stands in for the provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/edge";
import {
  createOpenAICompatibleModelPort,
  openAICompatibleModelPortFromEnv,
  TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED,
  TARDIGRADE_MODEL_RESPONSE_INVALID,
  TARDIGRADE_MODEL_TRANSPORT_FAILED,
  wireMessages,
} from "../src/providers/openai";

let server: ReturnType<typeof Bun.serve>;
const received: Array<{
  headers: Record<string, string>;
  body: Record<string, unknown>;
}> = [];
let mode: "tool" | "text" | "rejected" | "garbage" = "text";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      received.push({
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });
      if (mode === "garbage")
        return new Response("<html>not json</html>", { status: 200 });
      if (mode === "rejected") {
        return Response.json(
          { error: { message: "insufficient_quota", type: "billing" } },
          { status: 429 },
        );
      }
      if (mode === "tool") {
        return Response.json({
          model: "mock-tool-model",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "TODO",
                      arguments: JSON.stringify({
                        action: "create",
                        content: "x",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        });
      }
      return Response.json({
        model: "mock-text-model",
        choices: [
          { message: { content: "plain answer" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const portFor = () =>
  createOpenAICompatibleModelPort({
    apiKey: "test-key",
    model: "requested-model",
    baseUrl: `http://127.0.0.1:${server.port}/v1/`,
    provider: "mock",
    headers: { "x-title": "eliza-tardigrade" },
  });

describe("openai-compatible model port", () => {
  test("sends complete messages and tools and returns typed tool calls with usage", async () => {
    mode = "tool";
    received.length = 0;
    const result = await portFor().generate({
      modelType: "ACTION_PLANNER",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "add x" },
      ],
      tools: [
        {
          name: "TODO",
          description: "Manage todos",
          parameters: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        { name: "REPLY" },
      ],
      toolChoice: "required",
      maxTokens: 200,
      temperature: 0.2,
    });
    expect(result).toEqual({
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "TODO",
          arguments: { action: "create", content: "x" },
        },
      ],
      finishReason: "tool_calls",
      model: "mock-tool-model",
      usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
    });
    const wire = received[0];
    expect(wire.headers.authorization).toBe("Bearer test-key");
    expect(wire.headers["x-title"]).toBe("eliza-tardigrade");
    expect(wire.body.model).toBe("requested-model");
    expect(wire.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "add x" },
    ]);
    expect((wire.body.tools as unknown[]).length).toBe(2);
    expect(
      (
        wire.body.tools as Array<{
          function: { name: string; parameters: unknown };
        }>
      )[1].function.parameters,
    ).toEqual({
      type: "object",
      properties: {},
    });
    expect(wire.body.tool_choice).toBe("required");
    expect(wire.body.max_completion_tokens).toBe(200);
    expect(wire.body.temperature).toBe(0.2);
    expect(wire.body.reasoning_effort).toBeUndefined();
  });

  test("returns plain text with the provider's finish reason and a prompt-only request as one user message", async () => {
    mode = "text";
    received.length = 0;
    const result = await portFor().generate({
      modelType: "TEXT_LARGE",
      prompt: "hello",
    });
    expect(result.text).toBe("plain answer");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(received[0].body.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(received[0].body.tools).toBeUndefined();
  });

  test("rejections, malformed bodies, and transport failures are typed errors", async () => {
    mode = "rejected";
    const rejected = await portFor()
      .generate({ modelType: "TEXT_SMALL", prompt: "x" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(rejected).toBeInstanceOf(ElizaError);
    expect((rejected as ElizaError).code).toBe(
      TARDIGRADE_MODEL_RESPONSE_INVALID,
    );
    expect((rejected as ElizaError).message).toContain("insufficient_quota");
    expect((rejected as ElizaError).context?.status).toBe(429);

    mode = "garbage";
    const garbage = await portFor()
      .generate({ modelType: "TEXT_SMALL", prompt: "x" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((garbage as ElizaError).code).toBe(
      TARDIGRADE_MODEL_RESPONSE_INVALID,
    );

    const unreachable = createOpenAICompatibleModelPort({
      apiKey: "k",
      model: "m",
      baseUrl: "http://127.0.0.1:1",
      provider: "dead",
    });
    const transport = await unreachable
      .generate({ modelType: "TEXT_SMALL", prompt: "x" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((transport as ElizaError).code).toBe(
      TARDIGRADE_MODEL_TRANSPORT_FAILED,
    );
    expect((transport as ElizaError).cause).toBeDefined();
  });

  test("environment construction requires the credential and honors overrides", async () => {
    expect(() => openAICompatibleModelPortFromEnv({})).toThrow(
      "OPENAI_API_KEY",
    );
    const port = openAICompatibleModelPortFromEnv({
      OPENAI_API_KEY: "k",
      ELIZA_TARDIGRADE_MODEL_PROVIDER: "openrouter",
    });
    expect(port.provider).toBe("openrouter");
    mode = "text";
    received.length = 0;
    await createOpenAICompatibleModelPort({
      apiKey: "k",
      model: "deepseek-flash",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      reasoningEffort: "none",
    }).generate({ modelType: "TEXT_SMALL", prompt: "x" });
    expect(received[0].body.reasoning_effort).toBe("none");
  });

  test("projects tool-call and tool-result parts onto the chat-completions wire form", () => {
    const wire = wireMessages({
      modelType: "RESPONSE_HANDLER",
      messages: [
        {
          role: "developer",
          content: [
            { type: "text", text: "sys-a" },
            { type: "text", text: "sys-b" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "add it" },
            { type: "image", image: "https://x/y.png" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking" },
            {
              type: "tool-call",
              toolCallId: "plan-2",
              toolName: "TODO",
              input: { action: "create" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "plan-2",
              toolName: "TODO",
              output: { type: "text", value: "done" },
            },
            {
              type: "tool-result",
              toolCallId: "plan-3",
              toolName: "TODO",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "REPLY", arguments: { text: "hi" } }],
        },
      ],
    });
    expect(wire).toEqual([
      { role: "system", content: "sys-asys-b" },
      {
        role: "user",
        content: [
          { type: "text", text: "add it" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
      {
        role: "assistant",
        content: "thinking",
        tool_calls: [
          {
            id: "plan-2",
            type: "function",
            function: { name: "TODO", arguments: '{"action":"create"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "plan-2", content: "done" },
      { role: "tool", tool_call_id: "plan-3", content: '{"ok":true}' },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "REPLY", arguments: '{"text":"hi"}' },
          },
        ],
      },
    ]);
    const failure = (() => {
      try {
        wireMessages({
          modelType: "TEXT_LARGE",
          messages: [
            {
              role: "user",
              content: [{ type: "file", data: "x", mediaType: "text/plain" }],
            },
          ],
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(
      TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED,
    );
  });
});
