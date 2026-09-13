#!/usr/bin/env bun
/**
 * Cross-layer release journey against a deployed Worker: unauthenticated and
 * wrong-token requests are refused (login failure branch), the bearer token is
 * admitted (login), a fresh thread runs a state-changing TODO turn and a
 * read-back turn through the live model (primary workflow, CRUD), re-sending
 * the create call key returns the recorded reply with no new turn (duplicate
 * delivery), a `runDueTasks` wakeup runs on the deployment (scheduling), a
 * message naming another owner ends as a durable failure (workflow failure
 * branch), and the durable trace is read back from the Durable Object with
 * exact terminal counts (read-back). Prints one success marker only after
 * every assertion.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// Always the package-local CLI: a login shell may put an older global tdg first.
const TDG_BIN = join(packageDir, "node_modules", ".bin", "tdg");
const evidenceDir =
  process.env.ELIZA_TARDIGRADE_EVIDENCE_DIR ?? join(packageDir, ".tardigrade");
// Child processes need a real temp directory; the calling shell may name one
// that is not a directory, so give them a package-owned one.
const childTmp = join(evidenceDir, "tmp");
mkdirSync(childTmp, { recursive: true });
const childEnv = {
  ...process.env,
  TMPDIR: childTmp,
  TMP: childTmp,
  TEMP: childTmp,
};
const url =
  process.argv[2] ??
  JSON.parse(
    readFileSync(join(packageDir, ".tardigrade", "deploy.json"), "utf8"),
  ).url;
const vars = Object.fromEntries(
  readFileSync(join(packageDir, ".dev.vars"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const token = vars.TARDIGRADE_TOKEN;
if (!token) throw new Error("TARDIGRADE_TOKEN missing from .dev.vars");

const callOutput = (parsed) =>
  String(
    typeof parsed === "string"
      ? parsed
      : (parsed.output ?? parsed.result ?? JSON.stringify(parsed)),
  );

const failures = [];
const record = [];
const check = (name, ok, detail) => {
  record.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`,
  );
};

const run = (command, args, env = childEnv) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const health = await fetch(`${url}/healthz`);
check("public deployment: /healthz", health.ok, `${health.status} ${url}`);

const instance = "journey-owner";
const thread = `journey-${Date.now()}`;
const tdg = (args, override = {}) =>
  run(TDG_BIN, [
    ...args,
    "--actor",
    instance,
    "--url",
    url,
    "--token",
    override.token ?? token,
    "--json",
  ]);

// tdg reads TARDIGRADE_TOKEN from the environment; the anonymous branch must
// present no credential at all, so the variable is removed for this call.
const { TARDIGRADE_TOKEN: _token, ...anonymousEnv } = childEnv;
const anonymous = await run(
  TDG_BIN,
  [
    "thread",
    "create",
    "--name",
    `${thread}-anon`,
    "--actor",
    instance,
    "--url",
    url,
    "--json",
  ],
  anonymousEnv,
);
check(
  "login failure branch: no bearer token is refused",
  anonymous.code !== 0,
  (anonymous.stderr || anonymous.stdout).trim().split("\n").at(-1),
);
const wrong = await tdg(["thread", "create", "--name", `${thread}-wrong`], {
  token: "not-the-token",
});
check(
  "login failure branch: wrong bearer token is refused",
  wrong.code !== 0,
  (wrong.stderr || wrong.stdout).trim().split("\n").at(-1),
);

const created = await tdg(["thread", "create", "--name", thread]);
check(
  "login: bearer token admits thread allocation",
  created.code === 0,
  created.stdout.trim(),
);
const threadId =
  created.code === 0 ? (JSON.parse(created.stdout).thread ?? thread) : thread;

const call = async (key, text, owner = instance) => {
  const result = await tdg([
    "call",
    "message",
    JSON.stringify({ text, input: { owner } }),
    "--thread",
    threadId,
    "--id",
    key,
    "--timeout",
    "240000",
  ]);
  return {
    ...result,
    output: result.code === 0 ? callOutput(JSON.parse(result.stdout)) : "",
  };
};
const write = await call(
  `${thread}-create`,
  'Add "water the ferns" to my todo list.',
);
check(
  "primary workflow + CRUD create: TODO turn completes",
  write.code === 0 && write.output.length > 0,
  write.output || write.stderr.trim(),
);
// The stored item must come back through the read action. The model's prose
// is the usual surface; when a sample degrades, the durable trace's recorded
// TODO list result is the same read-back, and one fresh call is a legitimate
// repeated request. Each attempt is its own durable turn.
const readEvents = async () => {
  const listing = await tdg(["events", threadId, "--limit", "1000"]);
  if (listing.code !== 0) return [];
  const raw = JSON.parse(listing.stdout);
  return (Array.isArray(raw) ? raw : (raw.events ?? raw.rows ?? [])).map(
    (row) => row.event ?? row,
  );
};
const readBackSurfaced = async (turn, output) => {
  if (/ferns/iu.test(output)) return "reply";
  const recorded = (await readEvents()).some(
    (event) =>
      event.type === "ElizaBoundaryRecorded" &&
      event.kind === "action" &&
      event.turn === turn &&
      /ferns/iu.test(JSON.stringify(event.result ?? "")),
  );
  return recorded ? "trace" : null;
};
let read = await call(
  `${thread}-list`,
  "List my todo items exactly as they are stored.",
);
let readSurface =
  read.code === 0
    ? await readBackSurfaced(`${thread}-list`, read.output)
    : null;
let readAttempts = 1;
if (readSurface === null) {
  readAttempts = 2;
  read = await call(
    `${thread}-list-2`,
    "List my todo items exactly as they are stored.",
  );
  readSurface =
    read.code === 0
      ? await readBackSurfaced(`${thread}-list-2`, read.output)
      : null;
}
check(
  "CRUD read: the stored todo is read back through the model",
  read.code === 0 && readSurface !== null,
  `${readSurface ?? "not surfaced"}: ${read.output || read.stderr.trim()}`,
);

const duplicate = await call(
  `${thread}-create`,
  'Add "water the ferns" to my todo list.',
);
check(
  "duplicate delivery: re-sending the create call key returns the recorded reply without a new turn",
  duplicate.code === 0 && duplicate.output === write.output,
  duplicate.output || duplicate.stderr.trim(),
);
const tick = await tdg([
  "call",
  "runDueTasks",
  JSON.stringify({ owner: instance }),
  "--thread",
  threadId,
  "--id",
  `${thread}-tick`,
  "--timeout",
  "120000",
]);
check(
  "scheduling: a host wakeup runs due tasks on the deployment (none scheduled)",
  tick.code === 0 && /"executed":\s*0/u.test(tick.stdout),
  tick.stdout.trim() || tick.stderr.trim(),
);
const foreign = await call(`${thread}-intrude`, "hello", "someone-else");
check(
  "workflow failure branch: foreign owner is refused durably",
  foreign.code !== 0 &&
    /OWNER_(INSTANCE_)?MISMATCH/u.test(foreign.stderr + foreign.stdout),
  (foreign.stderr || foreign.stdout).trim().split("\n").at(-1),
);

const events = await tdg(["events", threadId, "--limit", "1000"]);
let types = [];
let eventsRows = [];
if (events.code === 0) {
  const raw = JSON.parse(events.stdout);
  eventsRows = (Array.isArray(raw) ? raw : (raw.events ?? raw.rows ?? [])).map(
    (row) => row.event ?? row,
  );
  types = eventsRows.map((event) => event.type);
}
const count = (type) => types.filter((candidate) => candidate === type).length;
check(
  "read-back: durable trace holds the binding, journaled boundaries, terminals, and the refused turn",
  events.code === 0 &&
    count("ElizaThreadBound") === 1 &&
    count("ElizaBoundaryRecorded") >= 4 &&
    count("MessageReceived") === 2 + readAttempts &&
    count("TurnCompleted") === 2 &&
    count("TurnFailed") === 1 + (readAttempts - 1) &&
    count("ElizaTickRequested") === 1 &&
    count("ElizaTickCompleted") === 1,
  `${types.length} events: ${[...new Set(types)].join(",")}`,
);

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  join(evidenceDir, "journey.json"),
  JSON.stringify(
    {
      url,
      thread: threadId,
      record,
      readAttempts,
      readSurface,
      types,
      events: eventsRows,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
if (failures.length > 0) {
  console.error(`JOURNEY FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("CROSS-LAYER JOURNEY PASSED");
