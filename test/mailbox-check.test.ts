import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import type { AuditService } from "../src/modules/audit/audit.service.js";
import type { Claims } from "../src/modules/auth/types.js";
import {
  domainOfEmail,
  normalizeDomain,
  settingsForDomainProvider,
  validateDomainProvider,
} from "../src/modules/email/domain-providers.js";
import { isSelfHostedMx, providerFromMx } from "../src/modules/email/mx-provider.js";
import { EmailService, type EmailConfig } from "../src/modules/email/email.service.js";
import type { ImapSmtpSettings } from "../src/modules/email/imap-smtp.js";
import { MailProviderError, type MailConnectionCheck, type MailTransport, type MailboxAuth } from "../src/modules/email/mail-provider.js";
import type { TimelineService } from "../src/modules/timeline/timeline.service.js";
import { bearer, config, queueAuth, userRow } from "./helpers/app.js";
import { fakeDb, type FakeDb } from "./helpers/fake-db.js";

const cfg: EmailConfig = {
  publicApiUrl: "http://api.test",
  frontendUrl: "http://app.test",
  googleClientId: "",
  googleClientSecret: "",
  gmailPubSubTopic: "",
  tokenEncryptionKey: "k".repeat(64),
  jwtSecret: "secret",
  mailAllowPrivateHosts: true,
  // The global company server must never be picked up for a mapped domain.
  mailImapHost: "127.0.0.9",
  mailSmtpHost: "127.0.0.9",
};

function claims(partial: Partial<Claims>): Claims {
  return {
    userId: "tl-1",
    email: "tl@x.com",
    fullName: "TL",
    roleCode: "sales_manager",
    roleId: "r",
    teamIds: ["t1"],
    teamMemberUserIds: ["se-1"],
    permissions: ["email:view", "email:manage"],
    permissionScopes: { "email:view": "team", "email:manage": "team" },
    expiresAt: new Date(Date.now() + 60_000),
    ...partial,
  };
}
const tl = claims({});
const se = claims({ userId: "se-1", roleCode: "sales_executive", teamMemberUserIds: [], permissions: ["email:view", "email:send"], permissionScopes: { "email:view": "own", "email:send": "own" } });

const PASSWORD = "  p@ss wörd+/= ";

/** Mapping rows as the repository returns them. */
const row = (domain: string, provider: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${domain}`,
  domain,
  provider,
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  isActive: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
});

const okCheck = async (): Promise<MailConnectionCheck> => ({
  imap: { ok: true, ms: 1, folders: { inbox: "INBOX", sent: "Sent" } },
  smtp: { ok: true, ms: 1 },
});

function service(
  f: FakeDb,
  check: (auth: MailboxAuth) => Promise<MailConnectionCheck> = okCheck,
  mx: (domain: string) => Promise<{ exchange: string; priority: number }[]> = async () => [],
  cfgOverride: Partial<EmailConfig> = {},
) {
  const seen: { settings: ImapSmtpSettings[]; auth: MailboxAuth[] } = { settings: [], auth: [] };
  const fake: MailTransport = {
    capabilities: () => ({ kind: "imap", send: true, syncInbox: true, syncSent: true, idle: false }),
    testConnection: async () => ({ inbox: "INBOX", sent: "Sent" }),
    send: async () => ({ providerMessageId: "", providerThreadId: "" }),
    fetchFolder: async (_a, _f, path, cursor) => ({ messages: [], cursor, path }),
  };
  const svc = new EmailService(f.db, { ...cfg, ...cfgOverride }, {} as AuditService, {} as TimelineService, {
    imap: fake,
    createImap: (settings) => {
      seen.settings.push(settings);
      return {
        ...fake,
        checkConnection: async (auth) => {
          seen.auth.push(auth);
          return check(auth);
        },
      };
    },
    lookupMx: mx,
  });
  return { svc, seen };
}

const body = (email: string, extra: Record<string, unknown> = {}) => ({ ownerUserId: "se-1", emailAddress: email, password: PASSWORD, ...extra });

describe("domain → provider detection", () => {
  it("connects each domain to its own provider from the admin mapping", async () => {
    const f = fakeDb();
    f.queue([row("spacemail-domain.test", "spacemail")], [row("migadu-domain.test", "migadu")]);
    const { svc, seen } = service(f);

    const a = await svc.testImapConnection(tl, body("Priya@Spacemail-Domain.test"), "req-a");
    const b = await svc.testImapConnection(tl, body("ram@migadu-domain.test"), "req-b");

    expect(a.check).toMatchObject({ provider: "spacemail", providerSource: "mapping" });
    expect(b.check).toMatchObject({ provider: "migadu", providerSource: "mapping" });
    expect(seen.settings[0]).toEqual({
      imapHost: "mail.spacemail.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "mail.spacemail.com",
      smtpPort: 465,
      smtpSecure: true,
    });
    expect(seen.settings[1]).toEqual({
      imapHost: "imap.migadu.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.migadu.com",
      smtpPort: 465,
      smtpSecure: true,
    });
    expect(seen.auth).toEqual([
      { user: "priya@spacemail-domain.test", pass: PASSWORD },
      { user: "ram@migadu-domain.test", pass: PASSWORD },
    ]);
    expect(f.queries[0]!.parameters).toContain("spacemail-domain.test");
  });

  it("refuses to guess when the domain has no mapping and its mail records don't match a provider", async () => {
    const f = fakeDb();
    f.queue([]);
    const { svc, seen } = service(f);
    const err = await svc.testImapConnection(se, { emailAddress: "se@unmapped.test", password: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/Couldn't detect a mail server for @unmapped\.test/);
    expect(seen.settings).toEqual([]);
  });

  it("detects Migadu or Spacemail from the domain's MX records and remembers the domain", async () => {
    const f = fakeDb();
    f.queue([]);
    const { svc, seen } = service(f, okCheck, async () => [{ exchange: "aspmx1.migadu.com.", priority: 10 }]);
    const r = await svc.testImapConnection(tl, body("a@new-domain.test"), "req-mx");
    expect(r.check).toMatchObject({ provider: "migadu", providerSource: "dns" });
    expect(seen.settings[0]).toMatchObject({ imapHost: "imap.migadu.com", smtpHost: "smtp.migadu.com" });
    expect(f.queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
  });

  it("uses the company server for a domain that hosts its own mail", async () => {
    const f = fakeDb();
    f.queue([]);
    const { svc, seen } = service(
      f,
      okCheck,
      async () => [{ exchange: "entegrasources.com.np", priority: 10 }],
      { mailImapHost: "mail.entegrasources.com.np", mailImapPort: 993, mailImapSecure: true, mailSmtpHost: "mail.entegrasources.com.np", mailSmtpPort: 465, mailSmtpSecure: true },
    );
    const r = await svc.testImapConnection(tl, body("a@entegrasources.com.np"), "req-own");
    expect(r.check).toMatchObject({ provider: "imap", providerSource: "dns" });
    expect(seen.settings[0]).toEqual({
      imapHost: "mail.entegrasources.com.np",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "mail.entegrasources.com.np",
      smtpPort: 465,
      smtpSecure: true,
    });
  });

  it("keeps an admin mapping ahead of what DNS would say", async () => {
    const f = fakeDb();
    f.queue([row("listed.test", "spacemail")]);
    let lookedUp = false;
    const { svc, seen } = service(f, okCheck, async () => {
      lookedUp = true;
      return [{ exchange: "aspmx1.migadu.com", priority: 10 }];
    });
    const r = await svc.testImapConnection(tl, body("a@listed.test"), "req-map");
    expect(r.check).toMatchObject({ provider: "spacemail", providerSource: "mapping" });
    expect(seen.settings[0]!.imapHost).toBe("mail.spacemail.com");
    expect(lookedUp).toBe(false);
  });

  it("lets a TL override the mapped provider and records it as an override", async () => {
    const f = fakeDb();
    f.queue([row("migadu-domain.test", "migadu")]);
    const { svc, seen } = service(f);
    const r = await svc.testImapConnection(tl, body("ram@migadu-domain.test", { provider: "spacemail" }), "req-o");
    expect(r.check).toMatchObject({ provider: "spacemail", providerSource: "override" });
    expect(seen.settings[0]!.imapHost).toBe("mail.spacemail.com");
  });

  it("does not let an SE pick a provider or server", async () => {
    const f = fakeDb();
    f.queue([row("migadu-domain.test", "migadu")]);
    const { svc } = service(f);
    const err = await svc
      .testImapConnection(se, { emailAddress: "se@migadu-domain.test", password: "x", provider: "imap", imapHost: "evil.test" })
      .catch((e: unknown) => e);
    expect((err as AppError).status).toBe(403);
  });

  it("uses a custom mapping's own hosts", async () => {
    const f = fakeDb();
    f.queue([row("own.test", "imap", { imapHost: "127.0.0.2", smtpHost: "127.0.0.3", smtpPort: 587, smtpSecure: false })]);
    const { svc, seen } = service(f);
    await svc.testImapConnection(tl, body("a@own.test"), "req-c");
    expect(seen.settings[0]).toMatchObject({ imapHost: "127.0.0.2", smtpHost: "127.0.0.3", smtpPort: 587, smtpSecure: false });
  });

  it("reports IMAP and SMTP separately with the request ID", async () => {
    const f = fakeDb();
    f.queue([row("migadu-domain.test", "migadu")]);
    const { svc } = service(f, async () => ({
      imap: { ok: false, ms: 900, error: new MailProviderError("The mail server rejected the username or password.", "auth", { stage: "imap" }) },
      smtp: { ok: true, ms: 700 },
    }));
    const err = (await svc.testImapConnection(tl, body("ram@migadu-domain.test"), "req-123").catch((e: unknown) => e)) as AppError;
    expect(err.message).toMatch(/^IMAP: The mail server rejected/);
    expect(err.details).toMatchObject({
      requestId: "req-123",
      mailboxCheck: { provider: "migadu", imap: { ok: false, code: "auth", host: "imap.migadu.com" }, smtp: { ok: true, host: "smtp.migadu.com" } },
    });
    expect(JSON.stringify(err.details)).not.toContain(PASSWORD.trim());
  });
});

describe("MX provider detection", () => {
  it("reads Migadu and Spacemail from MX hosts and ignores a domain's own server", () => {
    expect(providerFromMx([{ exchange: "mx2.spacemail.com.", priority: 20 }, { exchange: "mx1.spacemail.com.", priority: 10 }])).toBe(
      "spacemail",
    );
    expect(providerFromMx([{ exchange: "aspmx1.migadu.com", priority: 10 }])).toBe("migadu");
    expect(providerFromMx([{ exchange: "mail.entegrasources.com.np", priority: 10 }])).toBeNull();
    expect(isSelfHostedMx("entegrasources.com.np", [{ exchange: "entegrasources.com.np", priority: 10 }])).toBe(true);
    expect(isSelfHostedMx("entegrasources.com", [{ exchange: "mx1.spacemail.com", priority: 10 }])).toBe(false);
    expect(providerFromMx([])).toBeNull();
  });
});

describe("domain mapping validation", () => {
  it("normalises domains and rejects addresses or junk", () => {
    expect(normalizeDomain("  @Example.COM. ")).toBe("example.com");
    expect(() => normalizeDomain("someone@example.com")).toThrow(/Enter a domain/);
    expect(() => normalizeDomain("localhost")).toThrow(/Enter a domain/);
    expect(domainOfEmail("A@Sub.Example.com")).toBe("sub.example.com");
  });

  it("pins Migadu/Spacemail to their presets and requires hosts for a custom server", () => {
    const m = validateDomainProvider({ domain: "a.test", provider: "Migadu", imapHost: "ignored.test" });
    expect(m).toMatchObject({ domain: "a.test", provider: "migadu", imapHost: "" });
    expect(settingsForDomainProvider(m).imapHost).toBe("imap.migadu.com");
    expect(() => validateDomainProvider({ domain: "a.test", provider: "imap" })).toThrow(/IMAP server/);
    expect(() => validateDomainProvider({ domain: "a.test", provider: "gmail" })).toThrow(/Choose Migadu, Spacemail/);
    expect(() => validateDomainProvider({ domain: "a.test", provider: "imap", imapHost: "h", smtpHost: "h", smtpPort: 70000 })).toThrow(
      /Port must be/,
    );
  });
});

describe("domain mapping admin API", () => {
  it("rejects a team lead whose email:configure is only implied by team-scoped email:manage", async () => {
    const f = fakeDb();
    f.queue(
      [userRow({ roleCode: "sales_manager", roleName: "Team Lead" })],
      [{ code: "email:view", scope: "team" }, { code: "email:manage", scope: "team" }],
      [],
      [],
    );
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/email/domain-providers")
      .set("Authorization", bearer())
      .send({ domain: "a.test", provider: "migadu" });
    expect([res.status, res.body.error.message]).toEqual([403, "Only an administrator can manage mail domains"]);
    expect(f.queries).toHaveLength(4);
  });

  it("lets an administrator list mappings", async () => {
    const f = fakeDb();
    queueAuth(f, "email:configure");
    f.queue([row("a.test", "migadu"), row("b.test", "spacemail")]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/email/domain-providers")
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { domain: string; provider: string }) => `${i.domain}:${i.provider}`)).toEqual([
      "a.test:migadu",
      "b.test:spacemail",
    ]);
  });
});

describe("nextUidBatch", () => {
  it("returns the next ascending batch after the cursor", async () => {
    const { nextUidBatch } = await import("../src/modules/email/imap-smtp.js");
    expect(nextUidBatch([9, 3, 7, 5, 7], 4, 2)).toEqual([5, 7]);
  });

  it("ignores the newest message that `N:*` returns when nothing is new", async () => {
    const { nextUidBatch } = await import("../src/modules/email/imap-smtp.js");
    expect(nextUidBatch([120], 120, 40)).toEqual([]);
  });
});
