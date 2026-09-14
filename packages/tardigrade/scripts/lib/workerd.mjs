/**
 * Shared bootstrap for the operator-style scripts: read local secrets, boot
 * `wrangler dev` on a random port with persisted state, wait for health, and
 * drive the package-local `tdg` CLI against a host. Child processes get a
 * package-owned temp directory because the calling shell may name one that
 * is not a directory.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The wrangler to run. Code mode starts a dynamic Worker whose compatibility
 * date can be newer than the installed binary supports, so a pinned newer
 * release can be selected without changing the workspace manifest.
 */
export const wranglerSpec = () => process.env.ELIZA_WRANGLER ?? "wrangler";

export function readDevVars(packageDir) {
  const path = join(packageDir, ".dev.vars");
  if (!existsSync(path))
    throw new Error(".dev.vars is required (see .dev.vars.example)");
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export function evidenceDirFor(packageDir) {
  const dir =
    process.env.ELIZA_TARDIGRADE_EVIDENCE_DIR ??
    join(packageDir, ".tardigrade");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function childEnvFor(evidenceDir, extra = {}) {
  const childTmp = join(evidenceDir, "tmp");
  mkdirSync(childTmp, { recursive: true });
  return {
    ...process.env,
    TMPDIR: childTmp,
    TMP: childTmp,
    TEMP: childTmp,
    ...extra,
  };
}

export function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
          Object.assign(
            new Error(
              `${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`,
            ),
            { code, stdout, stderr },
          ),
        );
    });
  });
}

export async function waitForHealth(url, timeoutMs) {
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

/**
 * Boots wrangler dev for the package and resolves once `/healthz` answers.
 * `vars` are passed as `--var` overrides for mode variations; secrets still
 * come from `.dev.vars`.
 */
export async function startWorkerd({
  packageDir,
  evidenceDir,
  vars = {},
  config,
  catalog = config === undefined,
  stateDir = "wrangler-state",
}) {
  const env = childEnvFor(evidenceDir);
  const persist = join(evidenceDir, stateDir);
  const configArgs = config === undefined ? [] : ["--config", config];
  if (catalog) {
    await run(
      "bunx",
      [
        wranglerSpec(),
        "d1",
        "migrations",
        "apply",
        "CATALOG_DB",
        "--local",
        "--persist-to",
        persist,
        ...configArgs,
      ],
      { cwd: packageDir, env },
    );
  }
  const port = 8700 + Math.floor(Math.random() * 200);
  const url = `http://127.0.0.1:${port}`;
  const args = [
    wranglerSpec(),
    "dev",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persist,
    ...configArgs,
  ];
  for (const [name, value] of Object.entries(vars))
    args.push("--var", `${name}:${value}`);
  const server = spawn("bunx", args, {
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env,
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  };
  try {
    await waitForHealth(url, 180_000);
  } catch (error) {
    stop();
    throw new Error(`${error.message}\n${output}`);
  }
  return { url, stop, output: () => output, env };
}

/** A `tdg` invocation bound to one host, bearer, and actor instance. */
export function tdgClient({ packageDir, url, token, instance, env }) {
  const bin = join(packageDir, "node_modules", ".bin", "tdg");
  return (args) =>
    run(
      bin,
      [...args, "--actor", instance, "--url", url, "--token", token, "--json"],
      {
        cwd: packageDir,
        env,
      },
    );
}

export function parseEvents(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed.events ?? parsed.rows ?? []);
  return rows.map((row) => row.event ?? row);
}

export function outputOf(stdout) {
  const parsed = JSON.parse(stdout);
  return typeof parsed === "string"
    ? parsed
    : String(parsed.output ?? parsed.result ?? JSON.stringify(parsed));
}
