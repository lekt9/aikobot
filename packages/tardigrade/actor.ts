/**
 * Build and lint entry for the Eliza actor. `tdg build actor.ts` bundles this
 * definition; hosts bind the turn configuration through `ElizaTurnServices`.
 */

import { elizaActor } from "./src/actor";

export default elizaActor({ name: "eliza" });
