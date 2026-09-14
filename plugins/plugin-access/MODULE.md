# Access integration

Owns: this plugin's authenticated BFF routes, Access remote client service, local
owner context provider, operation actions, and contributions to the existing scheduler.

The remote SDK owns wire validation and Access owns execution. Authenticated
requester entity IDs select the owner; body fields never do. Password submission
is only a BFF route, never an action or event. TaskService drives the durable
owner drain task. Context commits before strict runtime-model relevance
evaluation, durable watcher matching, and cursor advancement. Model failures
remain pending; quiet-hours and moment judgment belong to scheduling gates.
Scheduling supplies the canonical owner chat binding; missing or
ambiguous Telegram destinations fail before scheduling. ScheduledTask owns
watcher gates and connector delivery; this plugin sends no
Telegram messages and creates no timer or inference loop.

Read `README.md` for host configuration and the route/metadata contracts.
Verify with `bun run --cwd plugins/plugin-access test`, `typecheck`, and `lint`.
