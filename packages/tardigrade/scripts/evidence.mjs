#!/usr/bin/env bun

/**
 * Builds the evaluate-product evidence manifest for this package. It gathers
 * the recorded smoke, journey, perf, and deploy traces plus the independent
 * review traces under artifacts/evaluate-product, records their hashes, runs
 * the package test suite once into a trace artifact, and freezes the tree
 * fingerprint through the evaluator itself. Evaluation-time checks write only
 * into artifacts/evaluate-product/run, which the evaluator excludes from the
 * fingerprint, so a green report can never be produced by mutating the tree.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDir, "..", "..");
const evaluator =
  process.env.EVALUATE_PRODUCT_SCRIPT ??
  "/home/deck/jesus-pattern/skills/evaluate-product/scripts/evaluate_product.py";
const artifactsDir = join(root, "artifacts", "evaluate-product");
const runDir = join(artifactsDir, "run");
mkdirSync(runDir, { recursive: true });

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const rel = (path) => path.slice(root.length + 1);
const artifact = (path) => {
  if (!existsSync(path) || readFileSync(path).length === 0)
    throw new Error(`artifact is absent or empty: ${rel(path)}`);
  return { path: rel(path), sha256: sha256(path) };
};

const deploy = JSON.parse(
  readFileSync(join(packageDir, ".tardigrade", "deploy.json"), "utf8"),
);
for (const name of [
  "smoke-workerd.json",
  "smoke-deployed.json",
  "journey.json",
  "perf.json",
  "deploy.json",
]) {
  const source = join(packageDir, ".tardigrade", name);
  if (!existsSync(source))
    throw new Error(
      `recorded evidence is absent: packages/tardigrade/.tardigrade/${name}`,
    );
  copyFileSync(source, join(artifactsDir, name));
}

// perf.json must describe the very smoke trace hashed beside it.
const perf = spawnSync(
  "bun",
  ["scripts/perf.mjs", join(artifactsDir, "smoke-deployed.json"), "120000"],
  {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, ELIZA_TARDIGRADE_EVIDENCE_DIR: artifactsDir },
  },
);
if (perf.status !== 0)
  throw new Error(`perf regeneration failed: ${perf.stdout}${perf.stderr}`);

const tests = spawnSync("bun", ["test", "tests"], {
  cwd: packageDir,
  encoding: "utf8",
});
writeFileSync(
  join(artifactsDir, "tests.trace"),
  `${tests.stdout}\n${tests.stderr}`,
);
if (tests.status !== 0)
  throw new Error("package tests failed while recording the test trace");

const surfaceScan = spawnSync(
  "bash",
  [
    "-o",
    "pipefail",
    "-c",
    "find packages/tardigrade -path '*/node_modules' -prune -o \\( -name '*.tsx' -o -name '*.html' -o -name '*.css' \\) -print | wc -l",
  ],
  { cwd: root, encoding: "utf8" },
);
const surfaceCount = surfaceScan.stdout.trim();
const noVisualSurface = [
  "@elizaos/tardigrade exposes no visual interface: operators use the tdg CLI, the Tardigrade HTTP API, and Durable Object traces.",
  `Scan on ${new Date().toISOString()}: ${surfaceCount} .tsx/.html/.css files under packages/tardigrade (node_modules pruned).`,
  "Rendering, layout, and assistive-technology semantics therefore have no surface to evaluate in this package.",
].join("\n");
writeFileSync(
  join(artifactsDir, "no-visual-surface.txt"),
  `${noVisualSurface}\n`,
);

/** `CRITICAL:` lines in a review trace are unresolved findings that block release. */
const criticalFindingsOf = (dimension) => {
  const path = join(artifactsDir, `review-${dimension}.trace`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => /^CRITICAL:/u.test(line.trim()))
    .map(
      (line) => `${dimension}: ${line.trim().slice("CRITICAL:".length).trim()}`,
    );
};

const reviewScore = (dimension) => {
  const path = join(artifactsDir, `review-${dimension}.trace`);
  if (!existsSync(path))
    throw new Error(`independent review trace is absent: ${rel(path)}`);
  const match = /SCORE:\s*(\d+)/u.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error(`review trace has no SCORE line: ${rel(path)}`);
  return { path, score: Number(match[1]) };
};

const requirements = [
  "A real read action (WEB_SEARCH) and a real state-changing action (todo create) run through declared-compatible plugins on the genuine edge AgentRuntime.",
  "Restart recovery: a host killed after an external effect succeeded but before its boundary record committed resumes on fresh storage with exactly one effect and one delivery.",
  "Duplicate inbound delivery (same call key, re-delivered event) and repeated operation requests execute once.",
  "Owner isolation: a thread binds to one owner, per-owner instances never share history, a foreign owner fails durably, and role-gated actions are withheld from guests.",
  "Complete context: projected history and the current message reach the model verbatim and in order with providers, actions, and evaluators live; no compaction or truncation.",
  "The built actor runs under workerd and as a deployed Cloudflare Worker whose durable traces are read back and inspected.",
  "Scheduling stays on core TaskService.runDueTasks driven by host wakeups over log-projected task rows; no competing scheduler.",
  "Unsupported plugin requirements and unknown effect outcomes fail explicitly with typed errors.",
];
const canonicalHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const url = deploy.url;
// The evaluator runs each check from the repository root; resolve the excluded
// run directory before the `cd` so evaluation-time evidence never lands inside
// the fingerprinted package tree.
const runEnv =
  'RUN_DIR="$PWD/artifacts/evaluate-product/run"; export ELIZA_TARDIGRADE_EVIDENCE_DIR="$RUN_DIR"';
const inPackage = (command) =>
  `${runEnv} && cd packages/tardigrade && ${command}`;
const deployedSmoke = inPackage(`bun scripts/smoke.mjs deployed "${url}"`);
const journey = inPackage(`bun scripts/journey.mjs "${url}"`);
const testsIn = (files) => inPackage(`bun test ${files}`);

const qualitative = Object.fromEntries(
  [
    "requirements",
    "agent_experience",
    "user_experience",
    "cross_layer_journeys",
    "frontend",
    "accessibility",
  ].map((dimension) => [dimension, reviewScore(dimension)]),
);
const review = (dimension) => ({
  builder: "claude-builder",
  reviewer: "independent-review-agent",
  trace_path: rel(qualitative[dimension].path),
});
const reviewArtifact = (dimension) => artifact(qualitative[dimension].path);

const dimensions = {
  requirements: {
    status: "pass",
    score: qualitative.requirements.score,
    checks: [
      {
        command:
          "test -s packages/tardigrade/docs/assessment.md && test -s packages/tardigrade/README.md && grep -q 'recovery.test.ts' packages/tardigrade/README.md && grep -q 'scheduling.test.ts' packages/tardigrade/README.md",
        timeout_seconds: 30,
      },
    ],
    artifacts: [
      reviewArtifact("requirements"),
      artifact(join(packageDir, "docs", "assessment.md")),
    ],
    independent_review: review("requirements"),
  },
  tests_evals: {
    status: "pass",
    score: 9,
    checks: [{ command: testsIn("tests"), timeout_seconds: 600 }],
    artifacts: [artifact(join(artifactsDir, "tests.trace"))],
  },
  agent_experience: {
    status: "pass",
    score: qualitative.agent_experience.score,
    checks: [
      {
        command: inPackage(
          `bun scripts/tdg.mjs methods --actor smoke-owner --url "${url}" --json | grep -q runDueTasks`,
        ),
        timeout_seconds: 60,
      },
    ],
    artifacts: [
      reviewArtifact("agent_experience"),
      artifact(join(packageDir, "README.md")),
    ],
    independent_review: review("agent_experience"),
  },
  user_experience: {
    status: "pass",
    score: qualitative.user_experience.score,
    checks: [{ command: deployedSmoke, timeout_seconds: 400 }],
    artifacts: [
      reviewArtifact("user_experience"),
      artifact(join(artifactsDir, "smoke-deployed.json")),
    ],
    independent_review: review("user_experience"),
  },
  frontend: {
    status: "not_applicable",
    rationale: noVisualSurface.split("\n")[0],
    checks: [
      {
        command:
          "test \"$(find packages/tardigrade -path '*/node_modules' -prune -o \\( -name '*.tsx' -o -name '*.html' -o -name '*.css' \\) -print | wc -l)\" = 0 && echo NO-VISUAL-SURFACE",
        timeout_seconds: 30,
      },
    ],
    artifacts: [
      reviewArtifact("frontend"),
      artifact(join(artifactsDir, "no-visual-surface.txt")),
    ],
    independent_review: review("frontend"),
  },
  backend: {
    status: "pass",
    score: 8,
    checks: [
      {
        command: testsIn(
          "tests/actor.test.ts tests/turn.test.ts tests/scheduling.test.ts",
        ),
        timeout_seconds: 600,
      },
    ],
    artifacts: [
      artifact(join(artifactsDir, "tests.trace")),
      artifact(join(artifactsDir, "smoke-workerd.json")),
    ],
  },
  api_data: {
    status: "pass",
    score: 8,
    checks: [{ command: journey, timeout_seconds: 400 }],
    artifacts: [artifact(join(artifactsDir, "journey.json"))],
  },
  accessibility: {
    status: "not_applicable",
    rationale: noVisualSurface.split("\n")[0],
    checks: [
      {
        command:
          "test \"$(find packages/tardigrade -path '*/node_modules' -prune -o \\( -name '*.tsx' -o -name '*.html' -o -name '*.css' \\) -print | wc -l)\" = 0 && echo NO-VISUAL-SURFACE",
        timeout_seconds: 30,
      },
    ],
    artifacts: [
      reviewArtifact("accessibility"),
      artifact(join(artifactsDir, "no-visual-surface.txt")),
    ],
    independent_review: review("accessibility"),
  },
  security: {
    status: "pass",
    score: 8,
    checks: [
      {
        command: testsIn(
          "tests/authorization.test.ts tests/idempotency.test.ts",
        ),
        timeout_seconds: 300,
      },
      {
        command: `test "$(curl -s -o /dev/null -w '%{http_code}' -X POST '${url}/v1/actors/probe/threads' -H 'content-type: application/json' -d '{}')" = 401 && echo UNAUTHENTICATED-REFUSED`,
        timeout_seconds: 60,
      },
    ],
    artifacts: [
      artifact(join(artifactsDir, "tests.trace")),
      artifact(join(artifactsDir, "journey.json")),
    ],
  },
  performance: {
    status: "pass",
    score: 8,
    checks: [
      {
        command: inPackage(
          `bun scripts/perf.mjs "$RUN_DIR/../smoke-deployed.json" 120000`,
        ),
        timeout_seconds: 60,
      },
    ],
    artifacts: [
      artifact(join(artifactsDir, "perf.json")),
      artifact(join(artifactsDir, "smoke-deployed.json")),
    ],
  },
  reliability_recovery: {
    status: "pass",
    score: 9,
    checks: [
      {
        command: testsIn("tests/recovery.test.ts tests/idempotency.test.ts"),
        timeout_seconds: 300,
      },
    ],
    artifacts: [artifact(join(artifactsDir, "tests.trace"))],
  },
  deployment_operability: {
    status: "pass",
    score: 8,
    checks: [
      {
        command: `curl -fsS "${url}/healthz" >/dev/null && curl -fsS "${url}/" | grep -q '"product":"@elizaos/tardigrade"' && echo DEPLOYMENT-IDENTIFIED`,
        timeout_seconds: 60,
      },
    ],
    artifacts: [
      artifact(join(artifactsDir, "deploy.json")),
      artifact(join(packageDir, "wrangler.jsonc")),
    ],
  },
  cross_layer_journeys: {
    status: "pass",
    score: qualitative.cross_layer_journeys.score,
    checks: [{ command: journey, timeout_seconds: 400 }],
    artifacts: [
      reviewArtifact("cross_layer_journeys"),
      artifact(join(artifactsDir, "journey.json")),
    ],
    independent_review: review("cross_layer_journeys"),
  },
};

const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const fingerprint = spawnSync(
  "python3",
  [evaluator, "--root", ".", "--fingerprint"],
  { cwd: root, encoding: "utf8" },
);
if (fingerprint.status !== 0)
  throw new Error(`fingerprint failed: ${fingerprint.stderr}`);

const evidence = {
  schema_version: 1,
  scope: {
    product: "@elizaos/tardigrade",
    requirements_source: "packages/tardigrade/docs/assessment.md",
  },
  configuration: { profile: "durable-execution-adapter" },
  environment: { base_url: url, commit, package: "packages/tardigrade" },
  evaluator_capabilities: ["bash", "api", "cli"],
  deploy_target: { url, public: true },
  credentials: {
    status: "available",
    reason:
      "TARDIGRADE_TOKEN and the Codegraff gateway key are exported from packages/tardigrade/.dev.vars for the evaluation shell; Cloudflare access is the wrangler OAuth login.",
  },
  requirements: { items: requirements, sha256: canonicalHash(requirements) },
  tree_fingerprint: fingerprint.stdout.trim(),
  dimensions,
  critical_findings: Object.keys(qualitative).flatMap(criticalFindingsOf),
  journeys: [
    {
      name: "bearer login and its failure branches, TODO create and read-back through the live model on the deployed Worker, duplicate delivery, runDueTasks wakeup, refused foreign owner, durable trace read-back",
      layers: [
        "tdg-cli",
        "http-api",
        "durable-object-log",
        "model-provider",
        "public-deployment",
      ],
      failure_branch: true,
      login: true,
      primary_workflow: true,
      crud: true,
      public_deployment: true,
      read_back: true,
      checks: [
        {
          command: `curl -fsS "${url}/healthz" >/dev/null && curl -fsS "${url}/" | grep -q '"product":"@elizaos/tardigrade"' && echo JOURNEY-HOST-REACHED`,
          timeout_seconds: 60,
        },
        { command: journey, timeout_seconds: 400 },
      ],
    },
  ],
};
const outDir = join(root, ".claude", "evaluate-product");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `evidence manifest written: ${rel(join(outDir, "evidence.json"))} (fingerprint ${evidence.tree_fingerprint.slice(0, 12)})`,
);
