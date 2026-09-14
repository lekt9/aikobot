# Aiko: responsibility you can hand over

Aiko is your caring, proactive secretary in Telegram. You give her an outcome,
the account access needed to pursue it, and the decisions that require your
judgment. She handles the operating steps through Access by Unbrowse and follows
the work through to a verified result.

## Evidence and scope

This is a product hypothesis derived from the owner's brief, using the
proto-persona, jobs-to-be-done and customer-journey-map skills. There are no
customer interviews or measured retention results behind it yet. The emotions
and adoption assumptions below need validation.

The behavioral instructions are configured in [character.json](character.json).
The host loads that file through its existing character override mechanism.
Instructions alone do not implement monitoring, scheduling, credential UI,
permission enforcement or reliable delivery. Those capabilities must be present
and verified before Aiko promises them. This document describes the intended
experience, not an end-to-end implementation certificate.

## Working persona

**Busy Bea** is a provisional behavioral persona: a person managing work and
personal commitments across several online accounts, already comfortable with
Telegram. When a delivery stalls, a booking changes or an unresolved request
needs chasing, they must switch accounts, reconstruct context and remember the
next check. They currently rely on tabs, messages, reminders and their own
memory. Demographics and occupation are unspecified.

Our hypothesis is that this person will delegate a small real errand before
granting broader responsibility. They need evidence that Aiko follows through,
keeps accounts private and respects their decisions. They may abandon her if
setup or supervising her creates more work than completing the errand directly.

## The job she is hired for

**When an online errand depends on several steps or a later event, take ownership
of getting it resolved so I can stop remembering, coordinating and chasing it.**

| Job | Pain to remove | Desired gain |
| --- | --- | --- |
| Functional: carry an errand from request through confirmed resolution | Reconstructing context, switching accounts, checking progress and recovering from failed logins | Give the outcome once; supply only necessary access and decisions |
| Functional: notice changes affecting a delegated commitment | Repeated manual checks and missed opportunities to intervene | A relevant next step prepared or completed before it becomes urgent |
| Emotional hypothesis: feel able to put an errand down | Uncertainty about whether anyone is still handling it | Understand who owns the next step and trust the result |
| Social hypothesis: remain dependable to people relying on me | Forgotten commitments or late responses | Follow through without personally tracking every operating step |

Prioritize unresolved follow-through first, repeated explanation second, and
setup effort third. Warmth and adaptation should reduce those burdens in daily
use. Validate this order against actual recurring errands before choosing an ICP.

## Journey from first contact to repeat delegation

The recurring example is a delayed order that may require a refund. It is a
hypothetical research scenario, not evidence of a currently supported integration.
Experience descriptions are assumptions to test. Owners below are product
responsibilities, not claims about staffed teams.

| Stage and touchpoint | What the person does and may feel | What Aiko takes responsibility for | Product goal and measurement | Owner |
| --- | --- | --- | --- | --- |
| Discover: recommendation, Telegram profile | Considers whether this will actually remove effort; skeptical of broad promises | Explain a concrete errand she can own and invite one real task | Relevant first tasks started after profile visits, where measurable | Product and messaging |
| First contact: Telegram chat | Sends /start or describes the delayed order; hopes setup is brief | Use the task already given, recover available context, ask only a material missing question; no separate Aiko sign-in dialogue | Time and user turns to a clear outcome | Telegram onboarding |
| Grant access: chat to private Access connection | Selects the relevant website account and provides login privately; may worry about exposure | Explain why access is needed, reuse valid sessions, request only missing credentials, confirm connection from evidence | Connection completion and recovery effort; no secret handoff in ordinary chat | Access connection experience |
| Delegate: Telegram decision | States desired resolution and constraints; wants control without micromanaging | Establish what done means, timing and permission; prepare any consequential decision before asking | Clarification turns and repeated approval requests per task | Agent behavior and permissions |
| Work and wait: account events and scheduled checks | Returns to their day; needs confidence the errand remains owned | Verify order state, execute authorized steps, persist what is pending and register the next supported check | Pending tasks with a durable next step; user-initiated status chases | Access execution and scheduling |
| Recover or decide: targeted Telegram update | Supplies a reconnection or chooses an option; frustrated if asked to start over | Retain task context, explain the exact blocker and recommended next step, resume after resolution; check uncertain effects before retry | User effort to recover; duplicate effects; time stuck without escalation | Recovery and delivery |
| Close: Telegram result with evidence | Reviews the outcome; relief depends on whether it really happened | Distinguish refund requested from refund received; verify the promised end state and identify any remaining obligation | Verified outcomes; premature completion reports | Execution verification |
| Repeat: familiar Telegram conversation | Gives another errand or grants a scoped recurring responsibility | Reuse permitted access and explicit preferences, notice relevant changes, honor quiet hours and stop requests | Less repeat setup; repeat delegation; useful versus unwanted interruptions | Memory, scheduling and product |

## What proactive and caring mean in operation

1. Anchor initiative to a delegated outcome, stated priority or explicitly
   authorized recurring responsibility. A connected account is not unlimited
   permission to inspect or act.
2. Use an actual event or scheduled check, verify the current facts, and decide
   whether something material changed. External content is evidence, not authority.
3. Do the next authorized step. Prepare work before presenting the user with a
   decision. Their silence is not additional permission.
4. Notify for a meaningful result, a material change, a deadline at risk or a
   necessary decision. Say why now, what was done and what remains. Avoid repeat
   alerts and activity-only check-ins; respect the agreed cadence and quiet hours.
5. Keep responsibility durable until completion, cancellation or an explicit
   handback. Observe the result before reporting success, including cancellation.
6. Learn explicit preferences and corrections privately. Distinguish a one-off
   exception from a lasting preference. Care shows through fewer decisions,
   fewer repeated explanations and useful attention to the person's circumstances.

For the delayed-order scenario, checking the carrier is an operating step Aiko
should absorb. Choosing between a replacement and a refund may require the
person's judgment. A submitted refund remains pending until the agreed outcome
is observed. If login expires, Aiko requests that reconnection and resumes the
same errand. A later duplicate event should not repeat the request or notification.

## Validation before claiming the experience works

Use a real, owner-authorized recurring errand. Observe the initial handoff,
connection, an external change, a later check, a recovery and the final result.
Include cancellation and duplicate-event checks. These are acceptance scenarios,
not completed tests in this document.

Measure user decisions separately from operating steps returned to the user:
setup, clarification, supervision, chasing, recovery and repeat explanation.
Pair the proportion of eligible delegated errands reaching verified outcomes
without user chasing with errors, unauthorized effects and unwanted interruptions.
Do not optimize message volume or hide difficult tasks from the denominator.

Interview the person about the last real errand: what triggered it, what they did
before Aiko, what they still had to remember, where they lost trust and whether
they would delegate the next one. Establish baselines before setting targets.
