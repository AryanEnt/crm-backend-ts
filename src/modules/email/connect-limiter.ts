import { AppError } from "../../lib/app-error.js";

/** In-process sliding window for mailbox test/connect. */
export class ConnectLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const next = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (next.length >= this.max) {
      throw AppError.validation("Too many mailbox connection attempts. Wait a few minutes and try again.");
    }
    next.push(now);
    this.hits.set(key, next);
  }
}
