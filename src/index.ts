import { createApp } from "./app.js";
import { isDevelopment, loadConfig } from "./config.js";
import { createDatabase, createPool, ping } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { seedBootstrapAdmin } from "./db/seed.js";
import { logger } from "./logger.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { createAutomationWorker } from "./modules/automation/automation.worker.js";
import { createEmailWorker } from "./modules/email/email.worker.js";
import { EmailService } from "./modules/email/email.service.js";
import { TimelineService } from "./modules/timeline/timeline.service.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Go's godotenv.Load(): an optional ./.env that never overrides the environment. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`load config: parse .env: ${message(err)}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    throw new Error(`load config: ${message(err)}`);
  }
  const pool = createPool(config.databaseUrl);
  const db = createDatabase(pool);

  await ping(db, 5_000).catch((err: unknown) => {
    throw new Error(`connect database: ${message(err)}`);
  });

  // Like the Go entrypoint: apply pending migrations and seed the bootstrap admin on every start.
  await migrate(pool).catch((err: unknown) => {
    throw new Error(`run migrations: ${message(err)}`);
  });
  logger.info("migrations applied");
  await seedBootstrapAdmin(pool, { production: !isDevelopment(config) }).catch((err: unknown) => {
    throw new Error(`seed bootstrap admin: ${message(err)}`);
  });

  const worker = config.automationWorker ? createAutomationWorker(db) : null;
  const emailWorker = config.emailWorker
    ? createEmailWorker(new EmailService(db, config, new AuditService(db), new TimelineService(db)))
    : null;
  const app = createApp({ config, db, automationWake: worker?.wake });
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: String(config.port),
        env: config.appEnv,
        frontend_url: config.frontendUrl,
        go_backend_url: config.goBackendUrl || null,
        automation_worker: config.automationWorker,
        email_worker: config.emailWorker,
      },
      "API server listening",
    );
  });
  worker?.start();
  emailWorker?.start();
  server.headersTimeout = 5_000 + 1_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 60_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown signal received");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out");
      process.exit(1);
    }, 15_000);
    force.unref();
    server.close(async () => {
      await worker?.stop();
      await emailWorker?.stop();
      await db.destroy().catch(() => undefined);
      logger.info("server stopped cleanly");
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ error: message(err) }, "server exited with error");
  process.exit(1);
});
