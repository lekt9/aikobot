/**
 * The character as the actor's instructions. elizaOS renders a character
 * into a system prompt through its own template; the native composition
 * needs one deterministic string, so this renders the same fields — name,
 * system prompt, bio, topics, style — in a fixed order with nothing dropped.
 * It is a pure function of the character, which keeps the actor's system view
 * stable across replay.
 *
 * The text is a single `system(...)` contribution. Provider output is a
 * separate contribution from `elizaContextComponent`, so what the character
 * says and what the world says stay distinguishable in the rendered prompt.
 */

import type { Character } from "@elizaos/core/edge";
import type { AgentComponent } from "tardie/agent";
import { system } from "tardie/agent";

function lines(value: string | ReadonlyArray<string> | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

/** The complete character, rendered once, in a fixed order. */
export function characterInstructions(character: Character): string {
  const sections: string[] = [];
  const name = character.name?.trim();
  if (name) sections.push(`You are ${name}.`);
  const prompt = lines(character.system);
  if (prompt.length > 0) sections.push(prompt.join("\n"));
  const bio = lines(character.bio as string | string[] | undefined);
  if (bio.length > 0) {
    sections.push(`About you:\n${bio.map((entry) => `- ${entry}`).join("\n")}`);
  }
  const topics = lines(character.topics as string[] | undefined);
  if (topics.length > 0) sections.push(`Topics you know: ${topics.join(", ")}`);
  const style = character.style as
    | { all?: string[]; chat?: string[] }
    | undefined;
  const styleLines = [...lines(style?.all), ...lines(style?.chat)];
  if (styleLines.length > 0) {
    sections.push(
      `How you write:\n${styleLines.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  const adjectives = lines(character.adjectives as string[] | undefined);
  if (adjectives.length > 0) {
    sections.push(`You come across as ${adjectives.join(", ")}.`);
  }
  return sections.join("\n\n");
}

/** The character as a native `system` component. */
export function characterComponent(
  character: Character,
): AgentComponent<never> {
  return system(characterInstructions(character), { name: "eliza-character" });
}
