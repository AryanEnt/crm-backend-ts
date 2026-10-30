import type { Database } from "../../db/database.js";
import { logger } from "../../logger.js";
import { NotificationsService } from "./notifications.service.js";
import { scanSlaBreaches, slaScanMinutes } from "./sla-scan.js";

const FALLBACK_MS = 15 * 60_000;

export function createSlaNotificationWorker(db: Database): SlaNotificationWorker {
  return new SlaNotificationWorker(db, new NotificationsService(db));
}

/**
 * Periodic SLA scan. Advisory lock + unique dedupe_key keep multi-instance deploys from
 * notifying twice. Interval is read from organization_settings each tick.
 */
export class SlaNotificationWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly inbox: NotificationsService,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    logger.info("sla notification worker started");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = Date.now() + 8_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let wait = FALLBACK_MS;
    try {
      wait = (await slaScanMinutes(this.db)) * 60_000;
      await scanSlaBreaches(this.db, this.inbox);
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "sla scan tick failed");
    } finally {
      this.running = false;
      this.schedule(wait);
    }
  }
}
