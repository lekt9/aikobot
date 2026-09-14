#!/usr/bin/env bun
/**
 * Multi-owner proof against a running host: two owners with Aiko-style owner
 * tokens use the same deployment, each reaching only its own actor instance;
 * an unauthenticated caller, a garbage token, and a cross-owner claim are
 * refused; the operator bearer still reaches unscoped instances. `workerd`
 * boots `wrangler dev`, `deployed` targets the recorded URL. Evidence is
 * written under .tardigrade/ for the release gate.
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
  console.error("usage: owners.mjs <workerd|deployed> [url]");
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
  ttlMs: 60_000,
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
const refused = async (work) => {
  try {
    await work();
    return null;
  } catch (error) {
    return error;
  }
};

let server;
let url = process.argv[3];
try {
  if (mode === "workerd") {
    server = await startWorkerd({ packageDir, evidenceDir });
    url = server.url;
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

  const identity = await (await fetch(`${url}/`)).json();
  check(
    Array.isArray(identity.identity) &&
      identity.identity.includes("owner-token"),
    `identity route advertises owner-token mode (${JSON.stringify(identity.identity)})`,
  );

  // Authentication failures never reach a thread.
  const anonymous = await fetch(`${url}/v1/metadata`);
  check(
    anonymous.status === 401,
    `anonymous request refused with 401 (saw ${anonymous.status})`,
  );
  const garbage = await fetch(`${url}/v1/metadata`, {
    headers: { authorization: "Bearer not.a.token" },
  });
  check(
    garbage.status === 401,
    `garbage bearer refused with 401 (saw ${garbage.status})`,
  );
  const aliceToken = await issuer.issue("alice");
  const authed = await fetch(`${url}/v1/metadata`, {
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  check(
    authed.status === 200,
    `owner token reaches metadata (saw ${authed.status})`,
  );
  const unscopedRoute = await fetch(`${url}/v1/status`, {
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  check(
    unscopedRoute.status === 404,
    `a route outside the owner scope is refused (saw ${unscopedRoute.status})`,
  );

  // Two owners, one instance name, isolated threads.
  const instance = "home";
  const stamp = Date.now();
  const alice = tdgClient({
    packageDir,
    url,
    token: await issuer.issue("alice"),
    instance,
    env,
  });
  const bob = tdgClient({
    packageDir,
    url,
    token: await issuer.issue("bob"),
    instance,
    env,
  });
  const aliceThread = `owners-alice-${stamp}`;
  const created = JSON.parse(
    (await alice(["thread", "create", "--name", aliceThread])).stdout,
  );
  const aliceThreadId =
    created.thread ?? created.coordinate?.thread ?? aliceThread;
  note(`alice thread allocated: ${JSON.stringify(created)}`);
  check(
    typeof created.instance === "string" &&
      created.instance !== instance &&
      created.instance.startsWith("user."),
    `alice's thread lives in an owner-scoped instance (${created.instance})`,
  );

  const bobReads = await refused(() =>
    bob(["events", aliceThreadId, "--limit", "10"]),
  );
  check(
    bobReads !== null,
    "bob cannot read alice's thread through the same instance name",
  );

  const bobThread = `owners-bob-${stamp}`;
  const bobCreated = JSON.parse(
    (await bob(["thread", "create", "--name", bobThread])).stdout,
  );
  check(
    bobCreated.instance !== created.instance,
    `bob's same-named instance resolves to a different scoped instance (${bobCreated.instance})`,
  );

  // Owner claims are checked against the token's owner, not the URL.
  const spoof = await refused(() =>
    alice([
      "call",
      "message",
      JSON.stringify({
        text: "Reply with exactly OK.",
        input: { owner: "bob" },
      }),
      "--thread",
      aliceThreadId,
      "--id",
      `${aliceThread}-spoof`,
      "--timeout",
      "120000",
    ]),
  );
  const spoofText =
    spoof === null
      ? ""
      : `${spoof.stdout ?? ""}${spoof.stderr ?? ""}${spoof.message}`;
  check(
    spoof !== null && /TARDIGRADE_OWNER_INSTANCE_MISMATCH/u.test(spoofText),
    "a turn claiming another owner fails with TARDIGRADE_OWNER_INSTANCE_MISMATCH",
  );

  const reply = outputOf(
    (
      await alice([
        "call",
        "message",
        JSON.stringify({
          text: "Reply with exactly the word OK.",
          input: { owner: "alice" },
        }),
        "--thread",
        aliceThreadId,
        "--id",
        `${aliceThread}-turn`,
        "--timeout",
        "240000",
      ])
    ).stdout,
  );
  note(`alice turn -> ${reply.slice(0, 200)}`);
  check(reply.length > 0, "alice completes a real turn in her scoped instance");

  const events = parseEvents(
    (await alice(["events", aliceThreadId, "--limit", "1000"])).stdout,
  );
  const bound = events.find((event) => event.type === "ElizaThreadBound");
  check(
    bound?.owner === "alice",
    `the thread is bound to alice (${JSON.stringify(bound ?? null)})`,
  );
  check(
    !events.some(
      (event) =>
        event.type === "TurnCompleted" &&
        /spoof/u.test(String(event.turn ?? "")),
    ),
    "the spoofed turn never completed",
  );

  // The operator bearer keeps its unscoped access when configured.
  if (vars.TARDIGRADE_TOKEN) {
    const operator = tdgClient({
      packageDir,
      url,
      token: vars.TARDIGRADE_TOKEN,
      instance: "ops",
      env,
    });
    const ops = JSON.parse(
      (await operator(["thread", "create", "--name", `owners-ops-${stamp}`]))
        .stdout,
    );
    check(
      ops.instance === "ops",
      `the operator bearer reaches the unscoped instance (${ops.instance})`,
    );
  } else {
    note("skip operator bearer check: TARDIGRADE_TOKEN not configured");
  }

  writeFileSync(
    join(evidenceDir, `owners-${mode}.json`),
    JSON.stringify(
      {
        mode,
        url,
        identity,
        alice: created,
        bob: bobCreated,
        reply,
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
      `MULTI-OWNER ${mode.toUpperCase()} FAILED:\n- ${failures.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(
    `MULTI-OWNER ${mode.toUpperCase()} PASSED (${events.length} events in alice's thread)`,
  );
} catch (error) {
  if (server)
    console.error(
      `--- workerd output (tail) ---\n${server.output().slice(-6000)}`,
    );
  throw error;
} finally {
  server?.stop();
}
