/**
 * Owner isolation and authorization proof on a real Bun host: an OWNER-gated
 * action is offered to and executed for the owner, withheld from a GUEST
 * sender in the same thread, per-owner instances never share history, and a
 * foreign owner's message fails durably.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Plugin } from "@elizaos/core/edge";
import { hostBackend } from "tardie/bun/create-host";
import { elizaActor } from "../src/actor";
import { declarePlugin } from "../src/compatibility";
import { turnOutputDelivery } from "../src/delivery";
import { createElizaBunHost, type ElizaBunHost } from "../src/hosts/bun";
import {
  HOST_TODOS_COMPATIBILITY,
  scriptedModelPort,
  testPlugins,
  testStorageDir,
} from "./support";

const opened: Array<{ host: ElizaBunHost; storage: string }> = [];

function ownerNotesPlugin(notes: string[]): Plugin {
  return {
    name: "owner-notes",
    description: "Private notes only the owner may record.",
    actions: [
      {
        name: "OWNER_NOTE",
        description: "Record a private note for the owner.",
        similes: ["PRIVATE_NOTE"],
        tags: ["capability:write", "effect:idempotent"],
        roleGate: { minRole: "OWNER" },
        contexts: ["general"],
        parameters: [
          {
            name: "note",
            description: "The note text.",
            required: true,
            schema: { type: "string" },
          },
        ],
        validate: async () => true,
        handler: async (_runtime, _message, _state, options, callback) => {
          const note = String(
            (options as { parameters?: { note?: unknown } })?.parameters
              ?.note ?? "",
          );
          notes.push(note);
          await callback?.({ text: `Noted: ${note}` });
          return {
            success: true,
            text: `Noted: ${note}`,
            data: { actionName: "OWNER_NOTE", note },
          };
        },
      },
    ],
  };
}

async function openHost(notes: string[]) {
  const storage = testStorageDir("eliza-tardigrade-authz-");
  const model = scriptedModelPort({
    candidateActionNames: ["OWNER_NOTE"],
    replyText: "",
    plans: [
      { action: "OWNER_NOTE", parameters: { note: "the safe code is 4411" } },
    ],
    finishText: "I recorded your note.",
  });
  const host = await createElizaBunHost({
    actor: elizaActor({ name: "eliza-authz" }),
    storage,
    config: {
      agentKey: "eliza-authz",
      character: { name: "Tardiza", system: "You are Tardiza." },
      plugins: [
        ...testPlugins().plugins,
        declarePlugin(ownerNotesPlugin(notes), {
          ...HOST_TODOS_COMPATIBILITY,
          state: "test-notes",
        }),
      ],
      model,
      delivery: turnOutputDelivery,
      host: { bindings: [], secrets: [] },
    },
  });
  opened.push({ host, storage });
  return { host, model };
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.host.close();
    rmSync(entry.storage, { recursive: true, force: true });
  }
});

const offeredTools = (
  requests: ReturnType<typeof scriptedModelPort>["requests"],
  marker: string,
) =>
  requests
    .filter((request) => JSON.stringify(request).includes(marker))
    .flatMap((request) => (request.tools ?? []).map((tool) => tool.name));

describe("owner isolation and authorization", () => {
  test("an OWNER-gated action runs for the owner and is withheld from a guest sender", async () => {
    const notes: string[] = [];
    const { host, model } = await openHost(notes);
    const thread = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    const ownerReply = await thread.methods.message(
      { text: "owner-turn note the safe code", input: { owner: "owner-1" } },
      { key: "owner-turn" },
    );
    expect(notes).toEqual(["the safe code is 4411"]);
    expect(ownerReply.length).toBeGreaterThan(0);
    expect(offeredTools(model.requests, "owner-turn note")).toContain(
      "OWNER_NOTE",
    );

    const guestReply = await thread.methods.message(
      {
        text: "guest-turn note the safe code",
        input: { owner: "owner-1", sender: "guest-7" },
      },
      { key: "guest-turn" },
    );
    expect(notes).toEqual(["the safe code is 4411"]);
    expect(guestReply.length).toBeGreaterThan(0);
    expect(offeredTools(model.requests, "guest-turn note")).not.toContain(
      "OWNER_NOTE",
    );
    const events = [
      ...(await (
        await hostBackend(host).ensure("owner-1")
      ).read(thread.coordinate.thread)),
    ] as Array<Record<string, unknown>>;
    const actionBoundaries = events.filter(
      (event) =>
        event.type === "ElizaBoundaryStarted" && event.kind === "action",
    );
    expect(actionBoundaries.map((event) => [event.turn, event.name])).toEqual([
      ["owner-turn", "OWNER_NOTE"],
    ]);
    expect(
      events
        .filter((event) => event.type === "TurnCompleted")
        .map((event) => event.turn),
    ).toEqual(["owner-turn", "guest-turn"]);
  });

  test("per-owner instances never share history and a foreign owner fails durably", async () => {
    const { host, model } = await openHost([]);
    const one = await host.allocateRootThread({
      instance: "owner-1",
      name: "main",
    });
    await one.methods.message(
      { text: "owner-one-secret-marker", input: { owner: "owner-1" } },
      { key: "o1-call" },
    );
    const two = await host.allocateRootThread({
      instance: "owner-2",
      name: "main",
    });
    await two.methods.message(
      { text: "owner-two-hello", input: { owner: "owner-2" } },
      { key: "o2-call" },
    );
    const twoRequests = model.requests.filter((request) =>
      JSON.stringify(request).includes("owner-two-hello"),
    );
    expect(twoRequests.length).toBeGreaterThan(0);
    expect(
      twoRequests.every(
        (request) =>
          !JSON.stringify(request).includes("owner-one-secret-marker"),
      ),
    ).toBe(true);
    await expect(
      one.methods.message(
        { text: "intrude", input: { owner: "owner-2" } },
        { key: "intrusion" },
      ),
    ).rejects.toThrow("TARDIGRADE_OWNER_INSTANCE_MISMATCH");
    const intrusionRequests = model.requests.filter((request) =>
      JSON.stringify(request).includes("intrude"),
    );
    expect(intrusionRequests).toHaveLength(0);
    const events = [
      ...(await (
        await hostBackend(host).ensure("owner-1")
      ).read(one.coordinate.thread)),
    ] as Array<Record<string, unknown>>;
    const failed = events.find((event) => event.type === "TurnFailed");
    expect(failed?.turn).toBe("intrusion");
    expect(failed?.cause).toBe("message_invalid");
  });
});
