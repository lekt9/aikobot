# Feasibility assessment (September 13, 2026)

This is the assessment that preceded the adapter in this package, kept verbatim except for links rewritten to resolve from this directory. The implementation it recommends now exists here; see [`../README.md`](../README.md) for what was built and how each prototype item is proven.

---

# Tardiza: elizaOS on Tardigrade

An elizaOS–Tardigrade adapter makes sense, and a scoped version looks viable.
Its strongest value would be durable execution, recovery, and inspectable runs.

This is a feasibility assessment based on repository source inspection and
current platform documentation on September 13, 2026. No adapter was built or
deployed for this assessment. The viability ratings below are engineering
judgments, not deployment results.

## Existing implementation

This checkout already has an edge runtime:

- [Core's edge entry](../../../packages/core/src/index.edge.ts) exports `AgentRuntime`.
- [The shared runtime](../../../packages/cloud/shared/src/lib/services/shared-runtime/shared-eliza-runtime.ts)
  constructs that runtime with selected web-search, reminder, and todo plugins.
  Its implementation projects Durable Object history into an ephemeral runtime
  for a turn and returns the resulting conversation pair for durable commit.
- [The runtime contract](../../../packages/core/src/types/runtime.ts) exposes a
  `serverless` mode. [TaskService](../../../packages/core/src/services/task.ts) uses it to
  avoid starting a permanent timer and lets the host call `runDueTasks()`.
- [The remote-plugin adapter](../../../packages/agent/src/services/remote-plugin-adapter.ts)
  mirrors remote plugin capabilities through the existing capability protocol.

Cloudflare support therefore has an existing implementation to build on.
Tardigrade would add execution and recovery capabilities; it is not required
merely to make selected elizaOS functionality run on Cloudflare. These source
paths do not establish the deployment status or compatibility of every plugin.

## Viability by scope

| Scope | Viability | Main work |
| --- | --- | --- |
| Host the existing edge runtime through Tardigrade | High | Lifecycle, durable inputs/results, recovery boundaries |
| Run selected elizaOS plugins inside a native Tardigrade loop | High, with explicit compatibility requirements | Runtime services, action validation, provider context, evaluator behavior |
| Preserve complete elizaOS core behavior with recovery between individual operations | Medium | Integrate checkpoints throughout the existing pipeline |
| Run every plugin unchanged inside Workers | Low | Native binaries, process spawning, persistent local files, and service lifecycle assumptions |

## Proposed ownership

Tardigrade would own thread execution: accepted requests, pending work, recorded
results, cancellation, and resumption. Its Cloudflare host places each thread in
a SQLite-backed Durable Object and resumes unfinished work through alarms. See
the [Tardigrade Cloudflare guide](https://github.com/clavia-labs/tardigrade/blob/main/docs/platforms/cloudflare.mdx).

elizaOS would retain its plugin contracts, character configuration,
authorization, domain services, and memory APIs. The adapter would connect
those contracts to the execution host.

A Tardigrade event log does not automatically implement elizaOS's database
interface. Entities, relationships, memory search, and cross-conversation state
still need their storage contracts. Durable execution history and domain data
must have explicit ownership and consistent recovery behavior.

For scheduling, retain the existing elizaOS scheduled-item architecture and
TaskService contract. Host wakeups should drive that contract rather than
introduce a competing domain scheduler.

Plugins requiring a full operating system could run on a suitable remote host
through the existing remote-plugin capability protocol. Workers' Node
compatibility includes working APIs and import-only stubs; `child_process`, for
example, remains nonfunctional. Its filesystem also has different persistence
semantics. See Cloudflare's [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
and [filesystem documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

## Recovery is the central engineering problem

Wrapping an entire Eliza turn in one Tardigrade effect would provide a useful
initial integration, but it would not make each internal operation independently
resumable.

For example:

1. A plugin successfully creates a calendar event.
2. The Worker stops before recording the result.
3. Recovery retries the unfinished operation.

Preventing a duplicate requires a stable operation ID, downstream idempotency
or reconciliation, and durable evidence of the outcome. Tardigrade records
completed results and retries unfinished work; the adapter must account for
that external-effect boundary. A durable log alone does not guarantee
exactly-once effects in another system. See the
[Tardigrade execution lifecycle](https://github.com/clavia-labs/tardigrade/blob/main/docs/getting-started/quickstart.mdx).

The adapter must also preserve two broader contracts:

- Plugins receive a broad `IAgentRuntime`. An action-to-tool converter alone
  cannot reproduce its services, permissions, callbacks, and evaluator pipeline.
  Compatibility should be declared and validated; unsupported runtime
  requirements should fail explicitly.
- This repository prohibits context compaction. The integration must preserve
  complete model-facing content and omit the Tardigrade skill example's
  `compaction()` component. A real external context limit must produce an
  explicit error or another repository-approved lossless contract.

## Recommended starting point

Start with the existing edge runtime and a declared set of supported plugins.
Preserve Eliza's decision loop initially, then introduce durable boundaries
around model calls, actions, and delivery. Keep replay-derived state pure and
execute external work through recorded, keyed effects.

If the project later adopts Tardigrade's native inference loop, treat that as an
explicit behavioral migration. Providers, action selection, evaluators, and
response handling need comparison against the existing Eliza pipeline. Avoid
giving two independent loops authority over the same turn.

The decisive prototype should exercise:

1. A real read action and a real state-changing action through supported plugins.
2. Restart recovery, including interruption after an external effect succeeds
   but before its result is committed.
3. Duplicate inbound delivery and repeated operation requests.
4. Owner isolation and authorization failures.
5. Complete context and preserved action/provider/evaluator behavior.
6. The built actor in Workerd and a deployed Worker, with inspected durable
   traces and external results.

That evidence would establish whether the adapter preserves useful behavior.
The current assessment establishes an architectural starting point; runtime
compatibility, recovery correctness, performance, and deployment remain to be
proven for the adapter.
