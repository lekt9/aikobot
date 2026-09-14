/**
 * Runs one Eliza turn for a Tardigrade thread. The turn constructs an
 * ephemeral edge `AgentRuntime` over an in-memory adapter, seeds the complete
 * projected history, and invokes the canonical `messageService.handleMessage`
 * with the host's model, plugins, and delivery all routed through the effect
 * journal. Eliza keeps its decision loop; the journal makes each external
 * boundary durable and replayable. Domain stores stay host-owned ports.
 *
 * Owner and sender are principals bound by the host boundary: the owner is the
 * agent's OWNER in the ephemeral world, and a different sender is admitted as a
 * GUEST, which is what role-gated actions evaluate against.
 */

import {
  type ActionResult,
  AgentRuntime,
  ChannelType,
  type Character,
  createMessageMemory,
  ElizaError,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  type Memory,
  type Plugin,
  ServiceType,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core/edge";
import { TaskService } from "@elizaos/core/services/task";
import type { Event } from "tardie/core/event";
import {
  assertTardigradeCompatible,
  type DeclaredPlugin,
  type TardigradeHostCapabilities,
} from "./compatibility";
import {
  createJournaledDeliveryCallback,
  type DeliveryContent,
  type DeliveryPort,
  type DeliveryReceipt,
} from "./delivery";
import { durablePlugin } from "./durable-plugin";
import type { TurnHistoryEntry } from "./history";
import {
  type BoundaryRecorder,
  type BoundaryRecorderStats,
  createBoundaryRecorder,
  type ReplayDivergence,
  type TurnJournal,
} from "./journal";
import { createJournaledModelPlugin, type ElizaModelPort } from "./model";
import { attachTaskJournal, type TaskJournalAttachment } from "./scheduling";

export type ElizaTurnCharacter = Pick<Character, "name"> &
  Partial<
    Pick<
      Character,
      | "system"
      | "bio"
      | "messageExamples"
      | "postExamples"
      | "topics"
      | "adjectives"
      | "style"
      | "templates"
    >
  >;

export interface ElizaTurnConfig {
  readonly agentKey: string;
  readonly character: ElizaTurnCharacter;
  readonly plugins: ReadonlyArray<DeclaredPlugin>;
  readonly model: ElizaModelPort;
  readonly delivery: DeliveryPort;
  readonly host: TardigradeHostCapabilities;
  /** Extra plugins registered without journaling (test instrumentation). */
  readonly observers?: ReadonlyArray<Plugin>;
  readonly now?: () => number;
}

export interface ElizaTurnRequest {
  readonly turn: string;
  readonly epoch: number;
  readonly text: string;
  readonly owner: string;
  readonly sender: string;
  readonly source: string;
  readonly roomKey: string;
  readonly history: ReadonlyArray<TurnHistoryEntry>;
  readonly journal: TurnJournal;
  /** Scheduled tasks projected from the log, seeded into the ephemeral runtime. */
  readonly tasks: ReadonlyArray<Task>;
  readonly append: (events: ReadonlyArray<Event>) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ElizaTickRequest {
  readonly tick: string;
  readonly epoch: number;
  readonly owner: string;
  readonly roomKey: string;
  readonly journal: TurnJournal;
  readonly tasks: ReadonlyArray<Task>;
  readonly append: (events: ReadonlyArray<Event>) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ElizaTickOutcome {
  readonly executed: number;
  readonly stats: BoundaryRecorderStats;
}

export interface ElizaTurnOutcome {
  readonly reply: string;
  readonly responded: boolean;
  readonly delivered: ReadonlyArray<{
    content: DeliveryContent;
    receipt: DeliveryReceipt;
  }>;
  readonly actionResults: ReadonlyArray<ActionResult>;
  readonly stats: BoundaryRecorderStats;
  readonly diverged: ReadonlyArray<ReplayDivergence>;
}

export const TARDIGRADE_TURN_NO_REPLY = "TARDIGRADE_TURN_NO_REPLY";
export const TARDIGRADE_TURN_MODEL_FAILED = "TARDIGRADE_TURN_MODEL_FAILED";
export const TARDIGRADE_TURN_REPLY_INVALID = "TARDIGRADE_TURN_REPLY_INVALID";

export const elizaAgentId = (agentKey: string): UUID => stringToUuid(agentKey);
export const elizaPrincipalEntityId = (
  agentKey: string,
  principal: string,
): UUID => stringToUuid(`${agentKey}:principal:${principal}`);
export const elizaRoomId = (agentKey: string, roomKey: string): UUID =>
  stringToUuid(`${agentKey}:room:${roomKey}`);
export const elizaWorldId = (agentKey: string, roomKey: string): UUID =>
  stringToUuid(`${agentKey}:world:${roomKey}`);
export const elizaUserMemoryId = (turn: string): UUID =>
  stringToUuid(`${turn}:user`);
export const elizaAssistantMemoryId = (turn: string): UUID =>
  stringToUuid(`${turn}:assistant`);

function characterOf(config: ElizaTurnConfig): Character {
  const character = config.character;
  return {
    name: character.name,
    ...(character.system === undefined ? {} : { system: character.system }),
    bio: character.bio ?? [],
    messageExamples: character.messageExamples ?? [],
    postExamples: character.postExamples ?? [],
    topics: character.topics ?? [],
    adjectives: character.adjectives ?? [],
    ...(character.style === undefined ? {} : { style: character.style }),
    ...(character.templates === undefined
      ? {}
      : { templates: character.templates }),
    plugins: [],
    settings: {
      ELIZA_CANONICAL_LLM_TEXT_ENABLED: true,
      ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
    },
  };
}

function historyMemories(
  config: ElizaTurnConfig,
  request: ElizaTurnRequest,
  agentId: UUID,
  roomId: UUID,
): Memory[] {
  const memories: Memory[] = [];
  for (const entry of request.history) {
    const senderId = elizaPrincipalEntityId(
      config.agentKey,
      entry.sender ?? request.owner,
    );
    const user = createMessageMemory({
      id: elizaUserMemoryId(entry.turn),
      entityId: senderId,
      agentId,
      roomId,
      content: {
        text: entry.text,
        source: request.source,
        channelType: ChannelType.DM,
      },
    });
    user.createdAt = entry.at;
    if (user.metadata) user.metadata.timestamp = entry.at;
    memories.push(user);
    if (entry.output !== undefined && entry.output !== "") {
      const at = entry.outputAt ?? entry.at + 1;
      const assistant = createMessageMemory({
        id: elizaAssistantMemoryId(entry.turn),
        entityId: agentId,
        agentId,
        roomId,
        content: {
          text: entry.output,
          source: request.source,
          channelType: ChannelType.DM,
        },
      });
      assistant.createdAt = at;
      if (assistant.metadata) assistant.metadata.timestamp = at;
      memories.push(assistant);
    }
  }
  return memories;
}

async function teardown(runtime: AgentRuntime, turn: string): Promise<void> {
  for (const [operation, cleanup] of [
    ["stop", () => runtime.stop()],
    ["close", () => runtime.close()],
  ] as const) {
    try {
      await cleanup();
    } catch (error) {
      // error-policy:J6 both teardown operations are best-effort after the
      // authoritative turn result or error; neither may mask it, and a stop
      // failure must not prevent close from being attempted.
      runtime.logger.warn(
        {
          src: "tardigrade:turn",
          turn,
          operation,
          error: error instanceof Error ? error.message : String(error),
        },
        "ephemeral runtime teardown failed",
      );
    }
  }
}

/** Core's TaskService is not part of the edge basic services; the adapter registers it. */
export const taskServicePlugin: Plugin = {
  name: "tardigrade-task-service",
  description:
    "Core TaskService in serverless mode; host wakeups call runDueTasks().",
  services: [TaskService],
};

interface EphemeralRuntime {
  readonly runtime: AgentRuntime;
  readonly adapter: InMemoryDatabaseAdapter;
  readonly recorder: BoundaryRecorder;
  readonly taskJournal: TaskJournalAttachment;
  readonly diverged: ReplayDivergence[];
}

function createEphemeralRuntime(
  config: ElizaTurnConfig,
  scope: {
    readonly turn: string;
    readonly epoch: number;
    readonly journal: TurnJournal;
    readonly append: (events: ReadonlyArray<Event>) => Promise<void>;
  },
): EphemeralRuntime {
  assertTardigradeCompatible(config.plugins, config.host);
  const now = config.now ?? (() => Date.now());
  const diverged: ReplayDivergence[] = [];
  const recorder = createBoundaryRecorder({
    turn: scope.turn,
    epoch: scope.epoch,
    journal: scope.journal,
    append: scope.append,
    now,
    onDiverged: (divergence) => diverged.push(divergence),
  });
  const adapter = new InMemoryDatabaseAdapter();
  const runtime = new AgentRuntime({
    agentId: elizaAgentId(config.agentKey),
    character: characterOf(config),
    adapter,
    plugins: [
      createJournaledModelPlugin({ port: config.model, recorder }),
      taskServicePlugin,
      ...config.plugins.map((declared) => durablePlugin(declared, recorder)),
      ...(config.observers ?? []),
    ],
    logLevel: "error",
    disableBasicCapabilities: false,
    actionPlanning: true,
    checkShouldRespond: true,
    enableAutonomy: false,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
  });
  // Host wakeups drive TaskService.runDueTasks; no timer may start here.
  (runtime as IAgentRuntime).serverless = true;
  const taskJournal = attachTaskJournal(runtime, {
    recorder,
    append: scope.append,
    turn: scope.turn,
    now,
  });
  return { runtime, adapter, recorder, taskJournal, diverged };
}

async function connectPrincipals(
  runtime: AgentRuntime,
  config: ElizaTurnConfig,
  scope: {
    readonly owner: string;
    readonly sender: string;
    readonly source: string;
    readonly roomKey: string;
  },
): Promise<{ ownerEntityId: UUID; senderEntityId: UUID; roomId: UUID }> {
  const roomId = elizaRoomId(config.agentKey, scope.roomKey);
  const worldId = elizaWorldId(config.agentKey, scope.roomKey);
  const ownerEntityId = elizaPrincipalEntityId(config.agentKey, scope.owner);
  const senderEntityId = elizaPrincipalEntityId(config.agentKey, scope.sender);
  // Core honors an explicit OWNER grant only from a manual source; the
  // binding was authenticated by the host boundary, which is that source.
  const roles: Record<string, string> = { [ownerEntityId]: "OWNER" };
  const roleSources: Record<string, string> = { [ownerEntityId]: "manual" };
  if (senderEntityId !== ownerEntityId) {
    roles[senderEntityId] = "GUEST";
    roleSources[senderEntityId] = "manual";
  }
  for (const [entityId, userName] of [
    [ownerEntityId, scope.owner],
    ...(senderEntityId === ownerEntityId
      ? []
      : [[senderEntityId, scope.sender] as const]),
  ] as const) {
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      userName,
      source: scope.source,
      type: ChannelType.DM,
      metadata: { roles, roleSources },
    });
  }
  return { ownerEntityId, senderEntityId, roomId };
}

/** Runs the turn; throws when the turn cannot complete honestly. */
export async function runElizaTurn(
  config: ElizaTurnConfig,
  request: ElizaTurnRequest,
): Promise<ElizaTurnOutcome> {
  const { runtime, adapter, recorder, taskJournal, diverged } =
    createEphemeralRuntime(config, request);
  const now = config.now ?? (() => Date.now());
  const agentId = elizaAgentId(config.agentKey);
  try {
    await runtime.initialize({ skipMigrations: true });
    const { senderEntityId, roomId } = await connectPrincipals(
      runtime,
      config,
      request,
    );
    await taskJournal.activate(request.tasks);
    const memories = historyMemories(config, request, agentId, roomId);
    if (memories.length > 0) {
      await adapter.createMemories(
        memories.map((memory) => ({ tableName: "messages", memory })),
      );
    }
    const messageService = runtime.messageService;
    if (!messageService) {
      throw new ElizaError(
        "Eliza runtime initialized without a message service",
        {
          code: "TARDIGRADE_MESSAGE_SERVICE_MISSING",
          context: { agentKey: config.agentKey },
        },
      );
    }
    const delivered: Array<{
      content: DeliveryContent;
      receipt: DeliveryReceipt;
    }> = [];
    const refused: Array<{ content: DeliveryContent; marker: string }> = [];
    const callback = createJournaledDeliveryCallback({
      port: config.delivery,
      recorder,
      onDelivered: (content, receipt) => delivered.push({ content, receipt }),
      onRefused: (content, marker) => refused.push({ content, marker }),
    });
    const incoming = createMessageMemory({
      id: elizaUserMemoryId(request.turn),
      entityId: senderEntityId,
      agentId,
      roomId,
      content: {
        text: request.text.trim(),
        source: request.source,
        channelType: ChannelType.DM,
        chatIdempotency: { version: 1, clientMessageId: request.turn },
      },
    });
    const at = now();
    incoming.createdAt = at;
    if (incoming.metadata) incoming.metadata.timestamp = at;
    const result = await messageService.handleMessage(
      runtime,
      incoming,
      callback,
      {
        ...(request.signal ? { abortSignal: request.signal } : {}),
      },
    );
    const reply =
      delivered.at(-1)?.content.text ||
      result.responseContent?.text?.trim() ||
      "";
    const responded = result.didRespond === true || delivered.length > 0;
    if (responded && !reply) {
      throw new ElizaError(
        "Eliza turn responded without a user-visible reply",
        {
          code: TARDIGRADE_TURN_NO_REPLY,
          context: { turn: request.turn, agentKey: config.agentKey },
        },
      );
    }
    // A reply the delivery boundary refused (provider control tokens as prose)
    // is not a completed turn: the recorded action results are preserved in
    // the failure so the caller knows what committed.
    if (refused.length > 0) {
      throw new ElizaError(
        `Eliza turn reply carried provider control tokens (${refused.map((entry) => JSON.stringify(entry.marker)).join(", ")}) and was not delivered`,
        {
          code: TARDIGRADE_TURN_REPLY_INVALID,
          context: {
            turn: request.turn,
            refused: refused.map((entry) => ({
              marker: entry.marker,
              text: entry.content.text,
            })),
            actionResults: result.actionResults ?? [],
          },
        },
      );
    }
    // Eliza answers a model-provider failure with a generated apology and
    // reports the turn as delivered. Under durable execution that reply may
    // follow an effect that already committed, so the failure stays explicit:
    // the delivery is recorded, and the turn ends failed with the boundary error.
    const modelFailures = recorder
      .failures()
      .filter((failure) => failure.kind === "model");
    if (modelFailures.length > 0) {
      throw new ElizaError(
        `Eliza turn reply followed ${modelFailures.length} failed model boundary(ies): ${modelFailures.map((failure) => `${failure.key} ${failure.error}`).join("; ")}`,
        {
          code: TARDIGRADE_TURN_MODEL_FAILED,
          context: {
            turn: request.turn,
            failures: modelFailures,
            reply,
            actionResults: result.actionResults ?? [],
          },
        },
      );
    }
    if (result.terminalFailure) {
      throw new ElizaError(
        `Eliza turn ended in terminal failure (${result.terminalFailure.kind}): ${result.terminalFailure.message}`,
        {
          code: "TARDIGRADE_TURN_TERMINAL_FAILURE",
          context: { turn: request.turn, failure: result.terminalFailure },
        },
      );
    }
    return {
      reply,
      responded,
      delivered,
      actionResults: result.actionResults ?? [],
      stats: recorder.stats(),
      diverged,
    };
  } finally {
    await teardown(runtime, request.turn);
  }
}

/** Runs every due scheduled task once for a host wakeup. */
export async function runElizaTick(
  config: ElizaTurnConfig,
  request: ElizaTickRequest,
): Promise<ElizaTickOutcome> {
  const { runtime, recorder, taskJournal } = createEphemeralRuntime(config, {
    turn: request.tick,
    epoch: request.epoch,
    journal: request.journal,
    append: request.append,
  });
  try {
    await runtime.initialize({ skipMigrations: true });
    await connectPrincipals(runtime, config, {
      owner: request.owner,
      sender: request.owner,
      source: "tardigrade-tick",
      roomKey: request.roomKey,
    });
    await taskJournal.activate(request.tasks);
    const service = await runtime.getServiceLoadPromise(ServiceType.TASK);
    if (!(service instanceof TaskService)) {
      throw new ElizaError(
        "Eliza runtime initialized without the core TaskService",
        {
          code: "TARDIGRADE_TASK_SERVICE_MISSING",
          context: { tick: request.tick, agentKey: config.agentKey },
        },
      );
    }
    request.signal?.throwIfAborted();
    await service.runDueTasks();
    return { executed: taskJournal.executed(), stats: recorder.stats() };
  } finally {
    await teardown(runtime, request.tick);
  }
}
