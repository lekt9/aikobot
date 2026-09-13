# `@elizaos/tardigrade`

elizaOS on [Tardigrade](https://github.com/clavia-labs/tardigrade): a
durable-execution host adapter. A Tardigrade actor runs the existing edge
`AgentRuntime` turn — Eliza's own decision loop, plugins, providers, actions,
and evaluators — while every external effect of the turn is a keyed, recorded
boundary in the thread's event log. A crashed host recovers the turn from that
log without paying for a second model call or repeating a side effect whose
outcome is known.

The feasibility assessment that preceded this package is in
[`docs/assessment.md`](docs/assessment.md).

## Ownership

| Concern | Owner |
| --- | --- |
| Thread execution, accepted calls, pending work, recorded results, cancellation, resumption, alarms | Tardigrade (`tardie`) |
| Plugin contracts, character, the message pipeline, role gates, `TaskService` semantics | elizaOS (`@elizaos/core/edge` and declared plugins) |
| Model, delivery, and domain stores (todos, tasks) | The host, injected as ports |
| Journaled boundaries, replay, compatibility validation, owner binding, task projection | This package |

The event log is durable execution history. It is not a database adapter:
todo rows live in the thread workspace key-value store the hosts provide,
scheduled-task rows are projected from `ElizaTaskUpserted`/`ElizaTaskDeleted`
events into each ephemeral runtime, and conversation history is projected
complete from the thread's messages and terminals.

## Durable boundaries

Every model call, action handler, delivery, and task-worker execution runs
through `createBoundaryRecorder` (`src/journal.ts`):

1. `ElizaBoundaryStarted` is appended through the thread `EventLog` before the
   effect runs. It carries the stable key `turn/epoch/kind/ordinal`, the
   operation id handed to the effect, the declared retry policy, and the
   input digest.
2. The effect runs. Its JSON representation is what the pipeline receives,
   live or replayed.
3. `ElizaBoundaryRecorded` is appended with the outcome (`returned` with the
   result, or `failed` with the error).

On recovery the transition re-derives from the log: a recorded boundary
replays without executing; a started-but-unrecorded boundary is an explicit
unknown outcome, retried only under a `read` or `idempotent` policy (with the
original operation id, which a store like todos uses as its idempotency key);
an `unsafe` effect ends the turn with `TARDIGRADE_EFFECT_OUTCOME_UNKNOWN`. A
recorded model boundary whose structural request (model type, tools, tool
choice, transcript shape) differs on replay appends `ElizaReplayDiverged`;
prompt text legitimately includes host-clock providers and is not part of the
identity.

Policies come from the compatibility declaration (`src/compatibility.ts`):
`effect:idempotent` tags are idempotent, `capability:read` and read-only
effect classes are reads, other effectful capabilities are unsafe, and the
declaration may override by action name. A plugin joins the actor only through
`declarePlugin`, and `assertTardigradeCompatible` refuses a composition whose
bindings, secrets, or HTTP routes the host cannot honor.

## Actor

`elizaActor({ name })` (`src/actor.ts`) is a Tardigrade actor with two methods:

- `message` — Tardigrade's generic agent message method. Input
  `{ text, input: { owner, sender?, source? } }`. The first message binds the
  thread to `owner` (`ElizaThreadBound`); a message naming another owner
  fails with `TurnFailed`. The owner is the ephemeral world's OWNER; a
  different `sender` is admitted as GUEST, which is what role-gated actions
  evaluate against.
- `runDueTasks` — the host wakeup. Input `{ owner }`. Builds the runtime in
  serverless mode, seeds the projected task rows, and calls core
  `TaskService.runDueTasks()`; worker executions are `task` boundaries.

Turns and ticks on one thread execute serially in arrival order. The
component's state is a pure projection of the log (history, journal, task
table, binding, pending work), so a recovered host derives the same owed
transition.

## Hosts

- **Bun** (`server.ts`, `src/hosts/bun.ts`): SQLite-backed threads.
  `bun run dev` loads `.dev.vars` and serves the Tardigrade HTTP API.
- **Cloudflare Workers** (`worker.ts`, `src/hosts/cloudflare.ts`,
  `wrangler.jsonc`): each thread is a SQLite-backed Durable Object; alarms
  resume unfinished work. Core's edge entry and the edge plugins bundle from
  source through the `alias` block.

Both hosts receive `ElizaTurnServices` from `elizaTurnServicesLayer`
(`src/hosts/config.ts`): the fetch-based OpenAI-compatible model port
(`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ELIZA_TARDIGRADE_MODEL`,
`ELIZA_TARDIGRADE_MODEL_PROVIDER`, and `ELIZA_TARDIGRADE_REASONING_EFFORT`,
which reasoning gateways such as Codegraff's `deepseek-flash` need set to
`none` before they accept `tool_choice: "required"`), the todos plugin over
the thread workspace key-value store, and public web search. The Worker also
answers `GET /` with a public identity document (product, actor, methods,
model) for operators and release probes; every other route is Tardigrade's.

`.dev.vars.example` lists every variable both hosts read; `worker.ts` also
reads Tardigrade's own `TARDIGRADE_*` bindings from `wrangler.jsonc`. Import
the package from `@elizaos/tardigrade` on Bun or Node and from
`@elizaos/tardigrade/cloudflare` inside a Worker; the Cloudflare host needs
the `cloudflare:workers` runtime module and is kept off the main entry.

```bash
bun run dev                                   # Bun host on :4242
tdg thread create --name main --actor owner-1 --token "$TARDIGRADE_TOKEN"
tdg call message '{"text":"add buy milk to my list","input":{"owner":"owner-1"}}' \
  --thread main --actor owner-1 --token "$TARDIGRADE_TOKEN"
tdg call runDueTasks '{"owner":"owner-1"}' --thread main --actor owner-1 --token "$TARDIGRADE_TOKEN"
tdg events main --actor owner-1 --token "$TARDIGRADE_TOKEN"
```

Deploy: create the D1 catalog database once (`bunx wrangler d1 create
eliza-tardigrade-catalog`, copy its id into `wrangler.jsonc`, apply
`migrations/`), then `bun run deploy:cloudflare`, which deploys, pushes the two
secrets from `.dev.vars`, and records the URL for `bun run smoke:deployed`.

## Evidence

Each prototype item from the assessment has a test on the real runtime and a
real Tardigrade host; the model, delivery, and stores are deterministic fakes.

| Item | Proof |
| --- | --- |
| Read and state-changing actions through supported plugins | `tests/turn.test.ts` (`WEB_SEARCH`, `TODO`), `tests/actor.test.ts` |
| Restart recovery after an effect succeeded but before its record committed | `tests/recovery.test.ts` (real `SIGKILL`, fresh host, one todo, one delivery) |
| Duplicate inbound delivery and repeated operations | `tests/idempotency.test.ts` |
| Owner isolation and authorization failures | `tests/authorization.test.ts` |
| Complete context; providers, actions, evaluators live | `tests/context.test.ts` |
| Built actor under workerd and a deployed Worker with inspected traces | `bun run build:actor`, `bun run smoke:workerd`, `bun run smoke:deployed` (evidence under `.tardigrade/`) |
| Cross-layer release journey on the deployed Worker | `bun scripts/journey.mjs` (bearer login and its failure branches, create and read-back, durable trace read-back, refused foreign owner); `bun scripts/perf.mjs` reports turn latency from a recorded trace |
| Serverless scheduling through core `TaskService` | `tests/scheduling.test.ts` |

`bun run test`, `bun run typecheck`, `bun run lint:check`, and `bun run
lint:actor` are the package gates. `tdg` runs through `scripts/tdg.mjs`, which
gives it a package-owned temp directory, and `scripts/evidence.mjs` assembles
the release-gate manifest from the recorded traces and independent reviews.

## Failure policy

Every boundary failure is recorded. A turn whose model boundary failed does
not complete: Eliza would answer a provider failure with a generated apology
and report the turn as delivered, but under durable execution that apology
can follow an action that already committed, so the adapter records the
delivery and ends the turn as `TurnFailed` with the boundary's error
(`TARDIGRADE_TURN_MODEL_FAILED`). The durable trace then shows both the
committed effect and why the reply is untrustworthy, and the caller's
`tdg call` exits non-zero instead of reading an apology as success.

A reply that is provider control-token markup rather than prose (`<|…|>`,
`<｜…｜>`, DeepSeek's `<｜｜DSML｜｜ …>` tool markup emitted as text) is refused
at the delivery boundary: the port never sends it, the refusal is journaled as
a failed delivery, and the turn ends `TurnFailed` with
`TARDIGRADE_TURN_REPLY_INVALID` carrying the action results that did commit.

Owner claims are bound twice: a message's `input.owner` must equal the actor
instance the host allocated the thread under
(`TARDIGRADE_OWNER_INSTANCE_MISMATCH`), and the first admitted message binds
the thread for its whole life (`TARDIGRADE_OWNER_MISMATCH`). Per-principal
authentication is the deploying host's responsibility: Tardigrade's HTTP
surface authenticates one bearer token, so a deployment that serves several
owners must front it with its own identity layer and allocate one actor
instance per authenticated owner.

## Constraints

- `tardie` requires Bun 1.4 or later; the repository's pinned Bun is older, so
  this package's tests run on the machine's Bun and are not yet in the root
  test lanes' CI matrix.
- No compaction. History is projected complete; a genuine provider context
  limit surfaces as a typed model error, never as a silent window.
- Plugin HTTP routes are refused; Tardigrade serves no plugin HTTP surface.
- Streaming is not exposed: the journaled model plugin records complete
  responses.
- `deepseek-flash` through Codegraff occasionally answers a tool-less call
  with its raw DSML tool markup as prose. The adapter refuses that reply and
  fails the turn (see Failure policy); `scripts/journey.mjs` treats the
  failed read-back as a repeated request and issues one fresh call before
  reporting failure.
- Host wakeups are external: call `runDueTasks` from a scheduler; the Worker
  does not register a cron trigger.
- `tdg build` validates and bundles the actor as Tardigrade's portable
  artifact (`.tardigrade/build/eliza`); the deployed Worker is bundled by
  wrangler from the same sources through `worker.ts`. The two are built from
  one definition but are not the same bytes.
- `tdg ls` against the Cloudflare host fails inside `tardie` 0.25.0
  (`Unreadable Exchange: Missing key at [0]["events"]`): the Worker's thread
  listing omits the `events` field the CLI decodes. `tdg events <thread>` and
  `tdg call ... state` work. Restart recovery, duplicate delivery, and
  scheduling are proven on the Bun host; on Cloudflare they rest on the same
  actor definition and Tardigrade's Durable Object host.
