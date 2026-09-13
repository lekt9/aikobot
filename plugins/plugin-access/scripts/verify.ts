/** Executes the plugin behavior suite and emits its oracle marker only when Vitest exits successfully. */
import { spawnSync } from "node:child_process";

const result = spawnSync("vitest", ["run", "--config", "vitest.config.ts"], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("access plugin verification passed");
