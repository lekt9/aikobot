/**
 * The owner state backend: a small keyed string store every host implements
 * synchronously — Durable Object SQLite on Cloudflare, `bun:sqlite` on Bun,
 * a Map in tests. Values are complete JSON documents; hosts that bound a row
 * chunk transparently. The durable adapter and the invocation receipt table
 * are the only writers, and they write once per invocation.
 */

export interface StateBackend {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  delete(key: string): void;
  keys(prefix: string): ReadonlyArray<string>;
}

/** A process-local backend for tests and for hosts that persist elsewhere. */
export function memoryBackend(
  seed: Iterable<readonly [string, string]> = [],
): StateBackend & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>(seed);
  return {
    entries,
    read: (key) => entries.get(key),
    write: (key, value) => {
      entries.set(key, value);
    },
    delete: (key) => {
      entries.delete(key);
    },
    keys: (prefix) =>
      [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

/** Rows a SQL-backed store keeps: one manifest row per key, N chunk rows. */
export interface SqlRunner {
  run(query: string, ...values: ReadonlyArray<string | number>): void;
  rows<T>(query: string, ...values: ReadonlyArray<string | number>): T[];
  transaction<T>(operation: () => T): T;
}

export const CHUNK_SIZE = 128 * 1024;

/**
 * A chunked backend over any synchronous SQL runner. Keys are split into
 * 128 KiB parts so a large owner snapshot fits row limits on every host, and
 * a read whose parts are incomplete is an error rather than a truncated value.
 */
export function chunkedSqlBackend(sql: SqlRunner): StateBackend {
  sql.run(
    "CREATE TABLE IF NOT EXISTS eliza_state (key TEXT PRIMARY KEY, parts INTEGER NOT NULL)",
  );
  sql.run(
    "CREATE TABLE IF NOT EXISTS eliza_chunks (key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, part))",
  );
  return {
    read: (key) => {
      const manifest = sql.rows<{ parts: number }>(
        "SELECT parts FROM eliza_state WHERE key = ?",
        key,
      )[0];
      if (manifest === undefined) return undefined;
      const parts = sql.rows<{ value: string }>(
        "SELECT value FROM eliza_chunks WHERE key = ? ORDER BY part",
        key,
      );
      if (parts.length !== manifest.parts) {
        throw new Error(
          `owner state ${key} is incomplete: ${parts.length} of ${manifest.parts} parts`,
        );
      }
      return parts.map((row) => row.value).join("");
    },
    write: (key, value) =>
      sql.transaction(() => {
        const parts = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
        sql.run("DELETE FROM eliza_chunks WHERE key = ?", key);
        for (let part = 0; part < parts; part += 1) {
          sql.run(
            "INSERT INTO eliza_chunks(key, part, value) VALUES (?, ?, ?)",
            key,
            part,
            value.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE),
          );
        }
        sql.run(
          "INSERT INTO eliza_state(key, parts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET parts = excluded.parts",
          key,
          parts,
        );
      }),
    delete: (key) =>
      sql.transaction(() => {
        sql.run("DELETE FROM eliza_chunks WHERE key = ?", key);
        sql.run("DELETE FROM eliza_state WHERE key = ?", key);
      }),
    keys: (prefix) =>
      sql
        .rows<{ key: string }>(
          "SELECT key FROM eliza_state WHERE substr(key, 1, ?) = ? ORDER BY key",
          prefix.length,
          prefix,
        )
        .map((row) => row.key),
  };
}
