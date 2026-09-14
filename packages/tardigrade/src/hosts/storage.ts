/**
 * Cloudflare owner backend: the owner Durable Object's SQLite storage as the
 * chunked state store. `transactionSync` makes each document write atomic
 * inside the object's own storage transaction; the object calls
 * `storage.sync()` after an invocation commits.
 */

import {
  chunkedSqlBackend,
  type SqlRunner,
  type StateBackend,
} from "../owner/backend";

/** The Durable Object storage surface the backend needs (Workers types). */
export type DurableSqlStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
>;

export function durableObjectBackend(storage: DurableSqlStorage): StateBackend {
  const runner: SqlRunner = {
    run: (query, ...values) => {
      storage.sql.exec(query, ...values);
    },
    rows: <T>(query: string, ...values: ReadonlyArray<string | number>) =>
      storage.sql.exec(query, ...values).toArray() as T[],
    transaction: (operation) => storage.transactionSync(operation),
  };
  return chunkedSqlBackend(runner);
}
