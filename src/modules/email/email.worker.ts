import { logger } from "../../logger.js";
import type { EmailService } from "./email.service.js";

const WATCH_INTERVAL_MS = 6 * 60 * 60_000;
const SCHEDULE_INTERVAL_MS = 30_000;

export interface EmailWorker {
  start(): void;
  stop(): Promise<void>;
}

/** Renews Gmail watches (at start, then every 6h) and sends due scheduled email every 30s, one task at a time. */
export function createEmailWorker(service: EmailService): EmailWorker {
  const timers: NodeJS.Timeout[] = [];
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  // A Go ticker buffers one tick and drops the rest while the loop is busy.
  const pending = new Set<string>();

  const enqueue = (kind: string, task: () => Promise<void>) => {
    if (pending.has(kind)) return;
    pending.add(kind);
    chain = chain.then(async () => {
      pending.delete(kind);
      if (stopped) return;
      await task().catch((err: unknown) => logger.error({ err }, "email worker task failed"));
    });
  };

  return {
    start() {
      enqueue("initial", () => service.renewWatches());
      timers.push(setInterval(() => enqueue("watch", () => service.renewWatches()), WATCH_INTERVAL_MS));
      timers.push(setInterval(() => enqueue("schedule", () => service.sendDueScheduled()), SCHEDULE_INTERVAL_MS));
      logger.info("gmail email worker started");
    },
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await chain;
    },
  };
}
