import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { parseAddress, parseAddressList } from "./mime.js";
import {
  MailProviderError,
  type DiscoveredFolders,
  type FetchedMail,
  type FolderCursor,
  type MailFolderKind,
  type MailTransport,
  type MailboxAuth,
  type ProviderCapabilities,
  type SendMailInput,
  type SendMailResult,
} from "./mail-provider.js";
import { sanitizeEmailHtml } from "./sanitize.js";

export type ImapSmtpSettings = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
};

const FETCH_BATCH = 40;

function imapClient(settings: ImapSmtpSettings, auth: MailboxAuth) {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapSecure,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true },
    logger: false,
  });
}

function smtpTransport(settings: ImapSmtpSettings, auth: MailboxAuth) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true },
  });
}

function classify(err: unknown): MailProviderError {
  const raw = err instanceof Error ? err.message : "Mail server error";
  const lower = raw.toLowerCase();
  if (lower.includes("auth") || lower.includes("login") || lower.includes("credentials")) {
    return new MailProviderError("Mailbox username or password was rejected.", "auth");
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("unable to verify")) {
    return new MailProviderError("Could not verify the mail server’s security certificate.", "tls");
  }
  if (lower.includes("econnrefused") || lower.includes("timeout") || lower.includes("enotfound")) {
    return new MailProviderError("Could not reach the mail server. Check host and port.", "network");
  }
  return new MailProviderError("Could not complete the mail operation. Try again.", "unknown");
}

export function pickFolders(boxes: { path: string; specialUse?: string; name?: string; listed?: boolean }[]): DiscoveredFolders {
  let inbox = "";
  let sent = "";
  for (const b of boxes) {
    const path = b.path || "";
    const special = (b.specialUse || "").toUpperCase();
    const name = (b.name || path).toLowerCase();
    if (!inbox && (special === "\\INBOX" || path.toUpperCase() === "INBOX" || name === "inbox")) inbox = path || "INBOX";
    if (!sent && (special === "\\SENT" || name.includes("sent") || name.includes("sent items"))) sent = path;
  }
  return { inbox: inbox || "INBOX", sent };
}

function messageIdOf(parsed: { messageId?: string }, uid: number, path: string): string {
  const id = (parsed.messageId || "").trim();
  if (id) return id;
  return `imap:${path}:${uid}`;
}

function threadIdOf(parsed: { inReplyTo?: string; references?: string | string[]; messageId?: string }, providerMessageId: string): string {
  const raw = parsed.references;
  const refs = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const root = refs[0] || parsed.inReplyTo || parsed.messageId || providerMessageId;
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

function addressText(value: { text?: string } | { text?: string }[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((v) => v.text || "").join(", ");
  return value.text || "";
}

function asDate(value: Date | string | undefined | null, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

export class ImapSmtpTransport implements MailTransport {
  constructor(private readonly settings: ImapSmtpSettings) {}

  capabilities(): ProviderCapabilities {
    return { kind: "imap", send: true, syncInbox: true, syncSent: true, idle: false };
  }

  async testConnection(auth: MailboxAuth): Promise<DiscoveredFolders> {
    if (!this.settings.imapHost.trim()) {
      throw new MailProviderError("Company mail host is not configured.", "network");
    }
    const client = imapClient(this.settings, auth);
    try {
      await client.connect();
      const listed = await client.list();
      const folders = pickFolders(listed);
      await client.mailboxOpen(folders.inbox);
      return folders;
    } catch (err) {
      throw classify(err);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async send(auth: MailboxAuth, mail: SendMailInput): Promise<SendMailResult> {
    if (!this.settings.smtpHost.trim()) {
      throw new MailProviderError("Company SMTP host is not configured.", "network");
    }
    const transport = smtpTransport(this.settings, auth);
    try {
      const info = await transport.sendMail({
        from: mail.fromName ? `"${mail.fromName.replace(/"/g, "")}" <${mail.fromAddress}>` : mail.fromAddress,
        to: mail.to,
        cc: mail.cc.length ? mail.cc : undefined,
        bcc: mail.bcc.length ? mail.bcc : undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        inReplyTo: mail.inReplyTo,
        envelope: { from: mail.fromAddress, to: [...mail.to, ...mail.cc, ...mail.bcc] },
      });
      const providerMessageId = String(info.messageId || "").trim() || `smtp:${Date.now()}`;
      return { providerMessageId, providerThreadId: threadIdOf({ messageId: providerMessageId }, providerMessageId) };
    } catch (err) {
      throw classify(err);
    } finally {
      transport.close();
    }
  }

  async fetchFolder(
    auth: MailboxAuth,
    folder: MailFolderKind,
    path: string,
    cursor: FolderCursor,
  ): Promise<{ messages: FetchedMail[]; cursor: FolderCursor; path: string }> {
    if (!path) return { messages: [], cursor, path };
    const client = imapClient(this.settings, auth);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(path);
      try {
        const mailbox = client.mailbox || null;
        const uidValidity = Number(mailbox?.uidValidity ?? 0);
        let lastUid = cursor.uid;
        if (uidValidity !== cursor.uidValidity) lastUid = 0;
        const range = lastUid > 0 ? `${lastUid + 1}:*` : "1:*";
        const messages: FetchedMail[] = [];
        let maxUid = lastUid;
        let n = 0;
        for await (const msg of client.fetch(
          { uid: range },
          { uid: true, envelope: true, source: true, internalDate: true },
        )) {
          if (n >= FETCH_BATCH) break;
          const uid = Number(msg.uid);
          if (!uid || uid <= lastUid) continue;
          const parsed = await simpleParser(msg.source ?? Buffer.alloc(0));
          const fromRaw = parsed.from?.text || "";
          const { name: fromName, addr: fromAddress } = parseAddress(fromRaw);
          const to = parseAddressList(addressText(parsed.to));
          const cc = parseAddressList(addressText(parsed.cc));
          const bcc = parseAddressList(addressText(parsed.bcc));
          const html = sanitizeEmailHtml(typeof parsed.html === "string" ? parsed.html : "");
          const text = parsed.text || "";
          const providerMessageId = messageIdOf(parsed, uid, path);
          messages.push({
            providerMessageId,
            providerThreadId: threadIdOf(parsed, providerMessageId),
            uid,
            fromAddress,
            fromName,
            to,
            cc,
            bcc,
            subject: parsed.subject || "",
            html,
            text,
            date: asDate(parsed.date ?? msg.internalDate, new Date()),
            folder,
          });
          if (uid > maxUid) maxUid = uid;
          n++;
        }
        return {
          messages,
          cursor: { uidValidity, uid: maxUid },
          path,
        };
      } finally {
        lock.release();
      }
    } catch (err) {
      throw classify(err);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
