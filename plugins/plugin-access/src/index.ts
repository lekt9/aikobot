/** Exposes Access execution to the native elizaOS plugin lifecycle while retaining its scheduler and connector ownership. */
import type { Plugin } from "@elizaos/core";
import { accessActions } from "./actions.ts";
import { accessProvider } from "./provider.ts";
import { createAccessRoutes } from "./routes.ts";
import { AccessService } from "./service.ts";
import { onTelegramUserActivity } from "./telegram-onboarding.ts";

export * from "./contracts.ts";
export * from "./coordinator.ts";
export * from "./routes.ts";
export * from "./scheduling.ts";
export * from "./service.ts";
export const accessPlugin: Plugin = {
  name: "access",
  description:
    "Private website execution and proactive evidence through Access on Tardigrade",
  services: [AccessService],
  events: { TELEGRAM_USER_ACTIVITY: [onTelegramUserActivity] },
  actions: accessActions,
  providers: [accessProvider],
  routes: createAccessRoutes(),
};
export default accessPlugin;
