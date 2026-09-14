#!/usr/bin/env bun
/**
 * Owner storage proof on workerd: through the owner-object fixture, alice
 * remembers a fact, recalls it, bob cannot see it, a repeated key replays
 * without a second write, another owner's object refuses her invocation —
 * then wrangler is stopped and restarted on the same persisted state and
 * alice still recalls the fact. Evidence is written under .tardigrade/.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDirFor, startWorkerd } from "./lib/workerd.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "workerd") {
  console.error("usage: owner-storage.mjs workerd");
  process.exit(2);
}

const evidenceDir = evidenceDirFor(packageDir);
const stamp = Date.now();
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
const boot = () =>
  startWorkerd({
    packageDir,
    evidenceDir,
    config: "wrangler.owner-test.jsonc",
    stateDir: `owner-state-${stamp}`,
  });
const call = async (url, owner, action, init) => {
  const response = await fetch(`${url}/owners/${owner}/${action}`, init);
  return { status: response.status, body: await response.json() };
};
const remember = (url, owner, key, text) =>
  call(url, owner, "remember", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, text }),
  });
const recall = (url, owner, key = "recall") =>
  call(url, owner, `recall?key=${encodeURIComponent(key)}`);

let server;
try {
  server = await boot();
  note(`workerd: owner fixture healthy at ${server.url}`);
  const first = await remember(
    server.url,
    "alice",
    "fact-1",
    "the sky is blue",
  );
  check(
    first.status === 200 &&
      first.body.result?.count === 1 &&
      first.body.replayed === false,
    `alice remembers a fact (${JSON.stringify(first.body)})`,
  );
  const again = await remember(
    server.url,
    "alice",
    "fact-1",
    "the sky is blue",
  );
  check(
    again.status === 200 &&
      again.body.replayed === true &&
      again.body.result?.count === 1,
    `a repeated key replays without a second write (${JSON.stringify(again.body)})`,
  );
  const reused = await remember(
    server.url,
    "alice",
    "fact-1",
    "the sky is green",
  );
  check(
    reused.status === 409 &&
      reused.body.code === "TARDIGRADE_INVOCATION_KEY_REUSED",
    `a reused key with another payload is refused (${JSON.stringify(reused.body)})`,
  );
  const alice = await recall(server.url, "alice", "r1");
  check(
    alice.status === 200 &&
      Array.isArray(alice.body.result) &&
      alice.body.result.includes("the sky is blue"),
    `alice recalls the fact (${JSON.stringify(alice.body.result)})`,
  );
  const bob = await recall(server.url, "bob", "r1");
  check(
    bob.status === 200 &&
      Array.isArray(bob.body.result) &&
      bob.body.result.length === 0,
    `bob recalls nothing of alice's (${JSON.stringify(bob.body.result)})`,
  );
  const foreign = await call(server.url, "alice", "foreign", {
    method: "POST",
  });
  check(
    foreign.status === 409 &&
      /foreign owner refused/u.test(String(foreign.body.error)),
    `another owner's object refuses alice's invocation (${JSON.stringify(foreign.body)})`,
  );
  server.stop();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  server = undefined;

  server = await boot();
  note(`workerd: restarted on the same persisted state at ${server.url}`);
  const after = await recall(server.url, "alice", "r2");
  check(
    after.status === 200 &&
      Array.isArray(after.body.result) &&
      after.body.result.includes("the sky is blue"),
    `alice still recalls the fact after the restart (${JSON.stringify(after.body.result)})`,
  );
  const replayAfter = await remember(
    server.url,
    "alice",
    "fact-1",
    "the sky is blue",
  );
  check(
    replayAfter.status === 200 && replayAfter.body.replayed === true,
    "the receipt survived the restart, so the key replays",
  );

  writeFileSync(
    join(evidenceDir, "owner-storage-workerd.json"),
    JSON.stringify(
      { mode, log, failures, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  if (failures.length > 0) {
    console.error(`OWNER STORAGE WORKERD FAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("OWNER STORAGE WORKERD PASSED");
} catch (error) {
  if (server)
    console.error(
      `--- workerd output (tail) ---\n${server.output().slice(-6000)}`,
    );
  throw error;
} finally {
  server?.stop();
}
