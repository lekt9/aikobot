/**
 * Deterministic collaborators for adapter tests: a scripted model port that
 * answers by request shape (Stage 1, planner, finish), an in-memory todo store
 * honoring the idempotency contract, a recording delivery port, and a
 * declared plugin set. Everything else in the tests is the real runtime.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo, TodoMutationRecord } from "@elizaos/plugin-todos/edge";
import { createTodosEdgePlugin } from "@elizaos/plugin-todos/edge";
import {
  createWebSearchEdgePlugin,
  WEB_SEARCH_EDGE_COMPATIBILITY,
} from "@elizaos/plugin-web-search/edge";
import {
  type DeclaredPlugin,
  declarePlugin,
  type TardigradePluginCompatibility,
} from "../src/compatibility";
import type {
  DeliveryContent,
  DeliveryPort,
  DeliveryReceipt,
} from "../src/delivery";
import type { BoundaryExecutionContext } from "../src/journal";
import type {
  ElizaModelPort,
  ModelPortRequest,
  ModelPortResult,
} from "../src/model";
import { KV_TODOS_COMPATIBILITY } from "../src/stores/kv-todos";
import {
  type MemoryTodoStore,
  memoryTodoStore,
} from "../src/stores/memory-todos";

export { type MemoryTodoStore, memoryTodoStore };

export interface ScriptedPlan {
  readonly action: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelScript {
  /** Stage-1 candidate action names; empty means a plain reply. */
  readonly candidateActionNames?: ReadonlyArray<string>;
  readonly contexts?: ReadonlyArray<string>;
  readonly replyText: string;
  /** Planner tool calls emitted once, in order, when their tools are offered. */
  readonly plans?: ReadonlyArray<ScriptedPlan>;
  /** Final answer once every plan has run. */
  readonly finishText?: string;
}

export interface ScriptedModelPort extends ElizaModelPort {
  readonly requests: ModelPortRequest[];
  readonly calls: number;
  reset(): void;
  /** Fails the next generate call with the given error. */
  failNext(error: Error): void;
}

const toolNames = (request: ModelPortRequest): string[] =>
  (request.tools ?? []).map((tool) => tool.name);

/** Answers by request shape so the exact call count is not part of the contract. */
export function scriptedModelPort(
  script: ModelScript | ((request: ModelPortRequest) => ModelScript),
  options: { readonly model?: string; readonly provider?: string } = {},
): ScriptedModelPort {
  const requests: ModelPortRequest[] = [];
  const planned = new Set<string>();
  let pendingFailure: Error | undefined;
  let calls = 0;
  const model = options.model ?? "scripted-model";
  const result = (fields: Partial<ModelPortResult>): ModelPortResult => ({
    text: "",
    toolCalls: [],
    finishReason: "stop",
    model,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...fields,
  });
  return {
    provider: options.provider ?? "scripted",
    requests,
    get calls() {
      return calls;
    },
    reset() {
      requests.length = 0;
      planned.clear();
      calls = 0;
    },
    failNext(error) {
      pendingFailure = error;
    },
    async generate(request) {
      calls += 1;
      requests.push(request);
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        throw failure;
      }
      const resolved = typeof script === "function" ? script(request) : script;
      const tools = toolNames(request);
      if (tools.includes("HANDLE_RESPONSE")) {
        // Stage 1 opens a turn; plans consumed by an earlier turn are available again.
        planned.clear();
        const candidateActionNames = [...(resolved.candidateActionNames ?? [])];
        return result({
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `handle-${calls}`,
              name: "HANDLE_RESPONSE",
              arguments: {
                shouldRespond: "RESPOND",
                thought: "Scripted deterministic decision.",
                contexts: [...(resolved.contexts ?? ["simple"])],
                intents: [],
                candidateActionNames,
                ...(candidateActionNames.length > 0
                  ? { requiresTool: true }
                  : {}),
                replyText:
                  candidateActionNames.length > 0 ? "" : resolved.replyText,
                replyEffectStatus: "none",
                facts: [],
                relationships: [],
                addressedTo: [],
              },
            },
          ],
        });
      }
      const nextPlan = (resolved.plans ?? []).find(
        (plan, index) =>
          !planned.has(`${index}:${plan.action}`) &&
          tools.includes(plan.action),
      );
      if (nextPlan) {
        const index = (resolved.plans ?? []).indexOf(nextPlan);
        planned.add(`${index}:${nextPlan.action}`);
        return result({
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `plan-${calls}`,
              name: nextPlan.action,
              arguments: nextPlan.parameters,
            },
          ],
        });
      }
      const finish = resolved.finishText ?? resolved.replyText;
      if (request.modelType === "ACTION_PLANNER") {
        return result({
          text: JSON.stringify({
            success: true,
            decision: "FINISH",
            thought: "Scripted finish.",
            messageToUser: finish,
          }),
        });
      }
      return result({ text: finish });
    },
  };
}

export interface RecordingDeliveryPort extends DeliveryPort {
  readonly deliveries: Array<{
    content: DeliveryContent;
    context: BoundaryExecutionContext;
  }>;
}

/** Records every delivery; dedupes on operation id like a real idempotent connector. */
export function recordingDeliveryPort(
  name = "recording",
): RecordingDeliveryPort {
  const deliveries: RecordingDeliveryPort["deliveries"] = [];
  return {
    name,
    policy: "idempotent",
    deliveries,
    async deliver(content, context): Promise<DeliveryReceipt> {
      if (
        !deliveries.some(
          (entry) => entry.context.operationId === context.operationId,
        )
      ) {
        deliveries.push({ content, context });
      }
      return { delivered: true, receipt: `${name}:${context.operationId}` };
    },
  };
}

export const HOST_TODOS_COMPATIBILITY: TardigradePluginCompatibility =
  KV_TODOS_COMPATIBILITY;

export interface TestPluginSet {
  readonly plugins: DeclaredPlugin[];
  readonly store: MemoryTodoStore;
  readonly searches: string[];
}

/** Web search (read) and todos (idempotent write) over host-owned fakes. */
export function testPlugins(
  options: { store?: MemoryTodoStore; searchText?: string } = {},
): TestPluginSet {
  const store = options.store ?? memoryTodoStore();
  const searches: string[] = [];
  const searchText =
    options.searchText ??
    JSON.stringify({
      results: [
        {
          url: "https://elizaos.ai/news",
          title: "elizaOS release",
          text: "A new elizaOS release was announced today.",
        },
      ],
    });
  const webSearch = createWebSearchEdgePlugin(async (query) => {
    searches.push(query);
    return {
      success: true,
      text: searchText,
      data: {
        actionName: "WEB_SEARCH",
        query,
        provider: "test",
        value: searchText,
      },
    };
  });
  return {
    store,
    searches,
    plugins: [
      declarePlugin(webSearch, WEB_SEARCH_EDGE_COMPATIBILITY),
      declarePlugin(createTodosEdgePlugin({ store }), HOST_TODOS_COMPATIBILITY),
    ],
  };
}

/**
 * File-backed todo store for cross-process proofs: every applied mutation is
 * persisted before it returns, and an optional fault hook runs after the
 * persistence so a test can kill the process between the external effect and
 * its boundary record.
 */
export interface FileTodoStoreOptions {
  readonly path: string;
  readonly afterApply?: (idempotencyKey: string) => Promise<void>;
}

export function fileTodoStore(options: FileTodoStoreOptions): MemoryTodoStore {
  const fs = require("node:fs") as typeof import("node:fs");
  let seed: { todos?: Todo[]; mutations?: TodoMutationRecord[] } = {};
  if (fs.existsSync(options.path)) {
    const raw = JSON.parse(fs.readFileSync(options.path, "utf8")) as {
      todos: Todo[];
      mutations: TodoMutationRecord[];
    };
    seed = {
      todos: raw.todos.map((todo) => ({
        ...todo,
        createdAt: new Date(todo.createdAt),
        updatedAt: new Date(todo.updatedAt),
        completedAt: todo.completedAt ? new Date(todo.completedAt) : null,
      })),
      mutations: raw.mutations.map((record) => ({
        ...record,
        committedAt: new Date(record.committedAt),
      })),
    };
  }
  const inner = memoryTodoStore(seed);
  const persist = () =>
    fs.writeFileSync(
      options.path,
      JSON.stringify({ todos: inner.todos, mutations: inner.mutations }),
    );
  return {
    ...inner,
    async applyMutation(input) {
      const execution = await inner.applyMutation(input);
      persist();
      if (!execution.replayed && options.afterApply)
        await options.afterApply(input.idempotencyKey);
      return execution;
    },
  };
}

/**
 * A fresh storage directory. Prefers the OS temp root, then `/tmp`, and only
 * then a package-owned root, so a shell naming an unusable TMPDIR neither
 * fails the proofs nor makes them write inside the fingerprinted tree.
 */
export function testStorageDir(prefix: string): string {
  const candidates = [
    tmpdir(),
    "/tmp",
    join(import.meta.dir, "..", ".tardigrade", "tmp"),
  ];
  for (const root of candidates) {
    try {
      mkdirSync(root, { recursive: true });
      return mkdtempSync(join(root, prefix));
    } catch {
      // error-policy:J3 an unusable temp root is not evidence; try the next root.
    }
  }
  throw new Error("no usable temp root for test storage");
}
