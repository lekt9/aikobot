#!/usr/bin/env bun
/** Builds the plugin and native discovery predicate with the shared repository driver. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-access",
  clean: true,
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: ["src/index.ts", "src/auto-enable.ts"],
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  rewriteDistImports: true,
});
