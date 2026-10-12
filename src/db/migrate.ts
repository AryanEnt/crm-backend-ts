import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { logger } from "../logger.js";

/** Arbitrary constant key so concurrent migrate runs wait for each other. */
const MIGRATION_LOCK_KEY = 727_001;

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "../../migrations");
}

export function parseVersion(filename: string): number {
  const prefix = filename.split("_", 1)[0] ?? "";
  const version = Number(prefix);
  if (prefix === "" || !Number.isInteger(version)) {
    throw new Error(`invalid migration version in ${filename}`);
  }
  return version;
}

/** *.up.sql files in lexicographic order, the order the Go backend applies them in. */
export async function listMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".up.sql"))
    .map((e) => e.name)
    .sort();
}

/**
 * Applies pending migrations, each in its own transaction, recording them in
 * schema_migrations exactly like the Go backend so both agree on what has run.
 * Never runs down migrations.
 */
export async function migrate(pool: pg.Pool, dir = defaultMigrationsDir()): Promise<string[]> {
  const files = await listMigrations(dir);
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     BIGINT PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const name of files) {
      const version = parseVersion(name);
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
        [version],
      );
      if (rows[0]?.exists) continue;

      const text = await readFile(path.join(dir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(text);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [version, name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`apply migration ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(name);
      logger.info({ migration: name }, "migration applied");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
