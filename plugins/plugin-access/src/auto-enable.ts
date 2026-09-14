/** Enables the remote integration when its server URL is configured; service startup selects hosted sessions or owner-token authentication. */
import type { PluginAutoEnableContext } from "@elizaos/core";

export function shouldEnable(context: PluginAutoEnableContext): boolean {
  const url = context.env.ACCESS_REMOTE_URL;
  return typeof url === "string" && url.trim().length > 0;
}
