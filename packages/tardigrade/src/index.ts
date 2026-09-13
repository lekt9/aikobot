/**
 * Public surface of the elizaOS Tardigrade host adapter. Hosts compose an
 * Eliza actor from declared-compatible edge plugins and mount it on Bun or
 * Cloudflare; tests and operators reach the same durable-boundary contract,
 * compatibility declaration, ports, and projections that the actor uses, so
 * there is one definition of each. The Cloudflare host lives behind the
 * `./cloudflare` subpath because `tardie/cloudflare` needs the Workers
 * runtime; this entry loads on Bun and Node.
 */

export {
  type ElizaActor,
  type ElizaActorOptions,
  type ElizaMessageInput,
  ElizaMessageMethodInput,
  ElizaTurnServices,
  elizaActor,
  elizaMessageMethod,
  elizaTurnComponent,
  TARDIGRADE_OWNER_INSTANCE_MISMATCH,
  TARDIGRADE_OWNER_MISMATCH,
  TARDIGRADE_OWNER_REQUIRED,
  TARDIGRADE_THREAD_UNBOUND,
} from "./actor";
export {
  assertTardigradeCompatible,
  type DeclaredPlugin,
  declarePlugin,
  effectPolicyOf,
  pluginCompatibilityErrors,
  TARDIGRADE_PLUGIN_DECLARATION_INVALID,
  TARDIGRADE_PLUGIN_INCOMPATIBLE,
  type TardigradeHostCapabilities,
  type TardigradePluginCompatibility,
} from "./compatibility";
export {
  createJournaledDeliveryCallback,
  type DeliveryContent,
  type DeliveryPort,
  type DeliveryReceipt,
  deliveryContentOf,
  replyControlTokenMarker,
  TARDIGRADE_REPLY_CONTROL_TOKENS,
  turnOutputDelivery,
} from "./delivery";
export {
  durablePlugin,
  TARDIGRADE_ATTEMPT_OPTION,
  TARDIGRADE_OPERATION_ID_OPTION,
} from "./durable-plugin";
export * from "./events";
export {
  type HistoryState,
  historyBefore,
  historyFromLog,
  initialHistory,
  reduceHistory,
  type TurnHistoryEntry,
} from "./history";
export {
  createElizaBunHost,
  type ElizaBunHost,
  type ElizaBunHostOptions,
} from "./hosts/bun";
export {
  DEFAULT_ELIZA_TARDIGRADE_CHARACTER,
  type ElizaTurnServicesLayerOptions,
  elizaTurnServicesLayer,
} from "./hosts/config";
export {
  type BoundaryExecutionContext,
  type BoundaryOutcome,
  type BoundaryRecord,
  type BoundaryRecorder,
  type BoundaryRecorderOptions,
  type BoundaryRecorderStats,
  type BoundaryRequest,
  createBoundaryRecorder,
  digestValue,
  initialJournal,
  type JournalState,
  journalFromLog,
  journalOf,
  type ReplayDivergence,
  reduceJournal,
  roundtripJson,
  TARDIGRADE_EFFECT_OUTCOME_UNKNOWN,
  type TurnJournal,
} from "./journal";
export {
  createJournaledModelPlugin,
  type ElizaModelPort,
  JOURNALED_MODEL_TYPES,
  type JournaledModelPluginOptions,
  type ModelPortRequest,
  type ModelPortResult,
  type ModelPortToolCall,
  type ModelPortUsage,
  modelPortRequest,
  modelRequestFingerprint,
} from "./model";
export {
  createOpenAICompatibleModelPort,
  type OpenAICompatibleModelPortOptions,
  openAICompatibleModelPortFromEnv,
  TARDIGRADE_MODEL_MESSAGE_UNSUPPORTED,
  TARDIGRADE_MODEL_RESPONSE_INVALID,
  TARDIGRADE_MODEL_TRANSPORT_FAILED,
  wireMessages,
} from "./providers/openai";
export {
  attachTaskJournal,
  ElizaTickInput,
  ElizaTickOutput,
  initialTaskJournal,
  reduceTaskJournal,
  runDueTasksMethod,
  type TardigradeTaskWorker,
  type TaskJournalAttachment,
  type TaskJournalOptions,
  type TaskJournalState,
  tasksOf,
  taskWorkerPolicy,
} from "./scheduling";
export {
  KV_TODOS_COMPATIBILITY,
  KV_TODOS_KEY,
  kvTodoStore,
} from "./stores/kv-todos";
export { type MemoryTodoStore, memoryTodoStore } from "./stores/memory-todos";
export {
  type ElizaTickOutcome,
  type ElizaTickRequest,
  type ElizaTurnCharacter,
  type ElizaTurnConfig,
  type ElizaTurnOutcome,
  type ElizaTurnRequest,
  elizaAgentId,
  elizaAssistantMemoryId,
  elizaPrincipalEntityId,
  elizaRoomId,
  elizaUserMemoryId,
  elizaWorldId,
  runElizaTick,
  runElizaTurn,
  TARDIGRADE_TURN_MODEL_FAILED,
  TARDIGRADE_TURN_NO_REPLY,
  TARDIGRADE_TURN_REPLY_INVALID,
} from "./turn";
