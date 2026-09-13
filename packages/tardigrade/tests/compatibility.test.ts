/**
 * Compatibility contract: real edge plugins from the workspace are declared and
 * classified, and unsupported declarations or hosts are refused with typed
 * errors. Deterministic; no runtime is constructed.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError, type Plugin } from "@elizaos/core/edge";
import {
  createTodosEdgePlugin,
  TODOS_EDGE_COMPATIBILITY,
  type TodoStore,
} from "@elizaos/plugin-todos/edge";
import {
  WEB_SEARCH_EDGE_COMPATIBILITY,
  webSearchEdgeAction,
  webSearchEdgePlugin,
} from "@elizaos/plugin-web-search/edge";
import {
  assertTardigradeCompatible,
  declarePlugin,
  effectPolicyOf,
  pluginCompatibilityErrors,
  TARDIGRADE_PLUGIN_DECLARATION_INVALID,
  TARDIGRADE_PLUGIN_INCOMPATIBLE,
} from "../src/compatibility";

const noHost = { bindings: [], secrets: [] };

describe("plugin declarations", () => {
  test("real edge markers declare cleanly", () => {
    const webSearch = declarePlugin(
      webSearchEdgePlugin,
      WEB_SEARCH_EDGE_COMPATIBILITY,
    );
    expect(pluginCompatibilityErrors(webSearch, noHost)).toEqual([]);
    const todos = declarePlugin(
      createTodosEdgePlugin({ store: {} as TodoStore }),
      TODOS_EDGE_COMPATIBILITY,
    );
    expect(pluginCompatibilityErrors(todos, noHost)).toEqual([
      "todos-edge: host lacks required bindings HYPERDRIVE",
    ]);
    expect(
      pluginCompatibilityErrors(todos, {
        bindings: ["HYPERDRIVE"],
        secrets: [],
      }),
    ).toEqual([]);
  });

  test("a non-edge or malformed declaration is rejected before any host check", () => {
    const failure = (() => {
      try {
        declarePlugin(webSearchEdgePlugin, {
          target: "node" as "edge",
          state: "",
          effects: ["x"],
          requiredBindings: [],
          requiredSecrets: [],
          effectPolicies: { WEB_SEARCH: "sometimes" as "read" },
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(
      TARDIGRADE_PLUGIN_DECLARATION_INVALID,
    );
    expect((failure as ElizaError).context?.problems).toHaveLength(3);
  });

  test("plugin HTTP routes and missing secrets refuse the whole composition", () => {
    const routed: Plugin = {
      name: "routed",
      description: "needs an HTTP host",
      routes: [{ path: "/hook", type: "GET", handler: async () => undefined }],
    };
    const declared = declarePlugin(routed, {
      target: "edge",
      state: "none",
      effects: ["public-network-read"],
      requiredBindings: [],
      requiredSecrets: ["HOOK_SECRET"],
    });
    const failure = (() => {
      try {
        assertTardigradeCompatible(
          [
            declarePlugin(webSearchEdgePlugin, WEB_SEARCH_EDGE_COMPATIBILITY),
            declared,
          ],
          noHost,
        );
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ElizaError);
    expect((failure as ElizaError).code).toBe(TARDIGRADE_PLUGIN_INCOMPATIBLE);
    expect((failure as ElizaError).context?.errors).toEqual([
      "routed: host lacks required secrets HOOK_SECRET",
      "routed: declares 1 HTTP route(s); the Tardigrade host serves no plugin HTTP surface",
    ]);
    expect(() =>
      assertTardigradeCompatible(
        [declarePlugin(webSearchEdgePlugin, WEB_SEARCH_EDGE_COMPATIBILITY)],
        noHost,
      ),
    ).not.toThrow();
  });
});

describe("effect policies", () => {
  test("real actions classify from their structural tags", () => {
    expect(
      effectPolicyOf(webSearchEdgeAction, WEB_SEARCH_EDGE_COMPATIBILITY),
    ).toBe("read");
    const todoAction = createTodosEdgePlugin({ store: {} as TodoStore })
      .actions?.[0];
    if (!todoAction) throw new Error("todos edge plugin registered no action");
    expect(todoAction.name).toBe("TODO");
    expect(effectPolicyOf(todoAction, TODOS_EDGE_COMPATIBILITY)).toBe(
      "idempotent",
    );
  });

  test("untagged effectful actions default to unsafe unless overridden", () => {
    const declaration = {
      target: "edge" as const,
      state: "none",
      effects: ["tenant-write"],
      requiredBindings: [],
      requiredSecrets: [],
    };
    expect(
      effectPolicyOf({ name: "SEND", tags: ["capability:send"] }, declaration),
    ).toBe("unsafe");
    expect(effectPolicyOf({ name: "MYSTERY" }, declaration)).toBe("unsafe");
    expect(
      effectPolicyOf(
        { name: "MYSTERY" },
        { ...declaration, effects: ["cache-read", "public-network-read"] },
      ),
    ).toBe("read");
    expect(
      effectPolicyOf(
        { name: "MYSTERY", tags: ["capability:write"] },
        { ...declaration, effectPolicies: { MYSTERY: "idempotent" } },
      ),
    ).toBe("idempotent");
  });
});
