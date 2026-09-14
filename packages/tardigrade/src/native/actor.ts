/**
 * The native actor: Tardigrade is the engine and elizaOS is the harness
 * around it. The loop, the log, the projections and the recovery are
 * Tardigrade's `infer` over code mode; elizaOS contributes the character as
 * instructions, its providers as per-turn context, its plugins as packages
 * the model calls from JavaScript, and its evaluators as a post-turn pass.
 * No elizaOS message loop runs inside a turn — there is one loop, and it is
 * the engine's.
 *
 * Two composition rules are load-bearing:
 *
 * - Nothing truncates model-facing content. `losslessContext` lifts the
 *   render caps, the spill threshold is raised past any result, and no
 *   compaction component is mounted; an oversized context must fail at the
 *   provider rather than be silently shortened.
 * - Provider context commits before the first model call. `infer` emits child
 *   effects after inference, so the assembled root is re-sorted by
 *   `elizaEvidenceFirst`, which is what makes a turn see its providers.
 *
 * Packages are declared from plugin metadata at module scope; handlers only
 * ever run in the owner's runtime, reached through `OwnerRuntimePort`.
 */

import type { Character } from "@elizaos/core/edge";
import {
  actor,
  agentMethods,
  budget,
  budgetAuthority,
  caller,
  codeMode,
  infer,
  outputValidateOnce,
} from "tardie";
import { type Actor, calls, handles } from "tardie/core/actor";
import type { DeclaredPlugin } from "../compatibility";
import type { ElizaOwner } from "../hosts/identity";
import type { OwnerRuntimePort } from "../owner/port";
import { characterComponent } from "./character";
import {
  ELIZA_CONTEXT_TAG,
  elizaContextComponent,
  elizaEvidenceFirst,
  losslessContext,
} from "./context";
import { elizaEvaluatorComponent } from "./evaluators";
import { nativeDeclarationPlugins } from "./owner";
import { elizaPackages } from "./packages";
import {
  ELIZA_WAKE_METHODS,
  elizaTaskComponent,
  elizaWakeMethod,
} from "./tasks";

/**
 * No result is ever replaced by a pointer. A spilled value would reach the
 * model as a preview, which this repository treats as compaction.
 */
export const NEVER_SPILL_BYTES = Number.MAX_SAFE_INTEGER;

/** Package calls reach a model-backed elizaOS action; the default 30s is short. */
export const DEFAULT_NATIVE_CALL_TIMEOUT_MS = 240_000;

/** Steps one turn may take before the engine asks the caller for more. */
export const DEFAULT_NATIVE_BUDGET = 40;

export interface ElizaNativeActorOptions {
  readonly name?: string;
  readonly character: Character;
  /** Declaration-only plugins; defaults to the deployment's declared set. */
  readonly plugins?: ReadonlyArray<DeclaredPlugin>;
  /** Provider names to compose per turn; omitted means the runtime's default set. */
  readonly providers?: ReadonlyArray<string>;
  readonly budget?: number;
  readonly callTimeoutMs?: number;
}

export type ElizaNativeActor = ReturnType<typeof elizaNativeActor>;

/** Services every host must supply per thread for the native actor to run. */
export type ElizaNativeServices = ElizaOwner | OwnerRuntimePort;

/** Composes the native actor from a character and a declared plugin set. */
export function elizaNativeActor(options: ElizaNativeActorOptions) {
  const declared = options.plugins ?? nativeDeclarationPlugins();
  const packages = elizaPackages(declared);
  const name = options.name ?? "eliza";
  // The task component both calls the wake method on its own thread and is the
  // component that owns it; the wake is retired by its deadline, which is the
  // whole point, so the declaration is what tells the contract it is covered.
  const tasks = calls(
    { kind: "caller", methods: ELIZA_WAKE_METHODS },
    elizaWakeMethod,
    handles(elizaWakeMethod, elizaTaskComponent()),
  );
  return actor({
    name,
    methods: { ...agentMethods, ...ELIZA_WAKE_METHODS },
    components: [
      elizaEvidenceFirst(
        infer([
          characterComponent(options.character),
          losslessContext(),
          elizaContextComponent(
            options.providers === undefined
              ? {}
              : { providers: options.providers },
          ),
          budget(
            [
              codeMode(packages, {
                policy: {
                  spill: { spillBytes: NEVER_SPILL_BYTES },
                  call: {
                    attemptTimeoutMs:
                      options.callTimeoutMs ?? DEFAULT_NATIVE_CALL_TIMEOUT_MS,
                  },
                },
              }),
            ],
            {
              authority: caller(),
              limit: options.budget ?? DEFAULT_NATIVE_BUDGET,
            },
          ),
          outputValidateOnce,
        ]),
        [ELIZA_CONTEXT_TAG],
      ),
      budgetAuthority(),
      elizaEvaluatorComponent(),
      tasks,
    ],
  });
}

/** The actor type a host mounts, with its service requirements spelled out. */
export type MountedElizaNativeActor = Actor<
  ElizaNativeServices,
  typeof agentMethods
>;
