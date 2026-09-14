# Access for elizaOS

Aiko delegates websites and reusable harnesses to Access on Tardigrade. This
plugin owns the application boundary: authenticated routes, operation actions,
private committed context, and contributions to the existing scheduler.

Configure `ACCESS_REMOTE_URL` on the server. `https://access.unbrowse.ai`
automatically selects hosted user sessions; use `ACCESS_AUTH_MODE=hosted` for
another hosted deployment. The host's `connector_credential_store` keeps each
person's generated Access login, recovery code, remote owner binding and session
encrypted in the existing vault. Configure the host vault's OS keychain or
`ELIZA_VAULT_PASSPHRASE` and preserve its durable storage across restarts.

For a Bun Access server, use `ACCESS_AUTH_MODE=owner-token` and
`ACCESS_OWNER_TOKEN_SECRET`. The backend must verify that secret with issuer
`aiko` and audience `access`. Never expose signing keys or hosted sessions in
the Mini App, or configure a single bearer that represents every owner.

Load this plugin alongside `@elizaos/plugin-scheduling`. Existing
personal-assistant production scheduling dependencies provide Telegram channel
delivery. The plugin adds no Telegram client, timer, inference loop, browser,
or credential vault. Missing configuration fails explicitly.

## Application surface

With the Telegram plugin loaded, `/start` or any private message automatically
creates or reuses the sender's private Access workspace. There is no separate
Access signup. The connector emits `TELEGRAM_USER_ACTIVITY` with its resolved
sender identity. Hosted mode deliberately registers a random private username
and password on first contact, after verifying that the encrypted login was
persisted. Subsequent requests reuse that person's session; expiry or an explicit
401 renews it with the saved password. Concurrent requests serialize per owner.
The mapping includes the Access origin and agent identity, so neither can borrow
another deployment's credentials. Bun mode signs an owner-scoped SDK request and
enrolls the owner's durable context task. After restart, both modes reopen the same remote owner. A failed
request is reported and retried on later activity. This creates no website
account and grants no chat, Mini App, or administrator permissions: the existing
Telegram pairing policy and HTTP authorization still apply.

A lost registration response retries the already-staged registration. Only its
409 conflict can resolve through login with the saved password. Failed login for
an established account never creates a replacement. Throttled authentication is
paused for ten minutes, including across restarts. A recovery code whose response
was lost cannot be retrieved again, but the password committed before registration
still permits login. Vault read/write failures stop authentication.

Hosted mode supports the account and credential SDK routes. Its native Tardigrade
threads are the hosted execution surface; the Bun-only context, operation and
browser-handoff projections listed below are not exposed by that deployment.
Accordingly this plugin does not start the Bun context poller in hosted mode;
the context provider explicitly reports that projection as unavailable.

The plugin is named `access`; core's standard route prefix yields `/access`.
Use the existing authenticated Eliza HTTP transport with that base URL. The
routes mirror `access/client`:

- `GET/POST /access/accounts`, `PATCH/DELETE /access/accounts/:accountId`
- `GET /access/accounts/:accountId/connection`
- `GET /access/accounts/:accountId/browser/handoffs/:handoffId/frame`
- `POST /access/accounts/:accountId/browser/handoffs/:handoffId/actions`
- `POST /access/accounts/:accountId/browser/handoffs/:handoffId/resume`
- `GET/POST /access/accounts/:accountId/credentials/pending`
- `POST /access/accounts/:accountId/operations`
- `POST /access/accounts/:accountId/approvals/:approvalId`
- `GET /access/accounts/:accountId/workflows`
- `GET /access/context`, `GET /access/events?after=<cursor>`

Every route requires `RouteHandlerContext.accessContext.requesterEntityId`.
Neither loopback nor an in-process call substitutes for authenticated identity.
Browser handoffs use the shared SDK frame/action/resume contracts. Frames are
private no-store responses and never enter stored context; actions permit only
click, scroll, and the enumerated navigation keys. Arbitrary text and script
execution are rejected before transport.

Credential answers go directly to Access's dedicated credential endpoint. They
are never an action parameter, log field, event payload, or provider result.

`ACCESS_CONNECT`, `ACCESS_REFRESH`, `ACCESS_RUN`, and `ACCESS_SYNTHESIZE` accept
an account ID (and intent except for connect). The immutable triggering message
binds their idempotency key. Access still validates effect authority and owns
approvals, execution, and receipts. An accepted operation is reported as queued
or running, never falsely as completed work.

## Proactivity and durable context

Telegram activity or the first account request creates an owner-specific durable core task.
`ACCESS_EVENT_DRAIN` runs under the existing TaskService, using its retry and
backoff policy. The task retains the complete local context, cursor, event IDs,
and pending delivery metadata. The provider reads only this committed state;
it never fetches or browses while composing a prompt.

Each drain first refreshes authoritative account membership and ready context.
Revoked accounts lose their local evidence and pending deliveries; an unavailable
snapshot preserves state and pauses delivery. Complete active-account history
remains intact. Processing commits complete evidence before matching watcher definitions. It
then evaluates each owner-bound watcher intent through the existing runtime
`TEXT_SMALL` model, with complete committed context and event evidence marked
as untrusted observations. Only strict JSON relevance decisions are accepted;
missing models, invalid decisions, and model failures leave the event pending
and surface an unavailable state through TaskService. Unrelated events stay
silent. The exact matched watcher IDs persist before invoking the ScheduledTask
runner, so a delivery retry does not call the relevance model again. Only
after that records the consumed cursor. Restart retries the same occurrence.
Each event/watcher pair uses the runner's durable idempotency key; other owners'
watchers cannot match. The existing runner owns gates, global pause, escalation,
typed `DispatchResult`, and connector delivery. Watchers use the existing
`quiet_hours` and `model_moment_check` gates; a relevant event is a notification
candidate, and those gates still decide whether and when to interrupt. A
deferred occurrence stays with the existing runner clock, with its full event
evidence persisted across restart. Account reconciliation dismisses outstanding
owner-bound deferred occurrences for revoked websites through the runner's
existing lifecycle operation.

Create an event watcher with authenticated
`POST /access/accounts/:accountId/watchers` and
`{ "id": "<uuid>", "intent": "Tell me when a relevant order changes", "channelKey": "telegram" }`.
Creation resolves the authenticated owner's canonical direct Telegram room
through scheduling's shared delivery-binding API. A missing or ambiguous room
is an explicit error; `roomId` may select among canonical owner rooms, but
cannot grant access to another owner's room. The existing dispatcher revalidates
room membership and bot account immediately before sending.

It creates a standing watcher definition; each event gets a separate durable
scheduled occurrence. Edit or dismiss it through the existing ScheduledTask
surface. A fired occurrence without a persisted typed delivery result remains
an explicit uncertain-delivery failure; the plugin never blindly resends it.

For a website without push support, use authenticated
`POST /access/accounts/:accountId/polls` with
`{ "id": "<uuid>", "intent": "Check current order status", "everyMinutes": 30 }`.
This creates a normal ScheduledTask interval using the contributed
`access_refresh` channel. That channel submits only a read refresh to Access;
a separate authorized event watcher decides whether to notify the owner.

## Verification

Run `bun run --cwd plugins/plugin-access build`, `test`, `typecheck`, and `lint` with the
repository-pinned Bun and Node versions. The behavioral oracle prints
`access plugin verification passed` only after the service, route, owner,
restart, replay, and scheduling integration checks pass. Remote native/browser
and Telegram delivery evidence belongs to the integration gate in the parent
campaign; local service tests are not that live proof.

The focused test harness uses the real runtime service lifecycle, HTTP SDK,
TaskService, scheduling runner, owner room lookup, and route handlers. Task and
scheduled-row persistence boundaries are deterministic adapters; these tests
exercise restart recovery without claiming a deployed database or Telegram send.

The joined native push test starts Access in its own Bun 1.4+ process, preserving
its actor/host runtime identity, and exercises the HTTP SDK through the production
scheduled Telegram dispatcher. Run it from the repository root:

```bash
bunx vitest run --config packages/scripts/vitest/integration.config.ts plugins/plugin-access/test/native-push.integration.test.ts
```

The test finds a compatible native Bun on `PATH`; set `ACCESS_NATIVE_TEST_BUN`
when that executable lives elsewhere. Website responses and model decisions are
fixtures, and the final Telegram send is a test sink. Native encrypted state is
reopened from disk; Aiko task/store adapters are retained across coordinator
restart. The test proves complete evidence ordering, owner isolation and duplicate
suppression across that boundary, without claiming a live Telegram receipt.

Reconciliation cancels scheduled deliveries once it observes website revocation.
The canonical chat binding checks Telegram room membership and bot account;
it does not atomically fence a website revocation against a connector dispatch
that was already claimed. That final in-flight race requires native delivery
authority support beyond this plugin's reconciliation boundary.
