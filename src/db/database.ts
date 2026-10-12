import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "./schema.js";

// Keep runtime values in line with the generated types (see .kysely-codegenrc.json):
// int8 and numeric -> number, like the Go backend's int64/float64 JSON output;
// date -> "YYYY-MM-DD".
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Database = Kysely<DB>;

/** Pool sizing mirrors the Go backend's pgxpool settings. */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 60_000,
    maxLifetimeSeconds: 60 * 60,
    connectionTimeoutMillis: 10_000,
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export async function ping(db: Database, timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
  });
  try {
    await Promise.race([sql`SELECT 1`.execute(db), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
