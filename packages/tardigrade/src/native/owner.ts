/**
 * The deployment's plugin set, in its two forms. The Tardigrade actor is a
 * static definition, so it mounts packages built from plugin objects used
 * for metadata only — names, descriptions, parameter schemas and effect
 * tags, which no store can change. The owner's runtime builds the same
 * plugins for real, against that owner's durable state, and is the only
 * place a handler ever runs.
 *
 * A declaration-only plugin's store refuses every call, so a mistake that
 * routed real work to the actor module fails loudly instead of writing into
 * a store no owner can see.
 */

import type { Character } from "@elizaos/core/edge";
import { ElizaError } from "@elizaos/core/edge";
import {
  createTodosEdgePlugin,
  type TodoStore,
} from "@elizaos/plugin-todos/edge";
import {
  WEB_SEARCH_EDGE_COMPATIBILITY,
  webSearchEdgePlugin,
} from "@elizaos/plugin-web-search/edge";
import { type DeclaredPlugin, declarePlugin } from "../compatibility";
import type { StateBackend } from "../owner/backend";
import type { OwnerExecutor, OwnerRuntimeOptions } from "../owner/runtime";
import {
  OWNER_TODOS_COMPATIBILITY,
  ownerTodoStore,
} from "../stores/owner-todos";
import { elizaAgentId } from "../turn";
import { nativeExecutors } from "./executor";

export const TARDIGRADE_DECLARATION_ONLY = "TARDIGRADE_DECLARATION_ONLY";

/** A store that exists so a plugin can describe itself, and nothing else. */
export function declarationTodoStore(): TodoStore {
  const refuse = (operation: string) => (): never => {
    throw new ElizaError(
      `The declaration-only todo store cannot ${operation}; plugin handlers run in an owner runtime`,
      { code: TARDIGRADE_DECLARATION_ONLY, context: { operation } },
    );
  };
  return {
    applyMutation: refuse("apply a mutation"),
    readCutoverState: refuse("read cutover state"),
    listMutationRecords: refuse("list mutation records"),
    importMutationRecords: refuse("import mutation records"),
    create: refuse("create a todo"),
    get: refuse("read a todo"),
    list: refuse("list todos"),
    update: refuse("update a todo"),
    delete: refuse("delete a todo"),
    writeList: refuse("write a list"),
    clear: refuse("clear todos"),
  } as unknown as TodoStore;
}

/** The declared plugin set, bound to one owner's durable state. */
export function nativeOwnerPlugins(
  backend: StateBackend,
): ReadonlyArray<DeclaredPlugin> {
  return [
    declarePlugin(webSearchEdgePlugin, WEB_SEARCH_EDGE_COMPATIBILITY),
    declarePlugin(
      createTodosEdgePlugin({ store: ownerTodoStore(backend) }),
      OWNER_TODOS_COMPATIBILITY,
    ),
  ];
}

/**
 * The same plugin set for metadata only. Package declarations, method
 * schemas and effect policies come from here at actor-definition time.
 */
export function nativeDeclarationPlugins(): ReadonlyArray<DeclaredPlugin> {
  return [
    declarePlugin(webSearchEdgePlugin, WEB_SEARCH_EDGE_COMPATIBILITY),
    declarePlugin(
      createTodosEdgePlugin({ store: declarationTodoStore() }),
      OWNER_TODOS_COMPATIBILITY,
    ),
  ];
}

export interface NativeOwnerConfig {
  readonly agentKey: string;
  readonly character: Character;
  /** Extra invocation kinds a host mounts (scheduling ticks, remote packages). */
  readonly executors?: Readonly<Record<string, OwnerExecutor>>;
  readonly plugins?: (backend: StateBackend) => ReadonlyArray<DeclaredPlugin>;
  readonly now?: () => number;
}

export type NativeOwnerBuild = (
  owner: string,
  backend: StateBackend,
) => Omit<OwnerRuntimeOptions, "owner" | "backend">;

/** How every host builds one owner's runtime for the native composition. */
export function nativeOwnerBuild(config: NativeOwnerConfig): NativeOwnerBuild {
  return (_owner, backend) => {
    const declared = (config.plugins ?? nativeOwnerPlugins)(backend);
    return {
      agentId: elizaAgentId(config.agentKey),
      character: config.character,
      plugins: declared.map((entry) => entry.plugin),
      executors: {
        ...nativeExecutors({ agentKey: config.agentKey, plugins: declared }),
        ...(config.executors ?? {}),
      },
      ...(config.now === undefined ? {} : { now: config.now }),
    };
  };
}
