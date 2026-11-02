import { describe, expect, it } from "vitest";
import type { Claims } from "../src/modules/auth/types.js";
import { TokenBox } from "../src/modules/email/crypto.js";
import { pickFolders } from "../src/modules/email/imap-smtp.js";
import { IMAP_PRESETS, resolveImapSettings } from "../src/modules/email/imap-presets.js";
import { assertMailHostAllowed } from "../src/modules/email/mail-host-guard.js";
import { canChangeMailboxSettings, canInviteUser, canManageMailbox, canSendFromMailbox } from "../src/modules/email/mailbox-access.js";
import { classifyMailError, safeMailError } from "../src/modules/email/mail-provider.js";
import { maskMailUser } from "../src/modules/email/email.service.js";
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
    username: "",
    managerUserId: null,
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "",
    smtpPort: 465,
    smtpSecure: true,
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

  it("lets a new team lead view activity but not disconnect until they take over", () => {
    const previous = acc({ userId: "se-1", managerUserId: "tl-old" });
    const newTl = claims({
      userId: "tl-new",
      roleCode: "sales_manager",
      teamMemberUserIds: ["se-1"],
      permissionScopes: { "email:view": "team", "email:manage": "team" },
    });
    expect(canManageMailbox(newTl, previous)).toBe(true);
    expect(canChangeMailboxSettings(newTl, previous)).toBe(false);
    expect(canChangeMailboxSettings(claims({ userId: "tl-old", roleCode: "sales_manager" }), previous)).toBe(true);
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

/** Shapes captured from imapflow 2.9.1 / nodemailer 10.3.0 against real servers. */
function imapflowError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("Command failed"), fields);
}

describe("safe mail errors", () => {
  it("does not echo credentials or raw TLS internals", () => {
    const out = safeMailError(new Error("Invalid login password=hunter2"));
    expect(out.code).toBe("auth");
    expect(out.message).not.toMatch(/hunter2/);
  });

  it("treats Migadu's IMAP login rejection as an auth failure, not a generic error", () => {
    const err = classifyMailError(
      imapflowError({ authenticationFailed: true, responseStatus: "NO", responseText: "Authentication failed" }),
      "imap",
    );
    expect(err.code).toBe("auth");
    expect(err.stage).toBe("imap");
    expect(err.message).toMatch(/rejected the username or password/);
    expect(err.message).not.toMatch(/Could not complete the mail operation/);
    expect(err.diagnostics).toMatchObject({ message: "Command failed", authenticationFailed: true, responseText: "Authentication failed" });
  });

  it("maps SMTP 535 / EAUTH to auth without keeping AUTH payloads", () => {
    const smtp = Object.assign(new Error("Invalid login: 535 5.7.8 Error: authentication failed"), {
      code: "EAUTH",
      responseCode: 535,
      command: "AUTH PLAIN dXNlcgBwYXNzd29yZA==",
    });
    const err = classifyMailError(smtp, "smtp");
    expect(err.code).toBe("auth");
    expect(err.diagnostics.command).toBe("AUTH");
    expect(JSON.stringify(err.diagnostics)).not.toMatch(/dXNlcgBwYXNzd29yZA/);
  });

  it("separates TLS mode mismatches, certificate failures, timeouts and unreachable hosts", () => {
    expect(classifyMailError(Object.assign(new Error("wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" })).message).toMatch(
      /port and SSL\/TLS/,
    );
    expect(classifyMailError(Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).code).toBe("tls");
    expect(classifyMailError(Object.assign(new Error("Connection timeout"), { code: "ETIMEOUT" })).code).toBe("timeout");
    expect(classifyMailError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.nope"), { code: "ENOTFOUND" })).code).toBe("network");
  });

  it("reports other IMAP NO responses as a refusal and keeps the cause", () => {
    const cause = imapflowError({ responseStatus: "NO", serverResponseCode: "UNAVAILABLE", responseText: "Try later" });
    const err = classifyMailError(cause, "imap");
    expect(err.code).toBe("reject");
    expect(err.cause).toBe(cause);
  });

  it("masks the mailbox in logs but keeps the domain", () => {
    expect(maskMailUser("priya@example.com")).toBe("p***@example.com");
  });
});

describe("provider presets", () => {
  it("fills Migadu and Spacemail hosts and still allows custom overrides", () => {
    expect(IMAP_PRESETS.migadu.imapHost).toBe("imap.migadu.com");
    expect(IMAP_PRESETS.spacemail.smtpHost).toBe("mail.spacemail.com");
    const custom = resolveImapSettings("migadu", { imapHost: "imap.example.test" });
    expect(custom.imapHost).toBe("imap.example.test");
    expect(custom.smtpHost).toBe("smtp.migadu.com");
  });

  it("treats blank form hosts as the company server, not as no server", () => {
    const company = {
      imapHost: "mail.company.test",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "mail.company.test",
      smtpPort: 465,
      smtpSecure: true,
    };
    expect(resolveImapSettings("imap", { imapHost: "", smtpHost: "  " }, company)).toEqual(company);
  });
});

describe("mail host guard", () => {
  it("blocks loopback IMAP targets unless private hosts are allowed", async () => {
    await expect(assertMailHostAllowed("127.0.0.1", { allowPrivate: false, allowlist: [] })).rejects.toThrow(
      /not allowed/,
    );
    await expect(assertMailHostAllowed("127.0.0.1", { allowPrivate: true, allowlist: [] })).resolves.toBeUndefined();
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
