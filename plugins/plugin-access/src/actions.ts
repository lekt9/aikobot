/** Submits account-bound operations; model-facing actions never accept credentials or perform connector delivery. */
import { type Action, ElizaError } from "@elizaos/core";
import { accountIdSchema, operationInputSchema } from "access/client";
import { z } from "zod";
import { accessOperationId, ownerSchema } from "./contracts.ts";
import { accessCoordinator } from "./service.ts";

export const accessActions: Action[] = (
  ["connect", "refresh", "run", "synthesize"] as const
).map((kind) => ({
  name: `ACCESS_${kind.toUpperCase()}`,
  description: `Submit ${kind} work for a connected Access account. Access owns browser execution, harnesses, receipts and effect approval.`,
  routingHint:
    "Website accounts and remote harnesses -> ACCESS actions; recurring schedules -> SCHEDULED_TASKS; secrets -> private Apps form",
  disclosureGate: { require: "owner_exclusive" },
  parameters: [
    {
      name: "accountId",
      description: "Connected account ID from the Apps drawer",
      required: true,
      schema: { type: "string" },
    },
    ...(kind === "connect"
      ? []
      : [
          {
            name: "intent",
            description:
              "Complete requested outcome without passwords or verification codes",
            required: true,
            schema: { type: "string" as const },
          },
        ]),
  ],
  validate: async (runtime, message) =>
    ownerSchema.safeParse(message.entityId).success &&
    runtime.getService("access") !== null,
  handler: async (runtime, message, _state, options) => {
    const ownerId = ownerSchema.parse(message.entityId);
    if (!message.id)
      throw new ElizaError(
        "Access work requires a durable triggering message",
        { code: "ACCESS_MESSAGE_ID_REQUIRED" },
      );
    const input = (
      kind === "connect"
        ? z.object({ accountId: accountIdSchema }).strict()
        : z
            .object({ accountId: accountIdSchema, intent: z.string().min(1) })
            .strict()
    ).parse(options?.parameters);
    const id = accessOperationId(
      `${message.id}:${kind}:${JSON.stringify(input)}`,
    );
    const { accountId: _accountId, ...payload } = input;
    const operation = operationInputSchema.parse({ id, kind, ...payload });
    const service = accessCoordinator(runtime);
    await service.enroll(ownerId);
    const result = await service
      .client(ownerId)
      .accounts.submit(input.accountId, operation);
    return {
      success: true,
      text: `Access operation ${result.id} is ${result.status}.`,
      data: { operation: result },
    };
  },
}));
