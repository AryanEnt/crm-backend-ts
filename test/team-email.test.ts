import { describe, expect, it } from "vitest";
import type { Claims } from "../src/modules/auth/types.js";
import { TokenBox } from "../src/modules/email/crypto.js";
import { pickFolders } from "../src/modules/email/imap-smtp.js";
import { canInviteUser, canManageMailbox, canSendFromMailbox } from "../src/modules/email/mailbox-access.js";
import { safeMailError } from "../src/modules/email/mail-provider.js";
import { sanitizeEmailHtml } from "../src/modules/email/sanitize.js";
import type { AccountRecord } from "../src/modules/email/email.repository.js";

function claims(partial: Partial<Claims>): Claims {
  return {
    userId: "se-1",
    email: "se@x.com",
    fullName: "SE",
    roleCode: "sales_executive",
    roleId: "r1",
    teamIds: ["t1"],
    teamMemberUserIds: [],
    permissions: ["email:view", "email:send"],
    permissionScopes: { "email:view": "own", "email:send": "own" },
    expiresAt: new Date(Date.now() + 60_000),
    ...partial,
  };
}

function acc(partial: Partial<AccountRecord>): AccountRecord {
  return {
    id: "a1",
    provider: "imap",
    emailAddress: "se@x.com",
    displayName: "SE",
    avatarUrl: "",
    connectionStatus: "connected",
    sendingEnabled: true,
    receivingEnabled: true,
    lastSyncAt: null,
    lastSyncError: "",
    createdAt: new Date(),
    userId: "se-1",
    encryptedAccessToken: "",
    encryptedRefreshToken: "",
    encryptedPassword: "enc",
    tokenExpiry: null,
    gmailHistoryId: "",
    watchExpiration: null,
    imapInboxFolder: "INBOX",
    imapSentFolder: "Sent",
    imapInboxUidValidity: 1,
    imapInboxUid: 0,
    imapSentUidValidity: 1,
    imapSentUid: 0,
    ...partial,
  };
}

describe("mailbox access", () => {
  it("lets an SE send only from their own mailbox", () => {
    const se = claims({});
    expect(canSendFromMailbox(se, acc({ userId: "se-1" }))).toBe(true);
    expect(canSendFromMailbox(se, acc({ userId: "se-2" }))).toBe(false);
  });

  it("blocks a team lead from impersonating an SE sender", () => {
    const tl = claims({
      userId: "tl-1",
      roleCode: "sales_manager",
      teamMemberUserIds: ["se-1"],
      permissionScopes: { "email:view": "team", "email:manage": "team" },
    });
    expect(canSendFromMailbox(tl, acc({ userId: "se-1" }))).toBe(false);
    expect(canManageMailbox(tl, acc({ userId: "se-1" }))).toBe(true);
    expect(canManageMailbox(tl, acc({ userId: "other-team" }))).toBe(false);
  });

  it("isolates invites to assigned team members", () => {
    const tl = claims({
      userId: "tl-1",
      roleCode: "sales_manager",
      teamMemberUserIds: ["se-1"],
      permissionScopes: { "email:view": "team", "email:manage": "team" },
    });
    expect(canInviteUser(tl, "se-1")).toBe(true);
    expect(canInviteUser(tl, "se-other")).toBe(false);
  });
});

describe("HTML sanitization", () => {
  it("strips scripts, event handlers, and remote images", () => {
    const dirty =
      `<script>alert(1)</script><p onclick="x()">Hi</p><img src="https://evil/x.png"><a href="javascript:alert(1)">x</a>`;
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|img|javascript/i);
    expect(clean).toContain("<p>Hi</p>");
  });
});

describe("IMAP folder discovery", () => {
  it("prefers special-use Sent and INBOX without hardcoding a provider name", () => {
    const folders = pickFolders([
      { path: "INBOX", specialUse: "\\Inbox", name: "INBOX" },
      { path: "INBOX.Sent", specialUse: "\\Sent", name: "Sent" },
      { path: "Junk", name: "Junk" },
    ]);
    expect(folders.inbox).toBe("INBOX");
    expect(folders.sent).toBe("INBOX.Sent");
  });
});

describe("safe mail errors", () => {
  it("does not echo credentials or raw TLS internals", () => {
    const out = safeMailError(new Error("Invalid login password=hunter2"));
    expect(out.message).toBe("Mailbox username or password was rejected.");
    expect(out.message).not.toMatch(/hunter2/);
  });
});

describe("credential encryption", () => {
  it("stores IMAP passwords with the same TokenBox as Gmail tokens", () => {
    const box = new TokenBox("unit-test-secret");
    const enc = box.encrypt("mailbox-pass");
    expect(enc).not.toContain("mailbox-pass");
    expect(box.decrypt(enc)).toBe("mailbox-pass");
  });
});
