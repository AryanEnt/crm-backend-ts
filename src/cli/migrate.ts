import { createPool } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { logger } from "../logger.js";

const url = process.env.DATABASE_URL;
if (!url) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool(url);
try {
  const applied = await migrate(pool);
  logger.info({ count: applied.length }, applied.length ? "migrations applied" : "database is up to date");
} catch (err) {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, "migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
