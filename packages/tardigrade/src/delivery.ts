/**
 * Delivery port and the journaled handler callback. Everything Eliza hands to
 * the turn's callback — reply text, attachment URLs, action markers — becomes
 * a keyed delivery boundary before the port sends it, so a recovered turn
 * never sends the same content twice and the durable log names exactly what
 * the user was shown. The default port delivers nothing outward: the
 * Tardigrade method result is the delivery, and the journal entry is the
 * receipt.
 */

import {
  type Content,
  ElizaError,
  type HandlerCallback,
  type Memory,
} from "@elizaos/core/edge";
import type { ElizaEffectPolicy } from "./events";
import type { BoundaryExecutionContext, BoundaryRecorder } from "./journal";

export interface DeliveryContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<string>;
  readonly actionName?: string;
}

export interface DeliveryReceipt {
  readonly delivered: boolean;
  readonly receipt: string;
}

export interface DeliveryPort {
  readonly name: string;
  /** `idempotent` when the port dedupes on the operation id, otherwise `unsafe`. */
  readonly policy: ElizaEffectPolicy;
  deliver(
    content: DeliveryContent,
    context: BoundaryExecutionContext,
  ): Promise<DeliveryReceipt>;
}

/** The method result is the delivery; the journal entry is its receipt. */
export const turnOutputDelivery: DeliveryPort = {
  name: "turn-output",
  policy: "idempotent",
  deliver: async (_content, context) => ({
    delivered: true,
    receipt: context.operationId,
  }),
};

export const TARDIGRADE_REPLY_CONTROL_TOKENS =
  "TARDIGRADE_REPLY_CONTROL_TOKENS";

/**
 * Provider control-token markup that must never reach a user as prose:
 * `<|…|>` / `<｜…｜>` special tokens and DeepSeek's `<｜｜DSML｜｜ …>` tool
 * markup, which the model sometimes emits as text in a tool-less call.
 */
const CONTROL_TOKEN_MARKUP =
  /<\|[^|<>]{0,64}\|>|<｜[^｜<>]{0,64}｜>|<｜｜|｜｜>/u;

/** The first control-token marker in a reply, or undefined when it is prose. */
export function replyControlTokenMarker(text: string): string | undefined {
  return CONTROL_TOKEN_MARKUP.exec(text)?.[0];
}

export function deliveryContentOf(
  content: Content,
  actionName?: string,
): DeliveryContent {
  const attachments = (content.attachments ?? []).flatMap((attachment) =>
    typeof attachment.url === "string" && attachment.url.trim()
      ? [attachment.url.trim()]
      : [],
  );
  return {
    text: content.text?.trim() ?? "",
    attachments,
    actions: [...(content.actions ?? [])],
    ...(actionName === undefined ? {} : { actionName }),
  };
}

export interface JournaledDeliveryOptions {
  readonly port: DeliveryPort;
  readonly recorder: BoundaryRecorder;
  readonly onDelivered: (
    content: DeliveryContent,
    receipt: DeliveryReceipt,
  ) => void;
  /** Receives content refused for carrying provider control tokens. */
  readonly onRefused?: (content: DeliveryContent, marker: string) => void;
}

/** Wraps the port as Eliza's handler callback; empty content is not a delivery. */
export function createJournaledDeliveryCallback(
  options: JournaledDeliveryOptions,
): HandlerCallback {
  return async (content: Content, actionName?: string): Promise<Memory[]> => {
    const delivery = deliveryContentOf(content, actionName);
    if (!delivery.text && delivery.attachments.length === 0) return [];
    const marker = replyControlTokenMarker(delivery.text);
    if (marker !== undefined) {
      // error-policy:J1 the delivery boundary refuses provider control-token
      // markup: the refusal is journaled as a failed boundary, the port never
      // sends it, and the turn runner ends the turn with a typed failure.
      const refusal = new ElizaError(
        `Reply carries provider control tokens (${JSON.stringify(marker)}); not delivered`,
        {
          code: TARDIGRADE_REPLY_CONTROL_TOKENS,
          context: {
            marker,
            port: options.port.name,
            actionName: actionName ?? null,
          },
        },
      );
      await options.recorder
        .record<never>({
          kind: "delivery",
          name: options.port.name,
          policy: options.port.policy,
          input: delivery,
          execute: async () => {
            throw refusal;
          },
        })
        .catch(() => undefined);
      options.onRefused?.(delivery, marker);
      return [];
    }
    const receipt = await options.recorder.record<DeliveryReceipt>({
      kind: "delivery",
      name: options.port.name,
      policy: options.port.policy,
      input: delivery,
      execute: (context) => options.port.deliver(delivery, context),
    });
    options.onDelivered(delivery, receipt);
    return [];
  };
}
