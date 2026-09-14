/**
 * The deployed native actor. Tardigrade owns the loop; elizaOS contributes
 * the character, its providers, its plugins as code-mode packages, its
 * evaluators, and its scheduled work. Build it with
 * `bun scripts/tdg.mjs build native-actor.ts`; the Cloudflare entry is
 * `worker-native.ts`, which supplies each thread's owner and owner runtime.
 *
 * The character is the deployment's, not a caller's: an actor definition is
 * static, so a per-owner character belongs in the owner's runtime rather
 * than here.
 */

import { DEFAULT_ELIZA_TARDIGRADE_CHARACTER } from "./src/hosts/config";
import { elizaNativeActor } from "./src/native/actor";

export default elizaNativeActor({
  name: "eliza",
  character: {
    name: DEFAULT_ELIZA_TARDIGRADE_CHARACTER.name,
    bio: [DEFAULT_ELIZA_TARDIGRADE_CHARACTER.system ?? ""],
    system: DEFAULT_ELIZA_TARDIGRADE_CHARACTER.system ?? "",
  },
});
