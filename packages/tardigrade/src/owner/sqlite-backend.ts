/**
 * Bun host backend: one `bun:sqlite` database per owner holding the chunked
 * state rows. Opened lazily by the owner registry; WAL mode keeps a crash
 * between chunk writes from leaving a half-written document because each
 * write is one transaction.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  chunkedSqlBackend,
  type SqlRunner,
  type StateBackend,
} from "./backend";

export interface SqliteBackend extends StateBackend {
  close(): void;
}

export function sqliteBackend(path: string): SqliteBackend {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  const runner: SqlRunner = {
    run: (query, ...values) => {
      database.run(query, values as (string | number)[]);
    },
    rows: <T>(query: string, ...values: ReadonlyArray<string | number>) =>
      database.query(query).all(...(values as (string | number)[])) as T[],
    transaction: (operation) => database.transaction(operation)(),
  };
  const backend = chunkedSqlBackend(runner);
  return { ...backend, close: () => database.close() };
}
