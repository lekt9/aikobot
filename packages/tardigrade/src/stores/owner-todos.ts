/**
 * Todo store persisted in the owner's durable state — the Durable Object's
 * SQLite on Cloudflare, the owner's SQLite file on Bun. The native
 * composition runs plugin handlers inside the owner's runtime, so the todo
 * list belongs to the owner rather than to one thread's workspace, and a
 * list created in one conversation is visible in the next.
 */

import type { TodoStore } from "@elizaos/plugin-todos/edge";
import type { TardigradePluginCompatibility } from "../compatibility";
import type { StateBackend } from "../owner/backend";
import { documentTodoStore } from "./document-todos";

export const OWNER_TODOS_COMPATIBILITY: TardigradePluginCompatibility = {
  target: "edge",
  state: "owner-durable-state",
  effects: ["owner-state-read", "owner-state-write"],
  requiredBindings: [],
  requiredSecrets: [],
};

export const OWNER_TODOS_KEY = "/eliza/todos.json";

/** A `TodoStore` whose whole state lives at one key of the owner's backend. */
export function ownerTodoStore(
  backend: StateBackend,
  key = OWNER_TODOS_KEY,
): TodoStore {
  return documentTodoStore({
    load: async () => backend.read(key),
    save: async (document) => {
      backend.write(key, document);
    },
  });
}
