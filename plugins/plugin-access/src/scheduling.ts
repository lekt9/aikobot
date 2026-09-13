/** Routes Access refresh work and owner-authorized notifications through the existing ScheduledTask runner. */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import {
  bindScheduledTaskToOwnerChat,
  type DispatchResult,
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
  type ScheduledTaskRunnerHandle,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import type { AccessClient } from "access/client";
import { z } from "zod";
import {
  ACCESS_EVENT,
  ACCESS_REFRESH_CHANNEL,
  accessFailure,
  accessOperationId,
  bindingSchema,
  ownerSchema,
} from "./contracts.ts";
import type { AccessWatchers } from "./coordinator.ts";
import { judgeAccessRelevance } from "./relevance.ts";

export const watcherInputSchema = z
  .object({
    id: z.string().uuid(),
    intent: z.string().min(1),
    channelKey: z.literal("telegram"),
    roomId: ownerSchema.optional(),
  })
  .strict();
export const pollInputSchema = z
  .object({
    id: z.string().uuid(),
    intent: z.string().min(1),
    everyMinutes: z.number().positive(),
  })
  .strict();
const refreshMetadataSchema = bindingSchema.extend({
  intent: z.string().min(1),
});

export function createAccessWatchers(
  getRunner: () => ScheduledTaskRunnerHandle,
  runtime: IAgentRuntime,
): AccessWatchers {
  return {
    async reconcile(ownerId, activeAccounts) {
      const runner = getRunner();
      for (const task of await runner.list({
        kind: "watcher",
        status: "scheduled",
      })) {
        const binding = bindingSchema.safeParse(task.metadata?.access);
        if (
          !binding.success ||
          binding.data.ownerId !== ownerId ||
          task.createdBy !== ownerId ||
          typeof task.metadata?.accessWatcherId !== "string" ||
          activeAccounts.has(binding.data.accountId)
        )
          continue;
        await runner.applyWithResult(
          task.taskId,
          "dismiss",
          { reason: "Access account was revoked" },
          { idempotencyKey: `access-revoked:${ownerId}:${task.taskId}` },
        );
      }
    },
    async match(ownerId, event, committedContext) {
      if (event.type !== "evidence.committed") return [];
      const tasks = await getRunner().list({
        kind: "watcher",
        status: "scheduled",
      });
      const candidates = tasks.filter((task) => {
        const binding = bindingSchema.safeParse(task.metadata?.access);
        return (
          binding.success &&
          binding.data.ownerId === ownerId &&
          binding.data.accountId === event.accountId &&
          task.createdBy === ownerId &&
          task.trigger.kind === "event" &&
          task.trigger.eventKind === ACCESS_EVENT
        );
      });
      const matched: string[] = [];
      for (const task of candidates) {
        if (
          await judgeAccessRelevance(runtime, {
            ownerId,
            intent: task.promptInstructions,
            context: committedContext,
            event,
          })
        )
          matched.push(task.taskId);
      }
      return matched;
    },
    async deliver(ownerId, event, watcherIds) {
      const runner = getRunner();
      const tasks = await runner.list();
      for (const watcherId of watcherIds) {
        const template = tasks.find((task) => task.taskId === watcherId);
        if (template === undefined || template.state.status === "dismissed")
          continue;
        const binding = bindingSchema.safeParse(template.metadata?.access);
        if (
          !binding.success ||
          binding.data.ownerId !== ownerId ||
          binding.data.accountId !== event.accountId ||
          template.createdBy !== ownerId
        )
          throw accessFailure("ACCESS_WATCHER_SCOPE_INVALID");
        // The standing watcher is a template. Each committed event owns an idempotent scheduled
        // occurrence; retries recover the same runner claim and connector dispatch receipt.
        const { taskId: _taskId, state: _state, ...input } = template;
        const result = await runner.scheduleWithResult({
          ...input,
          trigger: { kind: "manual" },
          shouldFire: {
            compose: "all",
            gates: [
              ...(input.shouldFire?.gates ?? []),
              ...["quiet_hours", "model_moment_check"]
                .filter(
                  (kind) =>
                    !input.shouldFire?.gates.some((gate) => gate.kind === kind),
                )
                .map((kind) => ({ kind })),
            ],
          },
          idempotencyKey: `access:${ownerId}:${watcherId}:${event.id}`,
          metadata: {
            ...input.metadata,
            accessEventId: event.id,
            accessWatcherId: watcherId,
          },
        });
        if (
          ["skipped", "dismissed", "expired"].includes(result.task.state.status)
        )
          continue;
        if (
          ["fired", "acknowledged", "completed"].includes(
            result.task.state.status,
          )
        ) {
          const delivered = z
            .object({ ok: z.literal(true) })
            .passthrough()
            .safeParse(result.task.metadata?.lastDispatchResult);
          if (!delivered.success)
            throw accessFailure("ACCESS_WATCHER_DELIVERY_UNCERTAIN");
          continue;
        }
        // A scheduled occurrence with a persisted fire time is owned by the native runner's defer/retry clock.
        if (
          result.task.state.status === "scheduled" &&
          result.task.state.firedAt !== undefined
        )
          continue;
        if (result.task.state.status === "failed")
          throw accessFailure("ACCESS_WATCHER_DISPATCH_FAILED");
        const fired = await runner.fireWithResult(result.task.taskId, {
          eventPayload: {
            ownerId,
            accountId: event.accountId,
            eventId: event.id,
            evidence: event.evidence,
          },
        });
        if (
          fired.kind === "fired" &&
          !z
            .object({ ok: z.literal(true) })
            .passthrough()
            .safeParse(fired.task.metadata?.lastDispatchResult).success
        )
          throw accessFailure("ACCESS_WATCHER_TYPED_RESULT_REQUIRED");
        if (fired.kind === "dispatch_failed")
          throw accessFailure("ACCESS_WATCHER_DISPATCH_FAILED");
        if (fired.kind === "raced")
          throw accessFailure("ACCESS_WATCHER_DISPATCH_IN_PROGRESS");
        // A deferred dispatch is durably owned by the existing scheduler and its retry policy.
      }
    },
  };
}

export async function scheduleAccessWatcher(
  runtime: IAgentRuntime,
  ownerId: UUID,
  accountId: string,
  input: z.infer<typeof watcherInputSchema>,
) {
  const binding = await bindScheduledTaskToOwnerChat(runtime, {
    ownerId,
    source: "telegram",
    ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
  });
  if (binding === null)
    throw accessFailure("ACCESS_TELEGRAM_OWNER_TARGET_REQUIRED");
  return getScheduledTaskRunner(runtime, {
    agentId: runtime.agentId,
  }).scheduleWithResult({
    kind: "watcher",
    promptInstructions: input.intent,
    output: { destination: "channel", target: `telegram:${binding.channelId}` },
    trigger: {
      kind: "event",
      eventKind: ACCESS_EVENT,
      filter: { ownerId, accountId },
    },
    contextRequest: { includeEventPayload: true },
    priority: "medium",
    shouldFire: {
      compose: "all",
      gates: [{ kind: "quiet_hours" }, { kind: "model_moment_check" }],
    },
    escalation: { steps: [{ delayMinutes: 0, channelKey: input.channelKey }] },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: ownerId,
    ownerVisible: true,
    idempotencyKey: `access-watcher:${ownerId}:${input.id}`,
    metadata: { access: { ownerId, accountId }, chatDeliveryBinding: binding },
  });
}

export async function scheduleAccessRefresh(
  runtime: IAgentRuntime,
  ownerId: UUID,
  accountId: string,
  input: z.infer<typeof pollInputSchema>,
) {
  return getScheduledTaskRunner(runtime, {
    agentId: runtime.agentId,
  }).scheduleWithResult({
    kind: "watcher",
    promptInstructions: input.intent,
    trigger: { kind: "interval", everyMinutes: input.everyMinutes },
    priority: "medium",
    shouldFire: { gates: [] },
    escalation: {
      steps: [{ delayMinutes: 0, channelKey: ACCESS_REFRESH_CHANNEL }],
    },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: ownerId,
    ownerVisible: true,
    idempotencyKey: `access-poll:${ownerId}:${input.id}`,
    metadata: { accessRefresh: { ownerId, accountId, intent: input.intent } },
  });
}

export function registerAccessRefreshChannel(
  runtime: IAgentRuntime,
  client: (ownerId: UUID) => AccessClient,
): () => void {
  registerScheduledTaskChannelDispatcher(runtime, {
    channelKey: ACCESS_REFRESH_CHANNEL,
    async dispatch(record): Promise<DispatchResult> {
      const binding = refreshMetadataSchema.safeParse(
        record.metadata?.accessRefresh,
      );
      if (!binding.success) throw accessFailure("ACCESS_REFRESH_SCOPE_INVALID");
      const task = (
        await getScheduledTaskRunner(runtime, {
          agentId: runtime.agentId,
        }).list()
      ).find((candidate) => candidate.taskId === record.taskId);
      if (task?.createdBy !== binding.data.ownerId)
        throw accessFailure("ACCESS_REFRESH_SCOPE_INVALID");
      const operation = await client(binding.data.ownerId).accounts.submit(
        binding.data.accountId,
        {
          id: accessOperationId(
            `access-refresh:${record.taskId}:${record.firedAtIso}`,
          ),
          kind: "refresh",
          intent: binding.data.intent,
        },
      );
      return {
        ok: true,
        metadata: { operationId: operation.id, status: operation.status },
      };
    },
  });
  return () =>
    unregisterScheduledTaskChannelDispatcher(runtime, ACCESS_REFRESH_CHANNEL);
}
