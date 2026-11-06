export type MailFolderKind = "inbox" | "sent";

export type MailboxAuth = {
  user: string;
  pass: string;
};

export type DiscoveredFolders = {
  inbox: string;
  sent: string;
};

export type FolderCursor = {
  uidValidity: number;
  uid: number;
};

export type FetchedMail = {
  providerMessageId: string;
  providerThreadId: string;
  uid: number;
  fromAddress: string;
  fromName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  date: Date;
  folder: MailFolderKind;
};

export type SendMailAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export type SendMailInput = {
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  sentFolder?: string;
  attachments?: SendMailAttachment[];
};

export type SendMailResult = {
  providerMessageId: string;
  providerThreadId: string;
};

export type ProviderCapabilities = {
  kind: "gmail" | "imap";
  send: boolean;
  syncInbox: boolean;
  syncSent: boolean;
  idle: boolean;
};

export type MailConnectionCheck = {
  imap: { ok: true; ms: number; folders: DiscoveredFolders } | { ok: false; ms: number; error: MailProviderError };
  smtp: { ok: true; ms: number } | { ok: false; ms: number; error: MailProviderError };
};

export interface MailTransport {
  capabilities(): ProviderCapabilities;
  testConnection(auth: MailboxAuth): Promise<DiscoveredFolders>;
  checkConnection?(auth: MailboxAuth): Promise<MailConnectionCheck>;
  testSmtp?(auth: MailboxAuth): Promise<void>;
  send(auth: MailboxAuth, mail: SendMailInput): Promise<SendMailResult>;
  fetchFolder(
    auth: MailboxAuth,
    folder: MailFolderKind,
    path: string,
    cursor: FolderCursor,
  ): Promise<{ messages: FetchedMail[]; cursor: FolderCursor; path: string }>;
}

export type MailErrorCode = "auth" | "tls" | "network" | "timeout" | "quota" | "reject" | "unknown";
export type MailStage = "imap" | "smtp";

/** Allowlisted fields from an ImapFlow / Nodemailer / socket error. Never holds credentials. */
export type MailErrorDiagnostics = {
  name?: string;
  code?: string;
  message?: string;
  authenticationFailed?: boolean;
  responseStatus?: string;
  serverResponseCode?: string;
  responseText?: string;
  responseCode?: number;
  command?: string;
};

export class MailProviderError extends Error {
  readonly stage: MailStage | undefined;
  readonly diagnostics: MailErrorDiagnostics;

  constructor(
    message: string,
    readonly code: MailErrorCode = "unknown",
    options: { cause?: unknown; stage?: MailStage } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MailProviderError";
    this.stage = options.stage;
    this.diagnostics = options.cause === undefined ? {} : mailErrorDiagnostics(options.cause);
  }
}

const MAX_DIAG_TEXT = 200;

function clip(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  return v.length > MAX_DIAG_TEXT ? `${v.slice(0, MAX_DIAG_TEXT)}…` : v;
}

/** AUTH commands can carry base64 credentials in some libraries; keep only the verb. */
function safeCommand(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  const verb = v.trim().split(/\s+/).slice(0, 2).join(" ");
  return /^auth\b|^login\b/i.test(verb) ? verb.split(" ")[0]!.toUpperCase() : clip(verb);
}

export function mailErrorDiagnostics(err: unknown): MailErrorDiagnostics {
  if (!err || typeof err !== "object") return { message: clip(String(err)) };
  const e = err as Record<string, unknown>;
  const out: MailErrorDiagnostics = {
    name: clip(e.name),
    code: clip(e.code),
    message: clip(e.message),
    responseStatus: clip(e.responseStatus),
    serverResponseCode: clip(e.serverResponseCode),
    responseText: clip(e.responseText) ?? clip(e.response),
    command: safeCommand(e.command),
  };
  if (typeof e.authenticationFailed === "boolean") out.authenticationFailed = e.authenticationFailed;
  if (typeof e.responseCode === "number") out.responseCode = e.responseCode;
  for (const k of Object.keys(out) as (keyof MailErrorDiagnostics)[]) if (out[k] === undefined) delete out[k];
  return out;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "NoConnection",
  "ESOCKET",
  "ECONNECTION",
  "EConnectionClosed",
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

function isCertificateError(code: string, text: string): boolean {
  return (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS_CERT") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    text.includes("certificate") ||
    text.includes("self signed") ||
    text.includes("self-signed") ||
    text.includes("unable to verify")
  );
}

function isTlsModeMismatch(code: string, text: string): boolean {
  return (
    code === "ERR_SSL_WRONG_VERSION_NUMBER" ||
    code === "EPROTO" ||
    text.includes("wrong version number") ||
    text.includes("packet length too long") ||
    text.includes("unknown protocol")
  );
}

/**
 * Maps a raw IMAP/SMTP/socket failure to a safe, actionable message. The original error is
 * kept as `cause` (with allowlisted `diagnostics`) for server logs only.
 */
export function classifyMailError(err: unknown, stage?: MailStage): MailProviderError {
  if (err instanceof MailProviderError) {
    if (stage && !err.stage) return new MailProviderError(err.message, err.code, { cause: err.cause ?? err, stage });
    return err;
  }
  const d = mailErrorDiagnostics(err);
  const code = d.code ?? "";
  const text = `${d.message ?? ""} ${d.responseText ?? ""}`.toLowerCase();
  const serverCode = (d.serverResponseCode ?? "").toUpperCase();
  const opts = { cause: err, stage };

  if (
    d.authenticationFailed === true ||
    serverCode === "AUTHENTICATIONFAILED" ||
    serverCode === "AUTHORIZATIONFAILED" ||
    code === "EAUTH" ||
    d.responseCode === 535 ||
    d.responseCode === 534 ||
    text.includes("authentication failed") ||
    text.includes("invalid login") ||
    text.includes("invalid credentials")
  ) {
    return new MailProviderError(
      "The mail server rejected the username or password. Use the full email address as the username and the mailbox password, and check that IMAP/SMTP access is enabled for this mailbox.",
      "auth",
      opts,
    );
  }
  if (isTlsModeMismatch(code, text)) {
    return new MailProviderError(
      "The secure connection could not start. Check the port and SSL/TLS setting (993 and 465 use SSL/TLS; 143 and 587 use STARTTLS).",
      "tls",
      opts,
    );
  }
  if (isCertificateError(code, text)) {
    return new MailProviderError("Could not verify the mail server’s security certificate. Check the host name.", "tls", opts);
  }
  if (TIMEOUT_CODES.has(code) || text.includes("timeout") || text.includes("timed out") || text.includes("greeting never received")) {
    return new MailProviderError(
      "The mail server did not respond in time. Check the host, port and SSL/TLS setting, and that this server can reach it.",
      "timeout",
      opts,
    );
  }
  if (NETWORK_CODES.has(code) || text.includes("econnrefused") || text.includes("enotfound") || text.includes("connection closed")) {
    return new MailProviderError("Could not reach the mail server. Check the host and port.", "network", opts);
  }
  if (text.includes("quota") || serverCode === "OVERQUOTA" || serverCode === "LIMIT") {
    return new MailProviderError("The mailbox is over its quota or a provider limit.", "quota", opts);
  }
  if (serverCode === "UNAVAILABLE" || serverCode === "CONTACTADMIN") {
    return new MailProviderError(
      "The mail server says this mailbox is temporarily unavailable or needs attention from the provider.",
      "reject",
      opts,
    );
  }
  if (d.responseStatus === "NO" || d.responseStatus === "BAD" || (d.responseCode !== undefined && d.responseCode >= 400)) {
    return new MailProviderError("The mail server refused the request.", "reject", opts);
  }
  return new MailProviderError("Unexpected mail server error.", "unknown", opts);
}

export function safeMailError(err: unknown): { message: string; code: MailErrorCode } {
  const e = classifyMailError(err);
  return { message: e.message, code: e.code };
}
