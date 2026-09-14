/**
 * Invariants of the native composition itself, checked against Tardigrade's
 * own validators rather than by reading our source: the actor satisfies the
 * runtime's actor contract, it mounts no compaction, and it declares the
 * render policy that makes model-facing content lossless. The compaction
 * control proves the context check measures a real mechanism — the runtime
 * refuses two components that declare the same context field differently.
 */

import { describe, expect, test } from "bun:test";
import type { Character } from "@elizaos/core/edge";
import { compaction, infer, outputValidateOnce, system } from "tardie";
import type { AgentView } from "tardie/agent";
import { validateActor } from "tardie/core/actor";
import type { Component } from "tardie/core/component";
import { elizaNativeActor, NEVER_SPILL_BYTES } from "../src/native/actor";
import { characterComponent } from "../src/native/character";
import { LOSSLESS_RENDER_CAP, losslessContext } from "../src/native/context";

const character: Character = {
  name: "Eliza",
  bio: ["composes natively"],
  system: "Be brief.",
  topics: ["lists"],
  style: { all: ["plain"], chat: ["short"] },
};

type AgentComponentLike = Component<AgentView, unknown>;

const rootView = (): AgentView => {
  const actor = elizaNativeActor({ character });
  const root = actor.components[0] as unknown as AgentComponentLike;
  return root.machine.output(root.machine.initial()).view;
};

const componentNames = (): string[] => {
  const actor = elizaNativeActor({ character });
  const ids = (
    actor.components as unknown as ReadonlyArray<Record<symbol, unknown>>
  )
    .flatMap((component) =>
      Object.getOwnPropertySymbols(component).flatMap((symbol) => {
        const value = component[symbol];
        return Array.isArray(value) ? (value as string[]) : [];
      }),
    )
    .map(String);
  return [
    ...ids,
    ...(actor.components as unknown as ReadonlyArray<{ name: string }>).map(
      (component) => component.name,
    ),
  ];
};

describe("native composition", () => {
  test("the composed actor satisfies Tardigrade's actor contract", () => {
    const actor = elizaNativeActor({ character });
    expect(actor.name).toBe("eliza");
    expect(Object.keys(actor.methods).sort()).toEqual([
      "message",
      "requestBudget",
      "wake",
    ]);
    expect(() => validateActor(actor as never)).not.toThrow();
  });

  test("the character is rendered into the system view without losing a field", () => {
    const view = rootView();
    const instructions = view.system.join("\n\n");
    expect(instructions).toContain("You are Eliza.");
    expect(instructions).toContain("Be brief.");
    expect(instructions).toContain("composes natively");
    expect(instructions).toContain("lists");
    expect(instructions).toContain("plain");
    expect(instructions).toContain("short");
  });

  test("the only context policy is the lossless one, and both render caps are lifted", () => {
    const view = rootView();
    expect(view.context).toHaveLength(1);
    const fragment = view.context[0];
    expect(fragment?.component).toBe("eliza-lossless-context");
    expect(fragment?.policy).toEqual({
      messageRenderCap: LOSSLESS_RENDER_CAP,
      resultRenderCap: LOSSLESS_RENDER_CAP,
    });
    expect(LOSSLESS_RENDER_CAP).toBe(Number.MAX_SAFE_INTEGER);
    expect(NEVER_SPILL_BYTES).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("no compaction component is mounted, and mounting one would be refused (control)", () => {
    expect(componentNames().join(" ")).not.toContain("compaction");

    // Control: the same composition with compaction added is refused at
    // construction, because two components then declare the same context
    // fields with different values. Without this the assertion above could
    // pass for a composition where nothing declared a policy at all.
    expect(() =>
      infer([
        characterComponent(character),
        losslessContext(),
        compaction(),
        outputValidateOnce,
      ]),
    ).toThrow(/context field/u);

    // And the control's opposite: compaction alone composes fine, so the
    // refusal above is about the conflict, not about compaction being broken.
    expect(() =>
      infer([system("x"), compaction(), outputValidateOnce]),
    ).not.toThrow();
  });

  test("exactly one output strategy is declared", () => {
    const view = rootView();
    expect(view.output).toHaveLength(1);
    expect(() => infer([system("x")])).toThrow(/output strategy/u);
  });
});
