/**
 * The Access capability for a native owner runtime. When a deployment
 * configures Access, an owner's runtime mounts `@elizaos/plugin-access` and
 * its scheduler dependency, so the four `ACCESS_*` actions become the
 * code-mode package the engine can call mid-turn and the `ACCESS_CONTEXT`
 * provider becomes per-turn context. The browser and OS work stays on the
 * Access host, reached over HTTPS by the plugin's fetch client, so the owner
 * runtime — and the Worker it runs in — needs no VM.
 *
 * Two facts about the edge shape this module:
 *
 * - Owner-token mode only. Hosted mode needs a durable connector credential
 *   store that is not edge-safe; owner-token mode needs a signing secret and
 *   `access/server-auth`, which are WebCrypto. The secret must be the one the
 *   Access deployment verifies (issuer/audience are that host's defaults).
 * - Both plugins declare HTTP routes the Tardigrade host does not serve, so
 *   their compatibility declarations acknowledge `unservedRoutes`: the value
 *   here is their actions, providers and services, and the routes are inert
 *   because no HTTP surface in an owner runtime reaches them.
 *
 * The plugin's own error policy carries through: a refused or uncertain
 * ACCESS action returns its code to the model as an answer — never a silent
 * success and, since the owner-port fix, never a dead turn.
 */

import type { Character } from "@elizaos/core/edge";
import { ElizaError } from "@elizaos/core/edge";
import { accessPlugin } from "@elizaos/plugin-access";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import {
  assertTardigradeCompatible,
  type DeclaredPlugin,
  declarePlugin,
  type TardigradePluginCompatibility,
} from "../compatibility";

export const TARDIGRADE_ACCESS_CONFIG = "TARDIGRADE_ACCESS_CONFIG";

/** Owner-token mode configuration for reaching an Access deployment. */
export interface AccessOwnerOptions {
  /** The Access deployment's base URL, e.g. https://access.unbrowse.ai. */
  readonly remoteUrl: string;
  /**
   * The HS256 secret the Access deployment verifies owner tokens with. At
   * least 32 bytes; distinct from the Tardigrade owner-token secret.
   */
  readonly ownerTokenSecret: string;
}

/** The scheduler `plugin-access` depends on; its in-memory store is edge-safe. */
export const ACCESS_SCHEDULING_COMPATIBILITY: TardigradePluginCompatibility = {
  target: "edge",
  state: "scheduling-runner",
  effects: ["schedule-read", "schedule-write"],
  requiredBindings: [],
  requiredSecrets: [],
  unservedRoutes: true,
};

/**
 * Access itself: remote website execution reached by the fetch client. Its
 * owner-token secret is not a host binding — it is a character setting the
 * owner runtime carries and `requireOptions` validates — so it is not listed
 * as a required host secret.
 */
export const ACCESS_COMPATIBILITY: TardigradePluginCompatibility = {
  target: "edge",
  state: "access-remote",
  effects: ["capability:execute", "capability:read"],
  requiredBindings: [],
  requiredSecrets: [],
  unservedRoutes: true,
  // ACCESS actions submit account-bound operations to the Access host; connect,
  // run and synthesize change remote state, refresh re-reads. None carries a
  // stable operation key the host replays, so only refresh is idempotent.
  effectPolicies: {
    ACCESS_CONNECT: "unsafe",
    ACCESS_REFRESH: "idempotent",
    ACCESS_RUN: "unsafe",
    ACCESS_SYNTHESIZE: "unsafe",
  },
};

function requireOptions(options: AccessOwnerOptions): AccessOwnerOptions {
  if (typeof options.remoteUrl !== "string" || options.remoteUrl.length === 0) {
    throw new ElizaError("Access requires a remote URL", {
      code: TARDIGRADE_ACCESS_CONFIG,
      context: { field: "remoteUrl" },
    });
  }
  if (
    typeof options.ownerTokenSecret !== "string" ||
    options.ownerTokenSecret.length < 32
  ) {
    throw new ElizaError(
      "Access owner-token secret must be at least 32 bytes",
      {
        code: TARDIGRADE_ACCESS_CONFIG,
        context: { field: "ownerTokenSecret" },
      },
    );
  }
  return options;
}

/**
 * The character an owner runtime with Access uses: the base character plus the
 * settings `AccessService.start` reads through `runtime.getSetting`. Owner
 * tokens are minted per turn from the secret; no long-lived token is stored.
 */
export function accessCharacter(
  character: Character,
  options: AccessOwnerOptions,
): Character {
  requireOptions(options);
  const settings = (character.settings ?? {}) as Record<string, unknown>;
  const secrets = (settings.secrets ?? {}) as Record<string, unknown>;
  return {
    ...character,
    settings: {
      ...settings,
      ACCESS_REMOTE_URL: options.remoteUrl,
      ACCESS_AUTH_MODE: "owner-token",
      secrets: {
        ...secrets,
        ACCESS_OWNER_TOKEN_SECRET: options.ownerTokenSecret,
      },
    },
  };
}

/**
 * The scheduler and Access declared plugins, appended to a base set. Ordered
 * so the scheduler registers before Access, which resolves its runner at
 * start; both are validated here so an incompatible plugin fails at build
 * rather than at the first turn.
 */
export function accessOwnerPlugins(
  base: ReadonlyArray<DeclaredPlugin>,
): ReadonlyArray<DeclaredPlugin> {
  const declared = [
    ...base,
    declarePlugin(schedulingPlugin, ACCESS_SCHEDULING_COMPATIBILITY),
    declarePlugin(accessPlugin, ACCESS_COMPATIBILITY),
  ];
  assertTardigradeCompatible(declared, { bindings: [], secrets: [] });
  return declared;
}

/** Reads Access options from a plain environment, or null when unconfigured. */
export function accessOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AccessOwnerOptions | null {
  const remoteUrl = env.ACCESS_REMOTE_URL;
  const ownerTokenSecret = env.ACCESS_OWNER_TOKEN_SECRET;
  if (!remoteUrl || !ownerTokenSecret) return null;
  return { remoteUrl, ownerTokenSecret };
}
