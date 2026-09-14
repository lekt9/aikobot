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
  type Authenticate,
  type AuthenticatedOwner,
  bearerOf,
  createOwnerTokenIssuer,
  createOwnerTokenVerifier,
  type OwnerIdentity,
  type OwnerTokenEnv,
  type OwnerTokenOptions,
  ownerTokenAuthenticate,
  TARDIGRADE_OWNER_TOKEN_CONFIG,
} from "./hosts/auth";
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
  ElizaOwner,
  instanceName,
  instanceOwner,
  isScopedInstance,
  isScopedObject,
  objectOwner,
  ownerOfInstance,
  scopedNamespace,
  TARDIGRADE_FOREIGN_OWNER,
  TARDIGRADE_INSTANCE_UNSCOPED,
  TARDIGRADE_OWNER_INVALID,
  userInstance,
  validateOwner,
} from "./hosts/identity";
export {
  type DurableSqlStorage,
  durableObjectBackend,
} from "./hosts/storage";
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
  ACCESS_COMPATIBILITY,
  ACCESS_SCHEDULING_COMPATIBILITY,
  type AccessOwnerOptions,
  accessCharacter,
  accessOptionsFromEnv,
  accessOwnerPlugins,
  TARDIGRADE_ACCESS_CONFIG,
} from "./native/access";
export {
  DEFAULT_NATIVE_BUDGET,
  DEFAULT_NATIVE_CALL_TIMEOUT_MS,
  type ElizaNativeActor,
  type ElizaNativeActorOptions,
  type ElizaNativeServices,
  elizaNativeActor,
  type MountedElizaNativeActor,
  NEVER_SPILL_BYTES,
} from "./native/actor";
export {
  characterComponent,
  characterInstructions,
} from "./native/character";
export {
  ELIZA_CONTEXT_TAG,
  type ElizaContextOptions,
  elizaContextComponent,
  elizaEvidenceFirst,
  LOSSLESS_RENDER_CAP,
  losslessContext,
  transitionTag,
} from "./native/context";
export {
  ELIZA_EVALUATE_TAG,
  type ElizaEvaluatorOptions,
  elizaEvaluatorComponent,
} from "./native/evaluators";
export {
  ELIZA_CONTEXT_PREFIX,
  ELIZA_EVALUATE_PREFIX,
  elizaContextComposed,
  elizaContextFailed,
  elizaContextKeys,
  elizaEvaluated,
  elizaEvaluateKeys,
  elizaEvaluationFailed,
} from "./native/events";
export {
  actionCompatibilityIndex,
  actionKindOf,
  type NativeActionInput,
  type NativeActionOutput,
  type NativeContextInput,
  type NativeContextOutput,
  type NativeEvaluateInput,
  type NativeEvaluateOutput,
  type NativeExecutorOptions,
  type NativeTurnRef,
  nativeExecutors,
  TARDIGRADE_ACTION_POLICY_MISMATCH,
  TARDIGRADE_ACTION_UNKNOWN,
  TARDIGRADE_ACTION_VALIDATION_REFUSED,
  TARDIGRADE_EVALUATOR_SERVICE_MISSING,
  TARDIGRADE_ROLE_REFUSED,
} from "./native/executor";
export {
  type NativeOwnerBuild,
  type NativeOwnerConfig,
  nativeDeclarationPlugins,
  nativeOwnerBuild,
  nativeOwnerPlugins,
  TARDIGRADE_DECLARATION_ONLY,
} from "./native/owner";
export {
  currentTurnRef,
  type ElizaPackageOptions,
  type ElizaPackageServices,
  elizaPackage,
  elizaPackages,
  methodNameOf,
  packageNameOf,
  TARDIGRADE_PACKAGE_METHOD_COLLISION,
  TARDIGRADE_TURN_UNKNOWN,
} from "./native/packages";
export {
  type DueSummary,
  dueSummaryOf,
  ELIZA_TICK_PREFIX,
  ELIZA_TICK_TAG,
  ELIZA_WAKE_METHODS,
  ELIZA_WAKE_PREFIX,
  type ElizaTaskComponentOptions,
  type ElizaTickCompletedFields,
  type ElizaTickFailedFields,
  type ElizaWakeArmedFields,
  ElizaWakeInput,
  ElizaWakeOutput,
  elizaTaskComponent,
  elizaTickCompleted,
  elizaTickFailed,
  elizaTickKeys,
  elizaWakeArmed,
  elizaWakeMethod,
  IDLE_WAKE_MS,
  MAX_WAKE_MS,
  MIN_WAKE_MS,
  selfAddressOf,
  TARDIGRADE_TASK_SERVICE_MISSING,
  tickExecutor,
} from "./native/tasks";
export {
  CHUNK_SIZE,
  chunkedSqlBackend,
  memoryBackend,
  type SqlRunner,
  type StateBackend,
} from "./owner/backend";
export {
  type BunOwnerRegistry,
  type BunOwnerRegistryOptions,
  bunOwnerRegistry,
} from "./owner/bun";
export {
  DurableElizaDatabaseAdapter,
  OWNER_ADAPTER_KEY,
  TARDIGRADE_STATE_SCHEMA,
} from "./owner/durable-adapter";
export {
  type OwnerInvocation,
  type OwnerInvocationOutcome,
  type OwnerInvocationResult,
  type OwnerObjectNamespace,
  type OwnerObjectStub,
  OwnerRuntimePort,
  type OwnerRuntimePortService,
  ownerObjectPort,
  TARDIGRADE_INVOCATION_FAILED,
  TARDIGRADE_INVOCATION_KEY_REUSED,
  TARDIGRADE_INVOCATION_UNKNOWN_KIND,
} from "./owner/port";
export {
  createOwnerRuntime,
  invocationSignature,
  type OwnerEffectPolicy,
  type OwnerExecutor,
  type OwnerExecutorContext,
  type OwnerExecutorOutput,
  type OwnerReceipt,
  type OwnerRuntime,
  type OwnerRuntimeOptions,
  RECEIPT_PREFIX,
  receiptKey,
} from "./owner/runtime";
export {
  type SqliteBackend,
  sqliteBackend,
} from "./owner/sqlite-backend";
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
  documentTodoStore,
  reviveTodoSeed,
  type TodoDocument,
} from "./stores/document-todos";
export {
  KV_TODOS_COMPATIBILITY,
  KV_TODOS_KEY,
  kvTodoStore,
} from "./stores/kv-todos";
export { type MemoryTodoStore, memoryTodoStore } from "./stores/memory-todos";
export {
  OWNER_TODOS_COMPATIBILITY,
  OWNER_TODOS_KEY,
  ownerTodoStore,
} from "./stores/owner-todos";
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
