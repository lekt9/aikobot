/** Publishes a private-chat sender's connector-resolved identity for automatic personal services, before chat authorization. */
import type { IAgentRuntime } from "@elizaos/core";
import { resolveTelegramRuntimeEntityId } from "./identity";
import { TelegramEventTypes } from "./types";

export async function emitTelegramUserActivity(
  runtime: IAgentRuntime,
  accountId: string,
  sender: { id?: number | string; is_bot?: boolean } | undefined,
  chatType: string | undefined,
): Promise<void> {
  if (chatType !== "private" || sender?.is_bot || sender?.id === undefined)
    return;
  const telegramUserId = String(sender.id);
  if (!/^[1-9]\d*$/.test(telegramUserId)) return;
  const entityId = await resolveTelegramRuntimeEntityId(
    runtime,
    accountId,
    telegramUserId,
  );
  await runtime.emitEvent(TelegramEventTypes.USER_ACTIVITY, {
    runtime,
    source: "telegram",
    entityId,
    accountId,
  });
}
