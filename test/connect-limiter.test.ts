import { describe, expect, it } from "vitest";
import { MailboxConnectLimiter } from "../src/modules/email/connect-limiter.js";

const WINDOW = 15 * 60_000;
const TOO_MANY = /Too many mailbox connection attempts/;

describe("mailbox connect rate limit", () => {
  it("lets a team lead connect mailboxes for a whole team in one sitting", () => {
    const limiter = new MailboxConnectLimiter();
    for (let i = 0; i < 40; i++) {
      expect(() => limiter.check("test", "tl-1", `rep${i}@example.com`, 0)).not.toThrow();
      expect(() => limiter.check("connect", "tl-1", `rep${i}@example.com`, 0)).not.toThrow();
    }
  });

  it("still limits repeated attempts against one mailbox, ignoring case and spacing", () => {
    const limiter = new MailboxConnectLimiter();
    for (let i = 0; i < 10; i++) limiter.check("connect", "tl-1", "rep@example.com", 0);
    expect(() => limiter.check("connect", "tl-1", " Rep@Example.com ", 0)).toThrow(TOO_MANY);
    // Another mailbox, and another user, are unaffected.
    expect(() => limiter.check("connect", "tl-1", "other@example.com", 0)).not.toThrow();
    expect(() => limiter.check("connect", "tl-2", "rep@example.com", 0)).not.toThrow();
  });

  it("caps one user's total attempts across mailboxes", () => {
    const limiter = new MailboxConnectLimiter({ perActor: 3 });
    for (let i = 0; i < 3; i++) limiter.check("test", "tl-1", `rep${i}@example.com`, 0);
    expect(() => limiter.check("test", "tl-1", "rep9@example.com", 0)).toThrow(TOO_MANY);
  });

  it("frees up once the window passes, and refused attempts don't extend it", () => {
    const limiter = new MailboxConnectLimiter();
    for (let i = 0; i < 10; i++) limiter.check("test", "tl-1", "rep@example.com", 0);
    expect(() => limiter.check("test", "tl-1", "rep@example.com", WINDOW - 1)).toThrow(TOO_MANY);
    expect(() => limiter.check("test", "tl-1", "rep@example.com", WINDOW)).not.toThrow();
  });
});
