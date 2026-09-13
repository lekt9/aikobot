#!/usr/bin/env bun
/**
 * Deploys the Worker with wrangler and records the public URL for
 * scripts/smoke.mjs deployed. Secrets (`TARDIGRADE_TOKEN`, `OPENAI_API_KEY`)
 * are pushed from .dev.vars so the deployed Worker matches the local one.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = Object.fromEntries(
  readFileSync(join(packageDir, ".dev.vars"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);

const wrangler = (args, input) => {
  const result = spawnSync("bunx", ["wrangler", ...args], {
    cwd: packageDir,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0)
    throw new Error(
      `wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout + result.stderr;
};

const deployOutput = wrangler(["deploy"]);
console.log(deployOutput);
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/iu.exec(deployOutput)?.[0];
if (!url) throw new Error("wrangler deploy did not print a workers.dev URL");
for (const name of ["TARDIGRADE_TOKEN", "OPENAI_API_KEY"]) {
  if (!devVars[name]) throw new Error(`${name} missing from .dev.vars`);
  wrangler(["secret", "put", name], devVars[name]);
}
mkdirSync(join(packageDir, ".tardigrade"), { recursive: true });
writeFileSync(
  join(packageDir, ".tardigrade", "deploy.json"),
  JSON.stringify({ url, deployedAt: new Date().toISOString() }, null, 2),
);
console.log(`deployed: ${url}`);
