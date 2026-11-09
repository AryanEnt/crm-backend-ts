import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { buildRfc822, parseAddress, parseAddressList } from "./mime.js";
import {
  MailProviderError,
  classifyMailError,
  type DiscoveredFolders,
  type FetchedMail,
  type FolderCursor,
  type MailConnectionCheck,
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
const CONNECT_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 15_000;

function imapClient(settings: ImapSmtpSettings, auth: MailboxAuth) {
  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    // true = implicit TLS from the first byte (993); false = plain then STARTTLS (143).
    secure: settings.imapSecure,
    servername: settings.imapHost,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    logger: false,
  });
  // ImapFlow re-emits socket failures as "error"; without a listener Node treats them as fatal.
  client.on("error", () => undefined);
  return client;
}

/** Logs out a connected client, or tears down the socket when login never completed. */
async function closeImap(client: ImapFlow): Promise<void> {
  if (client.usable) {
    await client.logout().catch(() => client.close());
  } else {
    client.close();
  }
}

function smtpTransport(settings: ImapSmtpSettings, auth: MailboxAuth) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    // true = implicit TLS (465); false = STARTTLS upgrade when the server offers it (587).
    secure: settings.smtpSecure,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true, servername: settings.smtpHost },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: 60_000,
  });
}

const classify = classifyMailError;

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

  async testImap(auth: MailboxAuth): Promise<DiscoveredFolders> {
    if (!this.settings.imapHost.trim()) {
      throw new MailProviderError("IMAP host is not configured.", "network", { stage: "imap" });
    }
    const client = imapClient(this.settings, auth);
    try {
      await client.connect();
    } catch (err) {
      await closeImap(client);
      throw classify(err, "imap");
    }
    try {
      const listed = await client.list();
      const folders = pickFolders(listed);
      try {
        await client.mailboxOpen(folders.inbox);
      } catch (err) {
        const e = classify(err, "imap");
        throw e.code === "reject"
          ? new MailProviderError(`Signed in, but the inbox (${folders.inbox}) could not be opened.`, "reject", { cause: err, stage: "imap" })
          : e;
      }
      return folders;
    } catch (err) {
      throw classify(err, "imap");
    } finally {
      await closeImap(client);
    }
  }

  async testSmtp(auth: MailboxAuth): Promise<void> {
    if (!this.settings.smtpHost.trim()) {
      throw new MailProviderError("SMTP host is not configured.", "network", { stage: "smtp" });
    }
    const transport = smtpTransport(this.settings, auth);
    try {
      await transport.verify();
    } catch (err) {
      throw classify(err, "smtp");
    } finally {
      transport.close();
    }
  }

  /** Runs IMAP and SMTP independently so one failing never hides the other's result. */
  async checkConnection(auth: MailboxAuth): Promise<MailConnectionCheck> {
    const timed = async <T>(fn: () => Promise<T>) => {
      const started = Date.now();
      try {
        return { ok: true as const, value: await fn(), ms: Date.now() - started };
      } catch (err) {
        return { ok: false as const, error: classify(err), ms: Date.now() - started };
      }
    };
    const [imap, smtp] = await Promise.all([timed(() => this.testImap(auth)), timed(() => this.testSmtp(auth))]);
    return {
      imap: imap.ok ? { ok: true, ms: imap.ms, folders: imap.value } : { ok: false, ms: imap.ms, error: imap.error },
      smtp: smtp.ok ? { ok: true, ms: smtp.ms } : { ok: false, ms: smtp.ms, error: smtp.error },
    };
  }

  async testConnection(auth: MailboxAuth): Promise<DiscoveredFolders> {
    const folders = await this.testImap(auth);
    await this.testSmtp(auth);
    return folders;
  }

  async send(auth: MailboxAuth, mail: SendMailInput): Promise<SendMailResult> {
    if (!this.settings.smtpHost.trim()) {
      throw new MailProviderError("SMTP host is not configured.", "network");
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
        attachments: (mail.attachments ?? []).map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.mimeType || "application/octet-stream",
          ...(a.contentId
            ? { cid: a.contentId, contentDisposition: "inline" as const }
            : { contentDisposition: "attachment" as const }),
        })),
        envelope: { from: mail.fromAddress, to: [...mail.to, ...mail.cc, ...mail.bcc] },
      });
      const providerMessageId = String(info.messageId || "").trim() || `smtp:${Date.now()}`;
      if (mail.sentFolder) {
        await this.appendSent(auth, mail, providerMessageId, mail.sentFolder).catch(() => undefined);
      }
      return { providerMessageId, providerThreadId: threadIdOf({ messageId: providerMessageId }, providerMessageId) };
    } catch (err) {
      throw classify(err, "smtp");
    } finally {
      transport.close();
    }
  }

  private async appendSent(auth: MailboxAuth, mail: SendMailInput, messageId: string, path: string): Promise<void> {
    // Rebuild with the same multipart/related CID structure nodemailer used for SMTP.
    let raw = buildRfc822(
      mail.fromName,
      mail.fromAddress,
      {
        toAddresses: mail.to,
        ccAddresses: mail.cc,
        bccAddresses: mail.bcc,
        subject: mail.subject,
        bodyHtml: mail.html,
        bodyText: mail.text,
      },
      (mail.attachments ?? []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        content: a.content,
        contentId: a.contentId,
      })),
    );
    // Message-ID after headers start; insert before MIME-Version if present.
    raw = raw.replace(/\r\nMIME-Version:/, `\r\nMessage-ID: ${messageId}\r\nMIME-Version:`);
    const client = imapClient(this.settings, auth);
    try {
      await client.connect();
      await client.append(path, Buffer.from(raw), ["\\Seen"]);
    } finally {
      await closeImap(client);
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
      throw classify(err, "imap");
    } finally {
      await closeImap(client);
    }
  }
}
