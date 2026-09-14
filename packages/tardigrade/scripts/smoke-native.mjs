#!/usr/bin/env bun
/**
 * The native composition against a running Cloudflare host: an owner token,
 * a thread, a real model turn that reaches an elizaOS action by writing
 * JavaScript, and a read-back turn that has to recall it. `workerd` boots
 * `wrangler dev` on the native configuration; `deployed` targets the URL
 * recorded by the deploy script. The durable trace is inspected afterwards:
 * provider context before the model, a code execution that called a package,
 * and a completed turn — the shape that says Tardigrade ran the loop.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnerTokenIssuer } from "../src/hosts/auth.ts";
import {
  childEnvFor,
  evidenceDirFor,
  outputOf,
  parseEvents,
  readDevVars,
  startWorkerd,
  tdgClient,
  waitForHealth,
} from "./lib/workerd.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "workerd" && mode !== "deployed") {
  console.error("usage: smoke-native.mjs <workerd|deployed> [url]");
  process.exit(2);
}

const vars = readDevVars(packageDir);
const secret = vars.ELIZA_OWNER_TOKEN_SECRET;
if (!secret) throw new Error("ELIZA_OWNER_TOKEN_SECRET missing from .dev.vars");
const evidenceDir = evidenceDirFor(packageDir);
const env = childEnvFor(evidenceDir);
const issuer = createOwnerTokenIssuer({
  secret,
  issuer: vars.ELIZA_OWNER_TOKEN_ISSUER ?? "aiko",
  audience: vars.ELIZA_OWNER_TOKEN_AUDIENCE ?? "eliza",
  ttlMs: 300_000,
});

const log = [];
const failures = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
const check = (condition, message) => {
  if (!condition) failures.push(message);
  note(`${condition ? "ok " : "FAIL"} ${message}`);
};

let server;
let url = process.argv[3];
try {
  if (mode === "workerd") {
    server = await startWorkerd({
      packageDir,
      evidenceDir,
      config: "wrangler.native.jsonc",
      catalog: true,
      stateDir: "wrangler-native-state",
    });
    url = server.url;
    note(`workerd: native wrangler dev healthy at ${url}`);
  } else {
    if (!url) {
      const deployPath = join(packageDir, ".tardigrade", "deploy-native.json");
      if (!existsSync(deployPath)) {
        throw new Error("no deployed URL: pass one or run the native deploy");
      }
      url = JSON.parse(readFileSync(deployPath, "utf8")).url;
    }
    await waitForHealth(url, 30_000);
    note(`deployed: ${url} healthy`);
  }

  const identity = await (await fetch(`${url}/`)).json();
  check(
    identity.composition === "native",
    `the deployment reports the native composition (${identity.composition})`,
  );
  check(
    Array.isArray(identity.methods) && identity.methods.includes("wake"),
    `the actor exposes its own wake method (${JSON.stringify(identity.methods)})`,
  );

  const instance = "home";
  const stamp = Date.now();
  const thread = `native-${stamp}`;
  const owner = tdgClient({
    packageDir,
    url,
    token: await issuer.issue("smoke-owner"),
    instance,
    env,
  });
  const created = JSON.parse(
    (await owner(["thread", "create", "--name", thread])).stdout,
  );
  const threadId = created.thread ?? created.coordinate?.thread ?? thread;
  note(`thread allocated: ${JSON.stringify(created)}`);

  const call = async (key, text) => {
    const { stdout } = await owner([
      "call",
      "message",
      JSON.stringify({ text }),
      "--thread",
      threadId,
      "--id",
      key,
      "--timeout",
      "300000",
    ]);
    const output = outputOf(stdout);
    note(`${key} -> ${output.slice(0, 300)}`);
    return output;
  };

  const first = await call(
    `${thread}-write`,
    'Add "buy oat milk" to my todo list.',
  );
  const second = await call(
    `${thread}-read`,
    "What is on my todo list right now? Answer from the list itself.",
  );

  const events = parseEvents(
    (await owner(["events", threadId, "--limit", "1000"])).stdout,
  );
  const types = events.map((event) => event.type);
  const count = (type) => types.filter((entry) => entry === type).length;

  check(
    count("TurnCompleted") >= 2,
    `both turns completed (${count("TurnCompleted")})`,
  );
  check(count("TurnFailed") === 0, `no turn failed (${count("TurnFailed")})`);
  check(
    count("ElizaContextComposed") >= 2,
    `provider context was composed for each turn (${count("ElizaContextComposed")})`,
  );
  check(
    types.indexOf("ElizaContextComposed") < types.indexOf("ModelCalled"),
    "provider context landed before the first model call",
  );
  check(
    count("CodeDispatched") >= 1,
    `the model wrote and ran JavaScript (${count("CodeDispatched")})`,
  );
  // A package call records its qualified `package.method` as its name.
  const packageCalls = events
    .filter((event) => event.type === "PackageCalled")
    .map((event) => String(event.name ?? ""));
  check(
    packageCalls.some((entry) => entry.startsWith("todos.")),
    `an elizaOS action ran as a package method (${packageCalls.join(",") || "none"})`,
  );
  check(
    count("ElizaBoundaryStarted") === 0,
    "no elizaOS message loop ran inside a turn",
  );
  check(
    count("ElizaEvaluated") >= 1,
    `evaluators ran after a turn (${count("ElizaEvaluated")})`,
  );
  check(
    /oat milk/iu.test(second),
    `the read-back turn recalled the todo: ${second.slice(0, 200)}`,
  );

  writeFileSync(
    join(evidenceDir, `smoke-native-${mode}.json`),
    JSON.stringify(
      {
        mode,
        url,
        identity,
        instance: created.instance ?? instance,
        thread: threadId,
        outputs: { first, second },
        packageCalls,
        types,
        events,
        log,
        failures,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) {
    console.error(
      `NATIVE SMOKE ${mode.toUpperCase()} FAILED:\n- ${failures.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(
    `NATIVE SMOKE ${mode.toUpperCase()} PASSED (${types.length} events; packages ${packageCalls.join(",")})`,
  );
} catch (error) {
  if (server) {
    console.error(
      `--- workerd output (tail) ---\n${server.output().slice(-8000)}`,
    );
  }
  throw error;
} finally {
  server?.stop();
}
