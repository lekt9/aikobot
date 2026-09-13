#!/usr/bin/env bun
/**
 * End-to-end smoke against a running host: `workerd` boots `wrangler dev`
 * locally, `deployed` targets the URL recorded by scripts/deploy.mjs. Both
 * drive the real `tdg` CLI as an operator would — allocate a thread, send a
 * state-changing turn and a read-back turn through the live model, then read
 * the durable trace — and assert the journaled boundaries and terminals are
 * present. Evidence is written under .tardigrade/ for the release gate.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
// Always the package-local CLI: a login shell may put an older global tdg first.
const TDG_BIN = join(packageDir, "node_modules", ".bin", "tdg");
const mode = process.argv[2];
if (mode !== "workerd" && mode !== "deployed") {
  console.error("usage: smoke.mjs <workerd|deployed> [url]");
  process.exit(2);
}

function readDevVars() {
  const path = join(packageDir, ".dev.vars");
  if (!existsSync(path))
    throw new Error(".dev.vars is required (TARDIGRADE_TOKEN, OPENAI_API_KEY)");
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`,
          ),
        );
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // The server is not listening yet; keep polling until the deadline.
    }
    if (Date.now() > deadline)
      throw new Error(`no healthy server at ${url} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const vars = readDevVars();
const token = vars.TARDIGRADE_TOKEN;
if (!token) throw new Error("TARDIGRADE_TOKEN missing from .dev.vars");
const evidenceDir =
  process.env.ELIZA_TARDIGRADE_EVIDENCE_DIR ?? join(packageDir, ".tardigrade");
// Child processes (wrangler, tdg) need a real temp directory; the calling
// shell may name one that is not a directory, so give them a package-owned one.
const childTmp = join(evidenceDir, "tmp");
mkdirSync(childTmp, { recursive: true });
const childEnv = {
  ...process.env,
  TMPDIR: childTmp,
  TMP: childTmp,
  TEMP: childTmp,
};
mkdirSync(evidenceDir, { recursive: true });

let server;
let url = process.argv[3];
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

try {
  if (mode === "workerd") {
    await run("bunx", [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "CATALOG_DB",
      "--local",
      "--persist-to",
      join(evidenceDir, "wrangler-state"),
    ]);
    const port = 8700 + Math.floor(Math.random() * 200);
    url = `http://127.0.0.1:${port}`;
    server = spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        join(evidenceDir, "wrangler-state"),
      ],
      {
        cwd: packageDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: childEnv,
      },
    );
    let serverOutput = "";
    server.stdout.on("data", (chunk) => {
      serverOutput += chunk;
    });
    server.stderr.on("data", (chunk) => {
      serverOutput += chunk;
    });
    try {
      await waitForHealth(url, 180_000);
    } catch (error) {
      throw new Error(`${error.message}\n${serverOutput}`);
    }
    note(`workerd: wrangler dev healthy at ${url}`);
  } else {
    if (!url) {
      const deployPath = join(packageDir, ".tardigrade", "deploy.json");
      if (!existsSync(deployPath))
        throw new Error("no deployed URL: pass one or run scripts/deploy.mjs");
      url = JSON.parse(readFileSync(deployPath, "utf8")).url;
    }
    await waitForHealth(url, 30_000);
    note(`deployed: ${url} healthy`);
  }

  const instance = "smoke-owner";
  const thread = `smoke-${Date.now()}`;
  const tdg = (args) =>
    run(TDG_BIN, [
      ...args,
      "--actor",
      instance,
      "--url",
      url,
      "--token",
      token,
      "--json",
    ]);
  const created = JSON.parse(
    (await tdg(["thread", "create", "--name", thread])).stdout,
  );
  note(`thread allocated: ${JSON.stringify(created)}`);
  const threadId = created.thread ?? created.coordinate?.thread ?? thread;

  const call = async (key, text) => {
    const { stdout } = await tdg([
      "call",
      "message",
      JSON.stringify({ text, input: { owner: instance } }),
      "--thread",
      threadId,
      "--id",
      key,
      "--timeout",
      "240000",
    ]);
    const parsed = JSON.parse(stdout);
    const output =
      typeof parsed === "string"
        ? parsed
        : (parsed.output ?? parsed.result ?? JSON.stringify(parsed));
    note(`${key} -> ${String(output).slice(0, 300)}`);
    return String(output);
  };
  const first = await call(
    `${thread}-write`,
    'Add "buy oat milk" to my todo list.',
  );
  const second = await call(
    `${thread}-read`,
    "What is on my todo list right now? Answer from the list itself.",
  );

  const eventsRaw = JSON.parse(
    (await tdg(["events", threadId, "--limit", "1000"])).stdout,
  );
  const events = (
    Array.isArray(eventsRaw)
      ? eventsRaw
      : (eventsRaw.events ?? eventsRaw.rows ?? [])
  ).map((row) => row.event ?? row);
  const types = events.map((event) => event.type);
  const boundaries = events.filter(
    (event) => event.type === "ElizaBoundaryRecorded",
  );
  const failures = [];
  const expectCount = (type, count) => {
    const actual = types.filter((candidate) => candidate === type).length;
    if (actual < count)
      failures.push(`${type}: expected >= ${count}, saw ${actual}`);
  };
  expectCount("MessageReceived", 2);
  expectCount("ElizaThreadBound", 1);
  expectCount("ElizaBoundaryStarted", 2);
  expectCount("TurnCompleted", 2);
  if (!boundaries.some((event) => event.kind === "model"))
    failures.push("no recorded model boundary");
  if (!boundaries.some((event) => event.kind === "action"))
    failures.push("no recorded action boundary");
  const actionNames = events
    .filter(
      (event) =>
        event.type === "ElizaBoundaryStarted" && event.kind === "action",
    )
    .map((event) => event.name);
  if (!actionNames.includes("TODO"))
    failures.push(
      `TODO action boundary missing (saw ${actionNames.join(",") || "none"})`,
    );
  if (!/oat milk/iu.test(second))
    failures.push(`read-back reply did not surface the todo: ${second}`);
  if (types.includes("TurnFailed")) failures.push("a turn failed");

  writeFileSync(
    join(evidenceDir, `smoke-${mode}.json`),
    JSON.stringify(
      {
        mode,
        url,
        instance,
        thread: threadId,
        outputs: { first, second },
        actionNames,
        types,
        events,
        log,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) {
    console.error(
      `${mode.toUpperCase()} SMOKE FAILED:\n- ${failures.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(
    `${mode.toUpperCase()} SMOKE PASSED (${types.length} events; actions ${actionNames.join(",")})`,
  );
} finally {
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
}
