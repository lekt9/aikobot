/**
 * Owner identity for multi-owner hosts. An authenticated owner reaches only
 * actor instances whose name embeds that owner (`user.<owner>.<instance>`,
 * both parts base64url), and the Durable Object namespaces a Worker hands to
 * Tardigrade are wrapped so a coordinate naming another owner is refused
 * before any object opens. Single-owner deployments keep plain instance
 * names; `ownerOfInstance` treats a plain name as its own owner, which is
 * how the pipeline actor's owner claim keeps binding to the instance.
 *
 * The scheme follows the access repository's Cloudflare identity module
 * (`src/cloudflare/identity.ts`) so Aiko can address both hosts alike.
 */

import { ElizaError } from "@elizaos/core/edge";
import { Context } from "effect";

export const TARDIGRADE_OWNER_INVALID = "TARDIGRADE_OWNER_INVALID";
export const TARDIGRADE_INSTANCE_UNSCOPED = "TARDIGRADE_INSTANCE_UNSCOPED";
export const TARDIGRADE_FOREIGN_OWNER = "TARDIGRADE_FOREIGN_OWNER";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
const SCOPED_INSTANCE = /^user\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The owner an actor thread belongs to, supplied per thread by the host. */
export class ElizaOwner extends Context.Service<
  ElizaOwner,
  { readonly owner: string; readonly scoped: boolean }
>()("elizaos/tardigrade/Owner") {}

/** Accepts the owner alphabet shared with Aiko owner tokens. */
export function validateOwner(owner: unknown): string {
  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    throw new ElizaError("Owner identity is not a valid owner id", {
      code: TARDIGRADE_OWNER_INVALID,
      context: { owner: typeof owner === "string" ? owner : typeof owner },
    });
  }
  return owner;
}

function encodeSegment(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeSegment(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  const decoded = decoder.decode(bytes);
  if (encodeSegment(decoded) !== value) {
    throw new ElizaError("Actor instance segment is not canonical base64url", {
      code: TARDIGRADE_INSTANCE_UNSCOPED,
      context: { segment: value },
    });
  }
  return decoded;
}

/** The owner-scoped actor instance name the public API maps a caller onto. */
export function userInstance(owner: string, instance: string): string {
  validateOwner(owner);
  if (!instance || instance.length > 200 || instance.includes("/")) {
    throw new ElizaError("Actor instance name is invalid", {
      code: TARDIGRADE_INSTANCE_UNSCOPED,
      context: { instance },
    });
  }
  return `user.${encodeSegment(owner)}.${encodeSegment(instance)}`;
}

/** True when an instance name carries an owner scope. */
export function isScopedInstance(instance: string): boolean {
  return SCOPED_INSTANCE.test(instance);
}

/** The owner embedded in a scoped instance name; an unscoped name is refused. */
export function instanceOwner(instance: string): string {
  const parts = SCOPED_INSTANCE.exec(instance);
  if (parts === null) {
    throw new ElizaError("Actor instance carries no owner scope", {
      code: TARDIGRADE_INSTANCE_UNSCOPED,
      context: { instance },
    });
  }
  decodeSegment(parts[2] as string);
  return validateOwner(decodeSegment(parts[1] as string));
}

/** The caller-facing instance name inside a scoped instance name. */
export function instanceName(instance: string): string {
  const parts = SCOPED_INSTANCE.exec(instance);
  if (parts === null) return instance;
  return decodeSegment(parts[2] as string);
}

/** The owner a thread belongs to: the scope when present, else the plain instance. */
export function ownerOfInstance(instance: string): string {
  return isScopedInstance(instance) ? instanceOwner(instance) : instance;
}

/**
 * The owner of a Durable Object by its named coordinate. Tardigrade names
 * actor and thread objects with the JSON coordinate `[actor, instance, ...]`;
 * a raw or unscoped identity has no owner and is refused.
 */
export function objectOwner(name: string | undefined): string {
  let coordinate: unknown = null;
  try {
    coordinate = JSON.parse(name ?? "null");
  } catch {
    // error-policy:J3 A non-JSON object name is an invalid identity, reported below.
    coordinate = null;
  }
  if (!Array.isArray(coordinate) || typeof coordinate[1] !== "string") {
    throw new ElizaError("Durable Object identity is not a named coordinate", {
      code: TARDIGRADE_INSTANCE_UNSCOPED,
      context: { name: name ?? null },
    });
  }
  return instanceOwner(coordinate[1]);
}

/** True when a Durable Object coordinate names an owner-scoped instance. */
export function isScopedObject(name: string | undefined): boolean {
  try {
    const coordinate: unknown = JSON.parse(name ?? "null");
    return (
      Array.isArray(coordinate) &&
      typeof coordinate[1] === "string" &&
      isScopedInstance(coordinate[1])
    );
  } catch {
    // error-policy:J3 A non-JSON object name is simply not a scoped coordinate.
    return false;
  }
}

interface NamedNamespace {
  getByName(name: string, ...rest: unknown[]): unknown;
}

/**
 * Wraps a Durable Object namespace so only coordinates of `owner` resolve.
 * Tardigrade addresses objects by name; raw ids and unchecked lookups are
 * refused because they carry no owner.
 */
export function scopedNamespace<T extends object>(
  namespace: T,
  owner: string,
): T {
  validateOwner(owner);
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "getByName") {
        return (name: string, ...rest: unknown[]) => {
          const actual = objectOwner(name);
          if (actual !== owner) {
            throw new ElizaError("Durable Object route names another owner", {
              code: TARDIGRADE_FOREIGN_OWNER,
              context: { owner, name },
            });
          }
          return (target as unknown as NamedNamespace).getByName(name, ...rest);
        };
      }
      if (
        property === "get" ||
        property === "idFromName" ||
        property === "idFromString" ||
        property === "newUniqueId"
      ) {
        return () => {
          throw new ElizaError("Unscoped Durable Object lookup refused", {
            code: TARDIGRADE_FOREIGN_OWNER,
            context: { owner, lookup: String(property) },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
