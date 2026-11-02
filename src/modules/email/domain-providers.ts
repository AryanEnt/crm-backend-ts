import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import type { ImapSmtpSettings } from "./imap-smtp.js";
import { IMAP_PRESETS, type ImapProviderKind } from "./imap-presets.js";

export type DomainProvider = {
  id: string;
  domain: string;
  provider: ImapProviderKind;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type DomainProviderInput = {
  domain: string;
  provider: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  isActive?: boolean;
};

export const DOMAIN_PROVIDER_KINDS: readonly ImapProviderKind[] = ["migadu", "spacemail", "imap"];

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** "  @Example.COM. " -> "example.com"; throws when it isn't a hostname. */
export function normalizeDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^@+/, "").replace(/\.$/, "");
  if (!DOMAIN_RE.test(d)) throw AppError.fieldValidation("domain", "Enter a domain like company.com, without the @ or a mailbox name");
  return d;
}

/** The part after the last "@", lower-cased; "" when the address has no domain. */
export function domainOfEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
}

function port(v: number | undefined, fallback: number, field: string): number {
  const p = v ?? fallback;
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw AppError.fieldValidation(field, "Port must be between 1 and 65535");
  return p;
}

/**
 * Validates an admin mapping. Migadu and Spacemail always use their fixed presets, so any host
 * fields sent with them are ignored; a custom server must name both hosts.
 */
export function validateDomainProvider(in_: DomainProviderInput): Omit<DomainProvider, "id" | "createdAt" | "updatedAt"> {
  const domain = normalizeDomain(in_.domain);
  const provider = in_.provider.trim().toLowerCase() as ImapProviderKind;
  if (!DOMAIN_PROVIDER_KINDS.includes(provider)) {
    throw AppError.fieldValidation("provider", "Choose Migadu, Spacemail or a custom server");
  }
  const isActive = in_.isActive ?? true;
  if (provider !== "imap") {
    return { domain, provider, imapHost: "", imapPort: 993, imapSecure: true, smtpHost: "", smtpPort: 465, smtpSecure: true, isActive };
  }
  const imapHost = (in_.imapHost ?? "").trim().toLowerCase();
  const smtpHost = (in_.smtpHost ?? "").trim().toLowerCase();
  if (!imapHost) throw AppError.fieldValidation("imapHost", "Enter the IMAP server for a custom provider");
  if (!smtpHost) throw AppError.fieldValidation("smtpHost", "Enter the SMTP server for a custom provider");
  return {
    domain,
    provider,
    imapHost,
    imapPort: port(in_.imapPort, 993, "imapPort"),
    imapSecure: in_.imapSecure ?? true,
    smtpHost,
    smtpPort: port(in_.smtpPort, 465, "smtpPort"),
    smtpSecure: in_.smtpSecure ?? true,
    isActive,
  };
}

/** Server settings a mapping stands for: the preset for Migadu/Spacemail, its own hosts for custom. */
export function settingsForDomainProvider(m: Pick<DomainProvider, "provider" | "imapHost" | "imapPort" | "imapSecure" | "smtpHost" | "smtpPort" | "smtpSecure">): ImapSmtpSettings {
  if (m.provider === "migadu" || m.provider === "spacemail") return { ...IMAP_PRESETS[m.provider] };
  return {
    imapHost: m.imapHost,
    imapPort: m.imapPort,
    imapSecure: m.imapSecure,
    smtpHost: m.smtpHost,
    smtpPort: m.smtpPort,
    smtpSecure: m.smtpSecure,
  };
}

const select = sql`
  SELECT id::text AS "id", domain, provider, imap_host AS "imapHost", imap_port AS "imapPort",
    imap_secure AS "imapSecure", smtp_host AS "smtpHost", smtp_port AS "smtpPort", smtp_secure AS "smtpSecure",
    is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM email_domain_providers`;

export class DomainProviderRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<DomainProvider[]> {
    const r = await sql<DomainProvider>`${select} ORDER BY domain`.execute(this.db);
    return r.rows;
  }

  async get(id: string): Promise<DomainProvider | null> {
    const r = await sql<DomainProvider>`${select} WHERE id=${id}::uuid`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async activeForDomain(domain: string): Promise<DomainProvider | null> {
    if (!domain) return null;
    const r = await sql<DomainProvider>`${select} WHERE domain=${domain} AND is_active`.execute(this.db);
    return r.rows[0] ?? null;
  }

  /** Saves a detected mapping. Returns null when the domain already has one, without changing it. */
  async insertIfAbsent(v: ReturnType<typeof validateDomainProvider>, actorId: string): Promise<DomainProvider | null> {
    const r = await sql<{ id: string }>`
      INSERT INTO email_domain_providers (
        id, domain, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        is_active, created_by, updated_by
      ) VALUES (
        ${randomUUID()}, ${v.domain}, ${v.provider}, ${v.imapHost}, ${v.imapPort}, ${v.imapSecure},
        ${v.smtpHost}, ${v.smtpPort}, ${v.smtpSecure}, ${v.isActive}, ${actorId}, ${actorId}
      )
      ON CONFLICT (domain) DO NOTHING
      RETURNING id::text AS "id"`.execute(this.db);
    return r.rows[0] ? this.get(r.rows[0].id) : null;
  }

  async insert(v: ReturnType<typeof validateDomainProvider>, actorId: string): Promise<DomainProvider> {
    try {
      const r = await sql<{ id: string }>`
        INSERT INTO email_domain_providers (
          id, domain, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
          is_active, created_by, updated_by
        ) VALUES (
          ${randomUUID()}, ${v.domain}, ${v.provider}, ${v.imapHost}, ${v.imapPort}, ${v.imapSecure},
          ${v.smtpHost}, ${v.smtpPort}, ${v.smtpSecure}, ${v.isActive}, ${actorId}, ${actorId}
        ) RETURNING id::text AS "id"`.execute(this.db);
      return (await this.get(r.rows[0]!.id))!;
    } catch (err) {
      throw uniqueDomain(err, v.domain);
    }
  }

  async update(id: string, v: ReturnType<typeof validateDomainProvider>, actorId: string): Promise<DomainProvider | null> {
    try {
      const r = await sql<{ id: string }>`
        UPDATE email_domain_providers SET
          domain=${v.domain}, provider=${v.provider}, imap_host=${v.imapHost}, imap_port=${v.imapPort},
          imap_secure=${v.imapSecure}, smtp_host=${v.smtpHost}, smtp_port=${v.smtpPort}, smtp_secure=${v.smtpSecure},
          is_active=${v.isActive}, updated_by=${actorId}, updated_at=NOW()
        WHERE id=${id}::uuid
        RETURNING id::text AS "id"`.execute(this.db);
      return r.rows[0] ? this.get(r.rows[0].id) : null;
    } catch (err) {
      throw uniqueDomain(err, v.domain);
    }
  }

  async delete(id: string): Promise<DomainProvider | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    await sql`DELETE FROM email_domain_providers WHERE id=${id}::uuid`.execute(this.db);
    return existing;
  }
}

function uniqueDomain(err: unknown, domain: string): unknown {
  if ((err as { code?: string })?.code === "23505") {
    return AppError.conflict(`${domain} already has a mail provider. Edit that entry instead.`);
  }
  return err;
}
