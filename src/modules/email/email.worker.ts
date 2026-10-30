import { logger } from "../../logger.js";
import type { EmailService } from "./email.service.js";

const WATCH_INTERVAL_MS = 6 * 60 * 60_000;
const SCHEDULE_INTERVAL_MS = 30_000;
const DEFAULT_IMAP_INTERVAL_MS = 300_000;

export interface EmailWorker {
  start(): void;
  stop(): Promise<void>;
}

/** Renews Gmail watches, polls IMAP mailboxes, and sends due scheduled email — one task at a time. */
export function createEmailWorker(service: EmailService, imapIntervalMs = DEFAULT_IMAP_INTERVAL_MS): EmailWorker {
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
      const imapMs = imapIntervalMs > 30_000 ? imapIntervalMs : DEFAULT_IMAP_INTERVAL_MS;
      enqueue("initial", () => service.renewWatches());
      enqueue("imap", () => service.syncDueImapMailboxes());
      timers.push(setInterval(() => enqueue("watch", () => service.renewWatches()), WATCH_INTERVAL_MS));
      timers.push(setInterval(() => enqueue("schedule", () => service.sendDueScheduled()), SCHEDULE_INTERVAL_MS));
      timers.push(setInterval(() => enqueue("imap", () => service.syncDueImapMailboxes()), imapMs));
      logger.info({ imapIntervalMs: imapMs }, "email worker started");
    },
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await chain;
    },
  };
}
