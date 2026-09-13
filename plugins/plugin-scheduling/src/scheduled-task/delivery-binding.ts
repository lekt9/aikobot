/**
 * Captures and validates canonical scheduled connector destinations, keeping
 * internal and synthetic turns on the in-app path.
 */
import {
  ChannelType,
  evaluateOwnerExclusiveDisclosure,
  getTrustedDeliveryAudience,
  type IAgentRuntime,
  MESSAGE_SOURCES,
  type Memory,
  type MessageSourceSentinel,
  type UUID,
} from "@elizaos/core";
import type { ScheduledTaskDispatchRecord } from "./runner.js";

/**
 * Provenances that must never reach outbound connector dispatch.
 *
 * Enumerated deliberately rather than derived from `Object.values`. This is a
 * fail-open boundary: a provenance the guard does not name is BOUND, so the
 * cost of forgetting one is an internal turn rewritten into an unavailable
 * connector send. Spelling every sentinel out means adding one to
 * `@elizaos/core`'s `message-source.ts` leaves a missing key here and fails
 * typecheck, forcing a decision instead of silently widening the guard.
 *
 * `api` is not a core sentinel — it is a first-party transport label — so it
 * lives alongside the record rather than inside it.
 *
 * Used for both message provenance (`content.source` / `metadata.source`) and
 * the room's connector label (`room.source`). Room sources are connector names
 * in practice; classifying them with the same predicate is deliberate and
 * matches the previous two-string denylist on both sites.
 */
const INTERNAL_MESSAGE_SOURCES: Record<MessageSourceSentinel, true> = {
  [MESSAGE_SOURCES.CLIENT_CHAT]: true,
  [MESSAGE_SOURCES.SUB_AGENT]: true,
  [MESSAGE_SOURCES.CODING_AGENT]: true,
  [MESSAGE_SOURCES.AGENT_GREETING]: true,
  [MESSAGE_SOURCES.TRIGGER_PROMPT]: true,
};

const API_TRANSPORT_SOURCE = "api";

/**
 * Whether `source` names an internally-originated turn or first-party
 * transport that must not bind to outbound connector dispatch (#17747).
 *
 * Returns a plain boolean (not a type predicate): a false result means
 * "not internal", not "not a string".
 */
export function isInternalMessageSource(source: string | undefined): boolean {
  if (!source) return false;
  return (
    source === API_TRANSPORT_SOURCE ||
    Object.hasOwn(INTERNAL_MESSAGE_SOURCES, source)
  );
}

export const SCHEDULED_TASK_DELIVERY_BINDING_KEY = "chatDeliveryBinding";

export interface ScheduledTaskChatDeliveryBinding {
  version: 1;
  source: string;
  roomId: string;
  channelId: string;
  accountId?: string;
  audience: {
    kind: "direct" | "voice_private";
    provenance: "canonical_room";
    ownerEntityId: string;
    agentEntityId: string;
    participantEntityIds: string[];
    membershipVersion: string;
  };
}

/**
 * Binds an authenticated owner to an existing private connector room. Mini App
 * requests have no inbound chat envelope; canonical room membership supplies
 * the destination authority. Multiple matching rooms require an explicit choice.
 */
export async function bindScheduledTaskToOwnerChat(
  runtime: IAgentRuntime,
  input: { ownerId: UUID; source: "telegram"; roomId?: UUID },
): Promise<ScheduledTaskChatDeliveryBinding | null> {
  if (input.source !== "telegram" || input.ownerId === runtime.agentId)
    return null;
  const roomIds =
    input.roomId === undefined
      ? await runtime.getRoomsForParticipant(input.ownerId)
      : [input.roomId];
  const matches: ScheduledTaskChatDeliveryBinding[] = [];
  for (const roomId of new Set(roomIds)) {
    const [room, members] = await Promise.all([
      runtime.getRoom(roomId),
      runtime.getParticipantsForRoom(roomId),
    ]);
    const participants = canonicalParticipants(members);
    if (
      !room ||
      room.type !== ChannelType.DM ||
      room.source !== input.source ||
      !room.channelId ||
      room.channelId === room.id ||
      participants.length !== 2 ||
      !participants.includes(input.ownerId) ||
      !participants.includes(runtime.agentId)
    )
      continue;
    const accountId = stringField(room.metadata?.accountId);
    matches.push({
      version: 1,
      source: input.source,
      roomId: room.id,
      channelId: room.channelId,
      ...(accountId === undefined ? {} : { accountId }),
      audience: {
        kind: "direct",
        provenance: "canonical_room",
        ownerEntityId: input.ownerId,
        agentEntityId: runtime.agentId,
        participantEntityIds: participants,
        membershipVersion: membershipVersion(participants),
      },
    });
  }
  const [match] = matches;
  return matches.length === 1 && match !== undefined ? match : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function canonicalParticipants(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function membershipVersion(values: readonly string[]): string {
  return JSON.stringify(canonicalParticipants(values));
}

function legacyMembershipVersion(values: readonly string[]): string {
  return canonicalParticipants(values).join("\u0000");
}

function matchesMembershipVersion(
  values: readonly string[],
  storedVersion: string,
): boolean {
  return (
    membershipVersion(values) === storedVersion ||
    legacyMembershipVersion(values) === storedVersion
  );
}

/**
 * Capture the connector destination from server-attested canonical room state.
 * Model parameters and message metadata are deliberately not consulted for the
 * destination. Unattested/internal/API turns keep the existing in-app path.
 */
export async function bindScheduledTaskToInboundChat(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ScheduledTaskChatDeliveryBinding | null> {
  const decision = evaluateOwnerExclusiveDisclosure(message);
  const audience = getTrustedDeliveryAudience(message);
  if (
    !decision.allowed ||
    decision.basis !== "owner_private_destination" ||
    !audience ||
    audience.provenance !== "canonical_room" ||
    (audience.kind !== "direct" && audience.kind !== "voice_private") ||
    !audience.canonicalOwnerEntityId
  ) {
    return null;
  }

  // Canonical owner-only audience attestation is shared by connector DMs and
  // first-party/API turns. A first-party request can target a room whose
  // canonical source names the owner's preferred connector, so classify the
  // inbound envelope before consulting that room. Otherwise internal scenario
  // and API turns are rewritten into unavailable outbound connector sends and
  // planner idempotency keys leak a synthetic room suffix.
  const metadataSource = stringField(message.metadata?.source);
  const contentSource = stringField(message.content.source);
  // Either envelope field can carry the real provenance. Do not let a
  // connector-looking metadata value mask an internal content sentinel (or
  // vice versa) through nullish-coalescing precedence.
  if (
    isInternalMessageSource(metadataSource) ||
    isInternalMessageSource(contentSource)
  ) {
    return null;
  }

  const room = await runtime.getRoom(message.roomId);
  const source = stringField(room?.source);
  const channelId = stringField(room?.channelId);
  if (!room || !source || !channelId || room.id !== audience.roomId) {
    return null;
  }
  if (isInternalMessageSource(source) || channelId === room.id) {
    return null;
  }

  const roomMetadata =
    room.metadata && typeof room.metadata === "object"
      ? (room.metadata as Record<string, unknown>)
      : undefined;
  const accountId = stringField(roomMetadata?.accountId);
  return {
    version: 1,
    source,
    roomId: room.id,
    channelId,
    ...(accountId ? { accountId } : {}),
    audience: {
      kind: audience.kind,
      provenance: "canonical_room",
      ownerEntityId: audience.canonicalOwnerEntityId,
      agentEntityId: audience.agentEntityId,
      participantEntityIds: [...audience.participantEntityIds],
      membershipVersion: membershipVersion(audience.participantEntityIds),
    },
  };
}

function hasScheduledTaskChatDeliveryBinding(
  metadata: ScheduledTaskDispatchRecord["metadata"],
): boolean {
  return Boolean(
    metadata && Object.hasOwn(metadata, SCHEDULED_TASK_DELIVERY_BINDING_KEY),
  );
}

export function readScheduledTaskChatDeliveryBinding(
  metadata: ScheduledTaskDispatchRecord["metadata"],
): ScheduledTaskChatDeliveryBinding | null {
  const value = metadata?.[SCHEDULED_TASK_DELIVERY_BINDING_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Partial<ScheduledTaskChatDeliveryBinding>;
  const audience = binding.audience;
  if (
    binding.version !== 1 ||
    !stringField(binding.source) ||
    !stringField(binding.roomId) ||
    !stringField(binding.channelId) ||
    !audience ||
    audience.provenance !== "canonical_room" ||
    (audience.kind !== "direct" && audience.kind !== "voice_private") ||
    !stringField(audience.ownerEntityId) ||
    !stringField(audience.agentEntityId) ||
    !Array.isArray(audience.participantEntityIds) ||
    !stringField(audience.membershipVersion)
  ) {
    return null;
  }
  return binding as ScheduledTaskChatDeliveryBinding;
}

/** Re-read canonical room state immediately before visible connector egress. */
export async function revalidateScheduledTaskChatDeliveryBinding(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<
  | { ok: true; binding: ScheduledTaskChatDeliveryBinding }
  | { ok: false; reason: string }
  | null
> {
  const binding = readScheduledTaskChatDeliveryBinding(record.metadata);
  if (!binding) {
    return hasScheduledTaskChatDeliveryBinding(record.metadata)
      ? { ok: false, reason: "delivery_binding_invalid" }
      : null;
  }
  if (
    record.channelKey !== binding.source ||
    record.output?.destination !== "channel" ||
    record.output.target !== `${binding.source}:${binding.channelId}`
  ) {
    return { ok: false, reason: "delivery_channel_changed" };
  }
  try {
    const [room, participants] = await Promise.all([
      runtime.getRoom(binding.roomId as never),
      runtime.getParticipantsForRoom(binding.roomId as never),
    ]);
    const current = canonicalParticipants(participants);
    const expected = canonicalParticipants(
      binding.audience.participantEntityIds,
    );
    const roomMetadata =
      room?.metadata && typeof room.metadata === "object"
        ? (room.metadata as Record<string, unknown>)
        : undefined;
    const currentAccountId = stringField(roomMetadata?.accountId);
    if (
      !room ||
      room.source !== binding.source ||
      room.channelId !== binding.channelId ||
      currentAccountId !== binding.accountId ||
      binding.audience.agentEntityId !== runtime.agentId ||
      current.length !== expected.length ||
      current.some((value, index) => value !== expected[index]) ||
      !matchesMembershipVersion(current, binding.audience.membershipVersion) ||
      current.length !== 2 ||
      !current.includes(binding.audience.ownerEntityId) ||
      !current.includes(binding.audience.agentEntityId)
    ) {
      return { ok: false, reason: "delivery_audience_changed" };
    }
    return { ok: true, binding };
  } catch (error) {
    // error-policy:J4 Failed audience lookup explicitly refuses connector delivery.
    runtime.reportError("lifeops:scheduled-task:delivery-binding", error, {
      taskId: record.taskId,
      roomId: binding.roomId,
    });
    return { ok: false, reason: "delivery_audience_lookup_failed" };
  }
}
