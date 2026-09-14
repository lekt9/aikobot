/**
 * The owner's elizaOS database: core's in-memory adapter with its complete
 * state persisted to the owner's backend. Every Map and Set the adapter owns
 * is snapshotted as one JSON document and restored on open, so entities,
 * rooms, memories, relationships, tasks, and connector state survive process
 * and Durable Object restarts without a second storage contract. The
 * snapshot is written once per owner invocation by the owner runtime.
 *
 * Fail-closed on schema drift: a snapshot field the running adapter does not
 * own, or owns with another container kind, refuses to load rather than
 * silently dropping an owner's data.
 */

import {
  ElizaError,
  InMemoryDatabaseAdapter,
  type UUID,
} from "@elizaos/core/edge";
import type { StateBackend } from "./backend";

export const OWNER_ADAPTER_KEY = "/eliza/adapter.json";
export const TARDIGRADE_STATE_SCHEMA = "TARDIGRADE_STATE_SCHEMA";
const SNAPSHOT_VERSION = 1;

interface Snapshot {
  readonly version: number;
  readonly agentId: string;
  readonly fields: Record<string, unknown>;
}

function encodeValue(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ElizaError("Owner state holds a non-finite number", {
          code: TARDIGRADE_STATE_SCHEMA,
          context: { path },
        });
      }
      return value;
    case "bigint":
    case "function":
    case "symbol":
      throw new ElizaError(
        `Owner state holds a ${typeof value}, which cannot be persisted`,
        {
          code: TARDIGRADE_STATE_SCHEMA,
          context: { path },
        },
      );
    default:
      break;
  }
  if (value instanceof Map) {
    return {
      $map: [...value.entries()].map(([key, entry], index) => [
        encodeValue(key, `${path}[${index}].key`),
        encodeValue(entry, `${path}[${index}]`),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      $set: [...value].map((entry, index) =>
        encodeValue(entry, `${path}{${index}}`),
      ),
    };
  }
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) {
    return value.map((entry, index) => encodeValue(entry, `${path}[${index}]`));
  }
  if (ArrayBuffer.isView(value)) {
    throw new ElizaError(
      "Owner state holds binary data, which cannot be persisted as JSON",
      {
        code: TARDIGRADE_STATE_SCHEMA,
        context: { path },
      },
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ElizaError(
      "Owner state holds a class instance, which cannot be persisted",
      {
        code: TARDIGRADE_STATE_SCHEMA,
        context: { path, constructor: prototype.constructor?.name ?? null },
      },
    );
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    record[key] = encodeValue(entry, `${path}.${key}`);
  }
  return record;
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.$map) && Object.keys(record).length === 1) {
    return new Map(
      (record.$map as [unknown, unknown][]).map(([key, entry]) => [
        decodeValue(key),
        decodeValue(entry),
      ]),
    );
  }
  if (Array.isArray(record.$set) && Object.keys(record).length === 1) {
    return new Set((record.$set as unknown[]).map(decodeValue));
  }
  if (typeof record.$date === "number" && Object.keys(record).length === 1) {
    return new Date(record.$date);
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record))
    decoded[key] = decodeValue(entry);
  return decoded;
}

/** Core's in-memory adapter whose whole state persists in the owner backend. */
export class DurableElizaDatabaseAdapter extends InMemoryDatabaseAdapter {
  private readonly backend: StateBackend;
  private readonly key: string;
  private readonly ownerAgentId: UUID;

  private constructor(agentId: UUID, backend: StateBackend, key: string) {
    super(agentId);
    this.backend = backend;
    this.key = key;
    this.ownerAgentId = agentId;
  }

  /** Opens the owner's adapter, restoring its last persisted snapshot. */
  static open(options: {
    readonly agentId: UUID;
    readonly backend: StateBackend;
    readonly key?: string;
  }): DurableElizaDatabaseAdapter {
    const adapter = new DurableElizaDatabaseAdapter(
      options.agentId,
      options.backend,
      options.key ?? OWNER_ADAPTER_KEY,
    );
    const stored = options.backend.read(adapter.key);
    if (stored !== undefined) adapter.load(stored);
    return adapter;
  }

  /** The names of the containers this adapter persists. */
  persistedFields(): ReadonlyArray<string> {
    return Object.keys(this)
      .filter((name) => {
        const value = (this as unknown as Record<string, unknown>)[name];
        return value instanceof Map || value instanceof Set;
      })
      .sort();
  }

  /** The complete state as one JSON document. */
  snapshot(): string {
    const fields: Record<string, unknown> = {};
    for (const name of this.persistedFields()) {
      fields[name] = encodeValue(
        (this as unknown as Record<string, unknown>)[name],
        name,
      );
    }
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      agentId: this.ownerAgentId,
      fields,
    };
    return JSON.stringify(snapshot);
  }

  /** Writes the current state; the owner runtime calls this once per invocation. */
  persist(): void {
    this.backend.write(this.key, this.snapshot());
  }

  private load(json: string): void {
    const snapshot = JSON.parse(json) as Partial<Snapshot>;
    if (
      snapshot.version !== SNAPSHOT_VERSION ||
      typeof snapshot.fields !== "object" ||
      snapshot.fields === null
    ) {
      throw new ElizaError("Owner state snapshot has an unsupported shape", {
        code: TARDIGRADE_STATE_SCHEMA,
        context: { version: snapshot.version ?? null, key: this.key },
      });
    }
    if (snapshot.agentId !== this.ownerAgentId) {
      throw new ElizaError("Owner state snapshot belongs to another agent", {
        code: TARDIGRADE_STATE_SCHEMA,
        context: {
          expected: this.ownerAgentId,
          actual: snapshot.agentId ?? null,
        },
      });
    }
    const self = this as unknown as Record<string, unknown>;
    for (const [name, encoded] of Object.entries(snapshot.fields)) {
      const current = self[name];
      const decoded = decodeValue(encoded);
      const compatible =
        (current instanceof Map && decoded instanceof Map) ||
        (current instanceof Set && decoded instanceof Set);
      if (!compatible) {
        throw new ElizaError(
          "Owner state snapshot names a container this adapter does not own",
          {
            code: TARDIGRADE_STATE_SCHEMA,
            context: { field: name, key: this.key },
          },
        );
      }
      self[name] = decoded;
    }
  }
}
