import { AppError } from "../../lib/app-error.js";

const MAX_TRACKED_KEYS = 5_000;

/** In-process sliding window. */
export class ConnectLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** True when another attempt under `key` would exceed the window. Records nothing. */
  isBlocked(key: string, now = Date.now()): boolean {
    return this.live(key, now).length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    const next = this.live(key, now);
    next.push(now);
    this.hits.set(key, next);
    if (this.hits.size > MAX_TRACKED_KEYS) this.sweep(now);
  }

  check(key: string, now = Date.now()): void {
    if (this.isBlocked(key, now)) throw tooManyAttempts();
    this.record(key, now);
  }

  private live(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private sweep(now: number): void {
    for (const key of this.hits.keys()) {
      const live = this.live(key, now);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}

function tooManyAttempts(): AppError {
  return AppError.validation("Too many mailbox connection attempts. Wait a few minutes and try again.");
}

export type MailboxConnectAction = "test" | "connect";

/**
 * Rate limit for mailbox test/connect.
 *
 * The tight limit is per mailbox, which is what password guessing needs. A team lead setting up
 * mailboxes for a whole team makes many attempts across different mailboxes, so the per-user
 * limit is only a loose cap against using the server to probe mail hosts.
 */
export class MailboxConnectLimiter {
  private readonly perMailbox: ConnectLimiter;
  private readonly perActor: ConnectLimiter;

  constructor(opts: { perMailbox?: number; perActor?: number; windowMs?: number } = {}) {
    const windowMs = opts.windowMs ?? 15 * 60_000;
    this.perMailbox = new ConnectLimiter(opts.perMailbox ?? 10, windowMs);
    this.perActor = new ConnectLimiter(opts.perActor ?? 100, windowMs);
  }

  check(action: MailboxConnectAction, actorUserId: string, emailAddress: string, now = Date.now()): void {
    const actorKey = `${action}:${actorUserId}`;
    const mailboxKey = `${actorKey}:${emailAddress.trim().toLowerCase()}`;
    // Decide first, then record, so a refused attempt doesn't eat into the other budget.
    if (this.perMailbox.isBlocked(mailboxKey, now) || this.perActor.isBlocked(actorKey, now)) throw tooManyAttempts();
    this.perMailbox.record(mailboxKey, now);
    this.perActor.record(actorKey, now);
  }
}
