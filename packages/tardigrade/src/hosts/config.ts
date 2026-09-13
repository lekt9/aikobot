/**
 * Host-neutral turn configuration as an Effect layer. Both hosts provide the
 * thread workspace key-value store as a port, so the same layer builds the
 * durable todo store, the OpenAI-compatible model port, and the declared
 * plugin set from a plain environment map — `process.env` on Bun, the Worker
 * bindings on Cloudflare.
 */

import { createTodosEdgePlugin } from "@elizaos/plugin-todos/edge";
import {
  WEB_SEARCH_EDGE_COMPATIBILITY,
  webSearchEdgePlugin,
} from "@elizaos/plugin-web-search/edge";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { ElizaTurnServices } from "../actor";
import { declarePlugin } from "../compatibility";
import { type DeliveryPort, turnOutputDelivery } from "../delivery";
import type { ElizaModelPort } from "../model";
import { openAICompatibleModelPortFromEnv } from "../providers/openai";
import { KV_TODOS_COMPATIBILITY, kvTodoStore } from "../stores/kv-todos";
import type { ElizaTurnCharacter, ElizaTurnConfig } from "../turn";

export const DEFAULT_ELIZA_TARDIGRADE_CHARACTER: ElizaTurnCharacter = {
  name: "Eliza",
  system:
    "You are Eliza, a concise assistant hosted on Tardigrade. Use WEB_SEARCH for current public information and TODO to manage the user's list. Answer plainly.",
};

export interface ElizaTurnServicesLayerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly agentKey?: string;
  readonly character?: ElizaTurnCharacter;
  readonly model?: ElizaModelPort;
  readonly delivery?: DeliveryPort;
}

/** The turn configuration layer every thread receives on either host. */
export function elizaTurnServicesLayer(
  options: ElizaTurnServicesLayerOptions,
): Layer.Layer<ElizaTurnServices, never, KeyValueStore.KeyValueStore> {
  return Layer.effect(
    ElizaTurnServices,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const env = options.env;
      const config: ElizaTurnConfig = {
        agentKey:
          options.agentKey ??
          env.ELIZA_TARDIGRADE_AGENT_KEY ??
          "eliza-tardigrade",
        character: options.character ?? DEFAULT_ELIZA_TARDIGRADE_CHARACTER,
        plugins: [
          declarePlugin(webSearchEdgePlugin, WEB_SEARCH_EDGE_COMPATIBILITY),
          declarePlugin(
            createTodosEdgePlugin({ store: kvTodoStore(kv) }),
            KV_TODOS_COMPATIBILITY,
          ),
        ],
        model: options.model ?? openAICompatibleModelPortFromEnv(env),
        delivery: options.delivery ?? turnOutputDelivery,
        host: {
          bindings: [],
          secrets: Object.keys(env).filter((name) => Boolean(env[name])),
        },
      };
      return { config };
    }),
  );
}
