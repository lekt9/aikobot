/** Commits owner-private Access context in durable core tasks before invoking the existing watcher runner. */
import {
  ElizaError,
  type IAgentRuntime,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import type {
  AccessClient,
  AccessCommittedEvent,
  AccessContextSnapshot,
} from "access/client";
import {
  ACCESS_DRAIN,
  accessFailure,
  type DrainState,
  drainStateSchema,
} from "./contracts.ts";

export type AccessTaskRuntime = Pick<
  IAgentRuntime,
  | "agentId"
  | "getTask"
  | "createTask"
  | "updateTask"
  | "registerTaskWorker"
  | "unregisterTaskWorker"
  | "reportError"
>;
export interface AccessWatchers {
  reconcile(ownerId: UUID, activeAccounts: ReadonlySet<string>): Promise<void>;
  match(
    ownerId: UUID,
    event: AccessCommittedEvent,
    committedContext: AccessContextSnapshot,
  ): Promise<string[]>;
  deliver(
    ownerId: UUID,
    event: AccessCommittedEvent,
    watcherIds: readonly string[],
  ): Promise<void>;
}
export interface AccessCoordinatorOptions {
  client(ownerId: UUID): AccessClient;
  watchers: AccessWatchers;
  /** The hosted Cloudflare API exposes native thread events, without the Bun context projection routes. */
  remoteContextAvailable?: boolean;
}

export class AccessCoordinator {
  private readonly active = new Map<UUID, Promise<void>>();
  private readonly enrollments = new Map<UUID, Promise<void>>();
  private stopped = false;
  constructor(
    readonly runtime: AccessTaskRuntime,
    readonly options: AccessCoordinatorOptions,
  ) {}

  start(): void {
    if (this.options.remoteContextAvailable === false) return;
    this.runtime.registerTaskWorker({
      name: ACCESS_DRAIN,
      execute: async (_runtime, _options, task) => {
        if (this.stopped) return { preserveTask: true };
        const state = this.readState(task);
        try {
          await this.drain(state.ownerId);
        } catch (cause) {
          // error-policy:J2 TaskService owns retry/backoff; report only sanitized diagnostics.
          const failure = accessFailure("ACCESS_DRAIN_FAILED", cause);
          this.runtime.reportError("AccessService.drain", failure, {
            ownerId: state.ownerId,
          });
          throw failure;
        }
        return undefined;
      },
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.runtime.unregisterTaskWorker(ACCESS_DRAIN);
    await Promise.allSettled(this.active.values());
  }
  taskId(ownerId: UUID): UUID {
    return stringToUuid(`${this.runtime.agentId}:access:drain:${ownerId}`);
  }
  client(ownerId: UUID): AccessClient {
    return this.options.client(ownerId);
  }

  private readState(task: Task): DrainState {
    const parsed = drainStateSchema.safeParse(task.metadata?.values?.access);
    if (
      !parsed.success ||
      task.agentId !== this.runtime.agentId ||
      task.entityId !== parsed.data.ownerId ||
      task.id !== this.taskId(parsed.data.ownerId)
    ) {
      throw new ElizaError("Access task owner binding is invalid", {
        code: "ACCESS_TASK_SCOPE_INVALID",
      });
    }
    return parsed.data;
  }
  private async task(ownerId: UUID): Promise<Task> {
    const task = await this.runtime.getTask(this.taskId(ownerId));
    if (task === null)
      throw new ElizaError("Connect an app before requesting Access work", {
        code: "ACCESS_OWNER_NOT_ENROLLED",
      });
    this.readState(task);
    return task;
  }
  async enroll(ownerId: UUID): Promise<void> {
    const existing = this.enrollments.get(ownerId);
    if (existing !== undefined) return existing;
    const work = this.enrollOwner(ownerId);
    this.enrollments.set(ownerId, work);
    try {
      await work;
    } finally {
      this.enrollments.delete(ownerId);
    }
  }
  private async enrollOwner(ownerId: UUID): Promise<void> {
    if (this.options.remoteContextAvailable === false) return;
    if ((await this.runtime.getTask(this.taskId(ownerId))) !== null) {
      await this.task(ownerId);
      return;
    }
    const state: DrainState = {
      format: "aiko.access-drain/v1",
      ownerId,
      cursor: 0,
      seenEventIds: [],
      pending: null,
      context: {
        cursor: 0,
        evidence: [],
        status: "unavailable",
        error: "Access context has not synchronized",
      },
    };
    await this.runtime.createTask({
      id: this.taskId(ownerId),
      agentId: this.runtime.agentId,
      entityId: ownerId,
      name: ACCESS_DRAIN,
      description: "Synchronize committed Access evidence for this owner",
      tags: ["queue", "repeat", "access"],
      metadata: {
        updatedAt: 0,
        updateInterval: 5000,
        blocking: true,
        maxFailures: 0,
        values: { access: state },
      },
    });
  }
  async context(ownerId: UUID): Promise<AccessContextSnapshot> {
    if (this.options.remoteContextAvailable === false)
      return {
        cursor: 0,
        evidence: [],
        status: "unavailable",
        error: "This Access host exposes context through native thread events",
      };
    const task = await this.runtime.getTask(this.taskId(ownerId));
    if (task === null)
      return {
        cursor: 0,
        evidence: [],
        status: "unavailable",
        error: "No Access connection has synchronized",
      };
    const snapshot = this.readState(task).context;
    if (task.metadata?.lastError)
      return {
        ...snapshot,
        status: "unavailable",
        error: "Access synchronization failed; pending work will retry",
      };
    return snapshot;
  }
  private async save(ownerId: UUID, state: DrainState): Promise<void> {
    const task = await this.task(ownerId);
    await this.runtime.updateTask(this.taskId(ownerId), {
      metadata: {
        ...task.metadata,
        values: { ...task.metadata?.values, access: state },
      },
    });
  }
  async drain(ownerId: UUID): Promise<void> {
    const running = this.active.get(ownerId);
    if (running !== undefined) return running;
    const work = this.drainOwner(ownerId);
    this.active.set(ownerId, work);
    try {
      await work;
    } finally {
      this.active.delete(ownerId);
    }
  }
  private async drainOwner(ownerId: UUID): Promise<void> {
    let state = this.readState(await this.task(ownerId));
    const client = this.client(ownerId);
    const { accounts } = await client.accounts.list();
    const activeAccounts = new Set(
      accounts.filter((account) => account.active).map((account) => account.id),
    );
    const finishPending = async (): Promise<void> => {
      const pending = state.pending;
      if (pending === null) return;
      if (activeAccounts.has(pending.event.accountId)) {
        if (pending.watcherIds === null) {
          pending.watcherIds = await this.options.watchers.match(
            ownerId,
            pending.event,
            state.context,
          );
          await this.save(ownerId, state);
        }
        await this.options.watchers.deliver(
          ownerId,
          pending.event,
          pending.watcherIds,
        );
      }
      state = {
        ...state,
        cursor: pending.event.cursor,
        seenEventIds: [...state.seenEventIds, pending.event.id],
        pending: null,
      };
      await this.save(ownerId, state);
    };
    const snapshot = await client.context();
    if (snapshot.status !== "ready") {
      state = {
        ...state,
        context: {
          ...state.context,
          status: "unavailable",
          error: "Access context is unavailable",
        },
      };
      await this.save(ownerId, state);
      throw accessFailure("ACCESS_CONTEXT_UNAVAILABLE");
    }
    const retained = new Map(
      state.context.evidence
        .filter((evidence) => activeAccounts.has(evidence.accountId))
        .map((evidence) => [JSON.stringify(evidence), evidence]),
    );
    for (const evidence of snapshot.evidence.filter((evidence) =>
      activeAccounts.has(evidence.accountId),
    ))
      retained.set(JSON.stringify(evidence), evidence);
    state = {
      ...state,
      context: { ...snapshot, evidence: Array.from(retained.values()) },
    };
    await this.save(ownerId, state);
    await this.options.watchers.reconcile(ownerId, activeAccounts);
    await finishPending();
    for (;;) {
      const page = await client.events(state.cursor);
      let cursor = state.cursor;
      for (const event of page.events) {
        if (
          event.cursor <= cursor ||
          event.cursor > page.nextCursor ||
          event.evidence.some((item) => item.accountId !== event.accountId)
        ) {
          throw new ElizaError(
            "Access event sequence or account scope is invalid",
            { code: "ACCESS_EVENT_SCOPE_INVALID" },
          );
        }
        cursor = event.cursor;
        if (
          state.seenEventIds.includes(event.id) ||
          !activeAccounts.has(event.accountId)
        ) {
          state = {
            ...state,
            cursor,
            seenEventIds: state.seenEventIds.includes(event.id)
              ? state.seenEventIds
              : [...state.seenEventIds, event.id],
          };
          await this.save(ownerId, state);
          continue;
        }
        const evidence = new Map(
          state.context.evidence.map((item) => [JSON.stringify(item), item]),
        );
        for (const item of event.evidence)
          evidence.set(JSON.stringify(item), item);
        state = {
          ...state,
          context: {
            ...state.context,
            cursor: Math.max(state.context.cursor, cursor),
            evidence: Array.from(evidence.values()),
          },
          pending: { event, watcherIds: null },
        };
        await this.save(ownerId, state);
        await finishPending();
      }
      if (
        page.nextCursor < cursor ||
        (page.hasMore &&
          page.nextCursor <= state.cursor &&
          page.events.length === 0)
      )
        throw accessFailure("ACCESS_EVENT_CURSOR_INVALID");
      state = { ...state, cursor: page.nextCursor };
      await this.save(ownerId, state);
      if (!page.hasMore || this.stopped) return;
    }
  }
}
