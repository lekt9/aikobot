/**
 * Exercises the production development file boundary with real Vite authorization
 * and transforms. Evaluating only the trusted fs expression avoids loading app
 * environment files or booting unrelated plugins; private paths are never read.
 */
import { describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createServer,
  type FileSystemServeOptions,
  isFileServingAllowed,
  resolveConfig,
} from "vite";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const elizaRoot = path.resolve(here, "../..");
const accessRoot = path.resolve(elizaRoot, "../access");
const bunLinkedPackageCacheRoot = path.join(
  os.homedir(),
  ".bun/install/cache/links",
);

function productionFilesystemOptions(): FileSystemServeOptions {
  const configPath = path.join(here, "vite.config.ts");
  const source = ts.createSourceFile(
    configPath,
    fs.readFileSync(configPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "server" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === "fs"
        ) {
          assert.equal(
            expression,
            undefined,
            "one production server.fs boundary",
          );
          expression = property.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, "production server.fs expression exists");
  return runInNewContext(`(${expression.getText(source)})`, {
    fs,
    path,
    here,
    elizaRoot,
    bunLinkedPackageCacheRoot,
  });
}

const privatePaths = [
  ".dev.vars",
  ".dev.vars.local",
  ".env",
  ".env.local",
  ".wrangler/state/default/database.sqlite",
  ".state/accounts.json",
  "src/vault/index.ts",
  "src/ui/server.ts",
];

const accessAliases = [
  path.join(elizaRoot, "node_modules/access"),
  path.join(here, "node_modules/access"),
  path.join(elizaRoot, "packages/ui/node_modules/access"),
  path.join(elizaRoot, "plugins/plugin-access/node_modules/access"),
];

function expectPrivatePathsDenied(
  config: Awaited<ReturnType<typeof resolveConfig>>,
) {
  for (const base of [accessRoot, ...accessAliases]) {
    for (const relative of privatePaths) {
      expect(
        isFileServingAllowed(config, `/@fs${path.join(base, relative)}`),
      ).toBe(false);
    }
  }
}

describe("Access development file boundary", () => {
  it("denies sibling private paths while retaining the app and public client sources", async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        envFile: false,
        root: here,
        logLevel: "silent",
        server: { fs: productionFilesystemOptions() },
      },
      "serve",
    );
    expectPrivatePathsDenied(config);
    const defaults = await resolveConfig(
      { configFile: false, envFile: false, root: here, logLevel: "silent" },
      "serve",
    );
    // Vite upgrades must not silently lose a newly added default protection.
    for (const pattern of defaults.server.fs.deny) {
      expect(config.server.fs.deny).toContain(pattern);
    }
    for (const file of [
      path.join(here, "src/access-client.ts"),
      path.join(elizaRoot, "package.json"),
      path.join(accessRoot, "src/client/index.ts"),
      path.join(accessRoot, "src/client/contracts.ts"),
      path.join(accessRoot, "src/ui/schema.ts"),
    ]) {
      expect(isFileServingAllowed(config, `/@fs${file}`)).toBe(true);
    }
    if (fs.existsSync(bunLinkedPackageCacheRoot)) {
      expect(
        isFileServingAllowed(
          config,
          `/@fs${path.join(bunLinkedPackageCacheRoot, "fixture.js")}`,
        ),
      ).toBe(true);
    }
  });

  it("transforms the real app adapter, Access SDK and credential schema without authorizing private files", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "access-vite-fs-"));
    const server = await createServer({
      configFile: false,
      envFile: false,
      root: here,
      publicDir: false,
      cacheDir,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
        fs: productionFilesystemOptions(),
      },
    });
    try {
      expectPrivatePathsDenied(server.config);
      for (const file of [
        path.join(here, "src/access-client.ts"),
        path.join(accessRoot, "src/client/index.ts"),
        path.join(accessRoot, "src/client/contracts.ts"),
        path.join(accessRoot, "src/ui/schema.ts"),
      ]) {
        const transformed = await server.transformRequest(`/@fs${file}`);
        expect(transformed?.code.length).toBeGreaterThan(0);
      }
      expectPrivatePathsDenied(server.config);
    } finally {
      await server.close();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);
});
