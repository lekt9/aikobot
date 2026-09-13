/** Starts the Access SDK client and scheduler contributions without creating a timer or agent loop. */
import {
  ElizaError,
  type IAgentRuntime,
  Service,
  type UUID,
} from "@elizaos/core";
import { getScheduledTaskRunner } from "@elizaos/plugin-scheduling";
import { createAccessClient } from "access/client";
import { createOwnerTokenIssuer } from "access/server-auth";
import { AccessCoordinator } from "./coordinator.ts";
import { runtimeHostedAuth } from "./hosted-auth.ts";
import {
  createAccessWatchers,
  registerAccessRefreshChannel,
} from "./scheduling.ts";

export class AccessService extends Service {
  static serviceType = "access";
  capabilityDescription =
    "Owner-private remote Access execution and committed context";
  coordinator!: AccessCoordinator;
  private unregisterRefresh: (() => void) | undefined;
  static async start(runtime: IAgentRuntime): Promise<AccessService> {
    const baseUrl = runtime.getSetting("ACCESS_REMOTE_URL");
    if (typeof baseUrl !== "string" || !baseUrl)
      throw new ElizaError("Configure ACCESS_REMOTE_URL on the host", {
        code: "ACCESS_CONFIGURATION_REQUIRED",
      });
    const mode =
      runtime.getSetting("ACCESS_AUTH_MODE") ||
      (new URL(baseUrl).origin === "https://access.unbrowse.ai"
        ? "hosted"
        : "owner-token");
    if (mode !== "hosted" && mode !== "owner-token")
      throw new ElizaError("ACCESS_AUTH_MODE must be hosted or owner-token", {
        code: "ACCESS_CONFIGURATION_REQUIRED",
      });
    const hosted =
      mode === "hosted" ? runtimeHostedAuth(runtime, baseUrl) : null;
    const secret = runtime.getSetting("ACCESS_OWNER_TOKEN_SECRET");
    if (hosted === null && (typeof secret !== "string" || !secret))
      throw new ElizaError(
        "Configure ACCESS_OWNER_TOKEN_SECRET for the Bun Access host",
        { code: "ACCESS_CONFIGURATION_REQUIRED" },
      );
    const issuer =
      hosted === null && typeof secret === "string"
        ? createOwnerTokenIssuer({ secret })
        : null;
    const client = (ownerId: UUID) => {
      if (hosted !== null) return hosted.client(ownerId);
      if (issuer === null)
        throw new ElizaError("Access owner-token issuer is unavailable", {
          code: "ACCESS_CONFIGURATION_REQUIRED",
        });
      return createAccessClient({
        baseUrl,
        token: () => issuer.issue(ownerId),
      });
    };
    const service = new AccessService(runtime);
    service.coordinator = new AccessCoordinator(runtime, {
      client,
      remoteContextAvailable: hosted === null,
      watchers: createAccessWatchers(
        () => getScheduledTaskRunner(runtime, { agentId: runtime.agentId }),
        runtime,
      ),
    });
    service.unregisterRefresh = registerAccessRefreshChannel(runtime, client);
    service.coordinator.start();
    return service;
  }
  async stop(): Promise<void> {
    this.unregisterRefresh?.();
    await this.coordinator.stop();
  }
}

export function accessCoordinator(runtime: IAgentRuntime): AccessCoordinator {
  const service = runtime.getService<AccessService>(AccessService.serviceType);
  if (service === null)
    throw new ElizaError("Access service is not configured", {
      code: "ACCESS_CONFIGURATION_REQUIRED",
    });
  return service.coordinator;
}
