# `@elizaos/tardigrade`

Tardigrade host adapter for elizaOS. Read `README.md` for the ownership
boundaries, the durable-boundary contract, the compatibility declaration, and
the run/deploy flow. Repository-wide rules are inherited from the root
[`CLAUDE.md`](../../CLAUDE.md).

## Layout

- `src/events.ts`, `src/journal.ts` — durable event alphabet, dedup keys, the
  boundary recorder and its replay/unknown-outcome policy.
- `src/compatibility.ts`, `src/durable-plugin.ts` — plugin declarations, host
  validation, effect-policy classification, journaled action handlers.
- `src/model.ts`, `src/delivery.ts`, `src/providers/openai.ts` — model and
  delivery ports and the fetch-based OpenAI-compatible port.
- `src/turn.ts`, `src/scheduling.ts`, `src/history.ts` — the ephemeral
  runtime, the turn and tick runners, task and history projections.
- `src/actor.ts`, `src/hosts/*`, `actor.ts`, `worker.ts`, `server.ts` — the
  Tardigrade actor and the Bun and Cloudflare hosts.
- `tests/` — Bun tests on the real runtime and real hosts; `scripts/` — the
  recovery child, the `tdg` wrapper, and the smoke, journey, perf, deploy, and
  evidence drivers.

## Hard rules

- **Eliza keeps the decision loop.** The actor runs the canonical
  `messageService.handleMessage` on an ephemeral edge `AgentRuntime`; it never
  adopts Tardigrade's native `infer` loop for the same turn.
- **Every external effect is a keyed, recorded boundary.** Model calls, action
  handlers, deliveries, and owned task workers record `ElizaBoundaryStarted`
  before execution and `ElizaBoundaryRecorded` after, through the thread's
  `EventLog`. Replay reads the record; it never re-executes a recorded effect.
- **Unknown outcomes fail explicitly.** A boundary that started without a
  record is retried only under a declared `read` or `idempotent` policy; an
  `unsafe` effect ends the turn with a typed `ElizaError`.
- **No compaction.** Model-facing history is projected complete from the log.
  Do not add Tardigrade's `compaction()` component or any cap.
- **Domain data is host-owned.** Todo, task, and connector stores are injected
  ports; the event log is execution history, not a database adapter.
- **Tests use the real runtime.** Bun tests construct genuine `AgentRuntime`
  turns and real Tardigrade hosts; only the model port and external stores are
  deterministic fakes. Keep `tardie` pinned; its Bun floor exceeds the
  repository pin.
