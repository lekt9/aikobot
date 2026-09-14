/** Validates owner identity and durable event-drain state before either can grant execution scope. */
import { createHash } from "node:crypto";
import { type AccessContext, ElizaError, type UUID } from "@elizaos/core";
import {
  committedEventSchema,
  contextSchema,
  operationIdSchema,
} from "access/client";
import { z } from "zod";

export const ownerSchema = z.custom<UUID>(
  (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
);
export const ACCESS_EVENT = "access.evidence.committed";
export const ACCESS_DRAIN = "ACCESS_EVENT_DRAIN";
export const ACCESS_REFRESH_CHANNEL = "access_refresh";
export const bindingSchema = z
  .object({ ownerId: ownerSchema, accountId: z.string().min(1) })
  .strict();
export const drainStateSchema = z
  .object({
    format: z.literal("aiko.access-drain/v1"),
    ownerId: ownerSchema,
    cursor: z.number().int().nonnegative(),
    context: contextSchema,
    seenEventIds: z.array(z.string()),
    pending: z
      .object({
        event: committedEventSchema,
        watcherIds: z.array(z.string()).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DrainState = z.infer<typeof drainStateSchema>;

export function ownerFromBoundary(context: AccessContext | undefined): UUID {
  const parsed = ownerSchema.safeParse(context?.requesterEntityId);
  if (!parsed.success)
    throw new ElizaError("Access requires an authenticated requester", {
      code: "ACCESS_OWNER_REQUIRED",
    });
  return parsed.data;
}

export function accessFailure(code: string, cause?: unknown): ElizaError {
  // External transport and persistence errors can contain secret parameters; preserve only a sanitized cause.
  return new ElizaError(
    "Access operation is unavailable; inspect the connection and retry",
    {
      code,
      severity: "ephemeral",
      ...(cause === undefined
        ? {}
        : { cause: new Error("Access dependency failed") }),
    },
  );
}

/** Derives a replay-stable RFC UUIDv8 for the Access wire protocol; core task IDs use a custom version-zero format. */
export function accessOperationId(key: string): string {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return operationIdSchema.parse(
    hex.replace(
      /^(........)(....)(....)(....)(............)$/,
      "$1-$2-$3-$4-$5",
    ),
  );
}
