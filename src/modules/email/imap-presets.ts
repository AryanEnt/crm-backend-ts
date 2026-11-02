import type { ImapSmtpSettings } from "./imap-smtp.js";

export type ImapProviderKind = "migadu" | "spacemail" | "imap";

export const IMAP_PRESETS: Record<Exclude<ImapProviderKind, "imap">, ImapSmtpSettings> = {
  migadu: {
    imapHost: "imap.migadu.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.migadu.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  spacemail: {
    imapHost: "mail.spacemail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "mail.spacemail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
};

export function isImapProvider(provider: string): boolean {
  return provider === "imap" || provider === "migadu" || provider === "spacemail";
}

export function normalizeImapProvider(provider: string): ImapProviderKind {
  const p = provider.trim().toLowerCase();
  if (p === "migadu" || p === "spacemail") return p;
  return "imap";
}

export function resolveImapSettings(
  provider: string,
  override: Partial<ImapSmtpSettings>,
  fallback?: ImapSmtpSettings,
): ImapSmtpSettings {
  const kind = normalizeImapProvider(provider);
  const base = kind === "imap" ? fallback : IMAP_PRESETS[kind];
  // A blank host from a form means "use the preset / company server", not "no server".
  const host = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  return {
    imapHost: (host(override.imapHost) ?? base?.imapHost ?? "").trim(),
    imapPort: override.imapPort ?? base?.imapPort ?? 993,
    imapSecure: override.imapSecure ?? base?.imapSecure ?? true,
    smtpHost: (host(override.smtpHost) ?? base?.smtpHost ?? "").trim(),
    smtpPort: override.smtpPort ?? base?.smtpPort ?? 465,
    smtpSecure: override.smtpSecure ?? base?.smtpSecure ?? true,
  };
}
