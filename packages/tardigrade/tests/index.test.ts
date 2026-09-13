/**
 * Public-entry contract: the package's main barrel loads at runtime on Bun
 * (no Workers-only module reaches it) and exposes the actor, ports, journal,
 * and error codes; the Cloudflare host is reachable only through its subpath.
 */

import { describe, expect, test } from "bun:test";

describe("public entry", () => {
  test("the main barrel imports on Bun and exposes the adapter surface", async () => {
    const entry = await import("../src/index");
    expect(typeof entry.elizaActor).toBe("function");
    expect(typeof entry.createElizaBunHost).toBe("function");
    expect(typeof entry.createBoundaryRecorder).toBe("function");
    expect(typeof entry.createOpenAICompatibleModelPort).toBe("function");
    expect(typeof entry.kvTodoStore).toBe("function");
    expect(entry.TARDIGRADE_TURN_MODEL_FAILED).toBe(
      "TARDIGRADE_TURN_MODEL_FAILED",
    );
    expect(entry.TARDIGRADE_OWNER_INSTANCE_MISMATCH).toBe(
      "TARDIGRADE_OWNER_INSTANCE_MISMATCH",
    );
    expect(entry.TARDIGRADE_EFFECT_OUTCOME_UNKNOWN).toBe(
      "TARDIGRADE_EFFECT_OUTCOME_UNKNOWN",
    );
    expect("defineElizaWorkerHost" in entry).toBe(false);
  });

  test("the cloudflare subpath is the only entry that needs the Workers runtime", async () => {
    const failure = await import("../src/cloudflare").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain("cloudflare:workers");
  });
});
