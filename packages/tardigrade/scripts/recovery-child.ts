/**
 * Child process for the restart-recovery proof. Phase "crash" runs a turn whose
 * TODO mutation persists to the store file and then blocks forever after
 * writing a marker, so the parent can SIGKILL it after the external effect
 * succeeded but before its boundary was recorded. The turn configuration is
 * identical to the parent's recovery host so the recovered transition derives
 * the same key.
 */

import { writeFileSync } from "node:fs";
import { elizaActor } from "../src/actor";
import { createElizaBunHost } from "../src/hosts/bun";
import type { ElizaTurnConfig } from "../src/turn";
import {
  fileTodoStore,
  recordingDeliveryPort,
  scriptedModelPort,
  testPlugins,
} from "../tests/support";

const [storage, storeFile, markerFile] = process.argv.slice(2);
if (!storage || !storeFile || !markerFile) {
  throw new Error(
    "usage: recovery-child.ts <storage> <storeFile> <markerFile>",
  );
}

export const RECOVERY_SCRIPT = {
  candidateActionNames: ["TODO"],
  replyText: "",
  plans: [
    {
      action: "TODO",
      parameters: { action: "create", content: "water the plants" },
    },
  ],
  finishText: "Added water the plants to your list.",
};

const store = fileTodoStore({
  path: storeFile,
  afterApply: async (key) => {
    writeFileSync(markerFile, key);
    await new Promise<never>(() => {});
  },
});
const config: ElizaTurnConfig = {
  agentKey: "eliza-recovery",
  character: { name: "Tardiza", system: "You are Tardiza." },
  plugins: testPlugins({ store }).plugins,
  model: scriptedModelPort(RECOVERY_SCRIPT),
  delivery: recordingDeliveryPort(),
  host: { bindings: [], secrets: [] },
};
const host = await createElizaBunHost({
  actor: elizaActor({ name: "eliza-recovery" }),
  storage,
  config,
});
const thread = await host.allocateRootThread({
  instance: "owner-1",
  name: "main",
});
writeFileSync(`${markerFile}.thread`, JSON.stringify(thread.coordinate));
await thread.methods.message(
  { text: "remind me to water the plants", input: { owner: "owner-1" } },
  { key: "call-1" },
);
throw new Error("the crash phase must never complete a turn");
