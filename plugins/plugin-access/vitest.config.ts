/** Runs the plugin contracts using the repository's canonical workspace source aliases. */
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    root: import.meta.dirname,
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
