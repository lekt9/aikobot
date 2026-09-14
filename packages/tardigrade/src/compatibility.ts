/**
 * Declared compatibility contract for plugins hosted on Tardigrade. A plugin
 * joins the actor only through an explicit declaration naming its edge target,
 * host bindings, secrets, and effect classes. The adapter validates every
 * declaration against the host before an AgentRuntime is constructed and fails
 * with one typed error listing each unmet requirement. Undeclared runtime
 * requirements such as plugin HTTP routes are refused rather than dropped: a
 * plugin handed a narrower IAgentRuntime than it expects fails non-locally at
 * execution time, which is exactly the failure this boundary prevents.
 *
 * The same declaration classifies each action's retry policy for the effect
 * journal, from the action's structural tags unless the declaration overrides
 * a name explicitly.
 */

import { type Action, ElizaError, type Plugin } from "@elizaos/core/edge";
import { ELIZA_EFFECT_POLICIES, type ElizaEffectPolicy } from "./events";

export interface TardigradePluginCompatibility {
  readonly target: "edge";
  readonly state: string;
  readonly effects: ReadonlyArray<string>;
  readonly requiredBindings: ReadonlyArray<string>;
  readonly requiredSecrets: ReadonlyArray<string>;
  /** Explicit per-action policy when structural tags are not precise enough. */
  readonly effectPolicies?: Readonly<Record<string, ElizaEffectPolicy>>;
  /**
   * Acknowledges that the plugin declares HTTP routes the Tardigrade host does
   * not serve. The routes are inert in an owner runtime — no HTTP surface
   * reaches them — so a plugin whose value is its actions, providers and
   * services (not its routes) is mountable once its author states this. The
   * default remains a refusal, so an unacknowledged route surface is still an
   * error rather than a silent drop.
   */
  readonly unservedRoutes?: boolean;
}

export interface DeclaredPlugin {
  readonly plugin: Plugin;
  readonly compatibility: TardigradePluginCompatibility;
}

export interface TardigradeHostCapabilities {
  readonly bindings: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<string>;
}

export const TARDIGRADE_PLUGIN_INCOMPATIBLE = "TARDIGRADE_PLUGIN_INCOMPATIBLE";
export const TARDIGRADE_PLUGIN_DECLARATION_INVALID =
  "TARDIGRADE_PLUGIN_DECLARATION_INVALID";

const UNSAFE_CAPABILITY_TAGS = new Set([
  "capability:write",
  "capability:update",
  "capability:delete",
  "capability:schedule",
  "capability:send",
  "capability:delegate",
  "capability:execute",
]);

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Pairs a plugin with its validated compatibility declaration. */
export function declarePlugin(
  plugin: Plugin,
  compatibility: TardigradePluginCompatibility,
): DeclaredPlugin {
  const problems: string[] = [];
  if (compatibility.target !== "edge") {
    problems.push(
      `target must be "edge", got ${JSON.stringify(compatibility.target)}`,
    );
  }
  if (typeof compatibility.state !== "string" || !compatibility.state) {
    problems.push("state must be a non-empty string");
  }
  for (const field of [
    "effects",
    "requiredBindings",
    "requiredSecrets",
  ] as const) {
    if (!isStringArray(compatibility[field]))
      problems.push(`${field} must be a string array`);
  }
  for (const [name, policy] of Object.entries(
    compatibility.effectPolicies ?? {},
  )) {
    if (!ELIZA_EFFECT_POLICIES.includes(policy)) {
      problems.push(
        `effectPolicies.${name} must be one of ${ELIZA_EFFECT_POLICIES.join(", ")}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ElizaError(
      `Plugin ${plugin.name} has an invalid Tardigrade declaration`,
      {
        code: TARDIGRADE_PLUGIN_DECLARATION_INVALID,
        context: { plugin: plugin.name, problems },
      },
    );
  }
  return { plugin, compatibility };
}

/** Every reason a declared plugin cannot run on the given host; empty when compatible. */
export function pluginCompatibilityErrors(
  declared: DeclaredPlugin,
  host: TardigradeHostCapabilities,
): string[] {
  const { plugin, compatibility } = declared;
  const errors: string[] = [];
  const missingBindings = compatibility.requiredBindings.filter(
    (binding) => !host.bindings.includes(binding),
  );
  if (missingBindings.length > 0) {
    errors.push(
      `${plugin.name}: host lacks required bindings ${missingBindings.join(", ")}`,
    );
  }
  const missingSecrets = compatibility.requiredSecrets.filter(
    (secret) => !host.secrets.includes(secret),
  );
  if (missingSecrets.length > 0) {
    errors.push(
      `${plugin.name}: host lacks required secrets ${missingSecrets.join(", ")}`,
    );
  }
  const routes = plugin.routes?.length ?? 0;
  if (routes > 0 && compatibility.unservedRoutes !== true) {
    errors.push(
      `${plugin.name}: declares ${routes} HTTP route(s); the Tardigrade host serves no plugin HTTP surface`,
    );
  }
  return errors;
}

/** Refuses the composition when any declared plugin cannot run on the host. */
export function assertTardigradeCompatible(
  declared: ReadonlyArray<DeclaredPlugin>,
  host: TardigradeHostCapabilities,
): void {
  const errors = declared.flatMap((entry) =>
    pluginCompatibilityErrors(entry, host),
  );
  if (errors.length === 0) return;
  throw new ElizaError(
    `Tardigrade host cannot run the declared plugin set: ${errors.join("; ")}`,
    {
      code: TARDIGRADE_PLUGIN_INCOMPATIBLE,
      context: { errors, plugins: declared.map((entry) => entry.plugin.name) },
    },
  );
}

/**
 * Retry policy for one action's journaled boundary. Explicit overrides win;
 * otherwise `effect:idempotent` marks a replay-safe effect, any effectful
 * capability tag is unsafe, `capability:read` is a read, and a plugin whose
 * declared effects are all reads defaults its untagged actions to read.
 */
export function effectPolicyOf(
  action: Pick<Action, "name" | "tags">,
  compatibility: TardigradePluginCompatibility,
): ElizaEffectPolicy {
  const override = compatibility.effectPolicies?.[action.name];
  if (override !== undefined) return override;
  const tags = new Set(action.tags ?? []);
  if (tags.has("effect:idempotent")) return "idempotent";
  for (const tag of tags) {
    if (UNSAFE_CAPABILITY_TAGS.has(tag)) return "unsafe";
  }
  if (tags.has("capability:read")) return "read";
  if (
    compatibility.effects.length > 0 &&
    compatibility.effects.every((effect) => effect.endsWith("-read"))
  ) {
    return "read";
  }
  return "unsafe";
}
