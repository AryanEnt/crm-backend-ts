import { isDevelopment } from "../config.js";
import { createPool } from "../db/database.js";
import { seedBootstrapAdmin } from "../db/seed.js";
import { logger } from "../logger.js";

const url = process.env.DATABASE_URL;
if (!url) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool(url);
try {
  const production = !isDevelopment({ appEnv: process.env.APP_ENV || "development" });
  if (!(await seedBootstrapAdmin(pool, { production }))) {
    logger.info("users already exist; bootstrap admin not needed");
  }
} catch (err) {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, "seed failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
