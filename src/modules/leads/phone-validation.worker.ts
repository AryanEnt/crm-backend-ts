import type { Database } from "../../db/database.js";
import { logger } from "../../logger.js";
import { PhoneValidationService } from "./phone-validation.service.js";

const TICK_MS = 60_000;

export function createPhoneValidationWorker(db: Database): PhoneValidationWorker {
  return new PhoneValidationWorker(new PhoneValidationService(db));
}

/**
 * Background pass for pending phone validations and 24h issue reminders.
 * Immediate validation is also enqueued after create/update; this covers retries.
 */
export class PhoneValidationWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly phones: PhoneValidationService) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    logger.info("phone validation worker started");
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
    try {
      const validated = await this.phones.processPending();
      const notified = await this.phones.processReminders();
      if (validated > 0 || notified > 0) {
        logger.info({ validated, notified }, "phone validation tick");
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "phone validation tick failed");
    } finally {
      this.running = false;
      this.schedule(TICK_MS);
    }
  }
}
