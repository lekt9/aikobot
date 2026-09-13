#!/usr/bin/env bun
/**
 * Turn latency from a recorded smoke trace: for each MessageReceived, the
 * time to its TurnCompleted, derived from the durable timestamps. Fails when
 * any turn exceeds the budget or when the trace holds no completed turn, so a
 * missing or empty trace never reads as fast.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir =
  process.env.ELIZA_TARDIGRADE_EVIDENCE_DIR ?? join(packageDir, ".tardigrade");
const source = process.argv[2] ?? join(evidenceDir, "smoke-deployed.json");
const budgetMs = Number(process.argv[3] ?? 120_000);
const trace = JSON.parse(readFileSync(source, "utf8"));
const events = trace.events ?? [];
const turns = [];
for (const event of events) {
  if (event.type === "MessageReceived")
    turns.push({ turn: event.id, startedAt: event.at });
}
for (const turn of turns) {
  const terminal = events.find(
    (event) => event.type === "TurnCompleted" && event.turn === turn.turn,
  );
  turn.completedAt = terminal?.at;
  turn.latencyMs = terminal ? terminal.at - turn.startedAt : null;
  turn.modelCalls = events.filter(
    (event) =>
      event.type === "ElizaBoundaryRecorded" &&
      event.kind === "model" &&
      event.turn === turn.turn,
  ).length;
}
const completed = turns.filter((turn) => typeof turn.latencyMs === "number");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  join(evidenceDir, "perf.json"),
  JSON.stringify(
    { source, budgetMs, turns, at: new Date().toISOString() },
    null,
    2,
  ),
);
for (const turn of turns)
  console.log(
    `${turn.turn}: ${turn.latencyMs ?? "incomplete"} ms over ${turn.modelCalls} model calls`,
  );
if (completed.length === 0) {
  console.error("PERF FAILED: no completed turn in the trace");
  process.exit(1);
}
const slow = completed.filter((turn) => turn.latencyMs > budgetMs);
if (slow.length > 0) {
  console.error(
    `PERF FAILED: ${slow.map((turn) => `${turn.turn}=${turn.latencyMs}ms`).join(", ")} over ${budgetMs} ms`,
  );
  process.exit(1);
}
console.log(`PERF PASSED: ${completed.length} turn(s) within ${budgetMs} ms`);
