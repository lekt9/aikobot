#!/usr/bin/env bun
/**
 * Runs the package-local `tdg` CLI with a temp directory this package owns,
 * so builds and lints do not depend on the calling shell's TMPDIR being a
 * usable directory (a login shell on this machine names one that is not).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// Prefer a temp root outside the package so builds and lints never write into
// the fingerprinted tree; the package-owned root is the last resort.
const usable = (dir) => {
  try {
    mkdirSync(dir, { recursive: true });
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const tmp = [process.env.TMPDIR, "/tmp", join(packageDir, ".tardigrade", "tmp")]
  .filter(Boolean)
  .find(usable);
if (!tmp) throw new Error("no usable temp directory for tdg");
// Always the package-local CLI: a login shell may put an older global tdg first.
const result = spawnSync(
  join(packageDir, "node_modules", ".bin", "tdg"),
  process.argv.slice(2),
  {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
  },
);
process.exit(result.status ?? 1);
