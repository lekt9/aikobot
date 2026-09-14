/** Ensures a private Access workspace for each connector-authenticated Telegram sender, reusing the remote owner after restart. */
import type { EventPayload, IAgentRuntime, UUID } from "@elizaos/core";
import { z } from "zod";
import { accessFailure, ownerSchema } from "./contracts.ts";
import { accessCoordinator } from "./service.ts";

const activitySchema = z.object({
  source: z.literal("telegram"),
  entityId: ownerSchema,
  accountId: z.string().min(1),
});
const provisioned = new WeakMap<IAgentRuntime, Map<UUID, Promise<void>>>();

async function provision(runtime: IAgentRuntime, ownerId: UUID): Promise<void> {
  const coordinator = accessCoordinator(runtime);
  await coordinator.enroll(ownerId);
  // The authenticated SDK request lazily creates the owner in the Access host.
  // Listing does not add a website or ask the person to register with Access.
  await coordinator.client(ownerId).accounts.list();
}

export async function onTelegramUserActivity(
  payload: EventPayload,
): Promise<void> {
  const { entityId: ownerId } = activitySchema.parse(payload);
  const { runtime } = payload;
  let owners = provisioned.get(runtime);
  if (owners === undefined) {
    owners = new Map();
    provisioned.set(runtime, owners);
  }
  const running = owners.get(ownerId);
  if (running !== undefined) return running;
  const ownerWork = owners;
  const work = (async () => {
    try {
      await provision(runtime, ownerId);
    } catch (cause) {
      // error-policy:J1 This optional onboarding event reports failure without
      // aborting Telegram authorization or chat. Eviction lets later activity
      // retry; only successful provisioning remains memoized.
      ownerWork.delete(ownerId);
      const error = accessFailure("ACCESS_TELEGRAM_PROVISIONING_FAILED", cause);
      runtime.reportError("access:telegram-onboarding", error, { ownerId });
    }
  })();
  owners.set(ownerId, work);
  return work;
}
