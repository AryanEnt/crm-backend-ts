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

export interface MailTransport {
  capabilities(): ProviderCapabilities;
  testConnection(auth: MailboxAuth): Promise<DiscoveredFolders>;
  send(auth: MailboxAuth, mail: SendMailInput): Promise<SendMailResult>;
  fetchFolder(
    auth: MailboxAuth,
    folder: MailFolderKind,
    path: string,
    cursor: FolderCursor,
  ): Promise<{ messages: FetchedMail[]; cursor: FolderCursor; path: string }>;
}

export class MailProviderError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "tls" | "network" | "quota" | "reject" | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "MailProviderError";
  }
}

export function safeMailError(err: unknown): { message: string; code: MailProviderError["code"] } {
  if (err instanceof MailProviderError) return { message: err.message, code: err.code };
  const raw = err instanceof Error ? err.message : "Mail server error";
  const lower = raw.toLowerCase();
  if (lower.includes("auth") || lower.includes("invalid login") || lower.includes("authentication")) {
    return { message: "Mailbox username or password was rejected.", code: "auth" };
  }
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl")) {
    return { message: "Could not verify the mail server’s security certificate.", code: "tls" };
  }
  if (lower.includes("quota")) return { message: "Mailbox quota exceeded.", code: "quota" };
  if (lower.includes("econnrefused") || lower.includes("timeout") || lower.includes("enotfound")) {
    return { message: "Could not reach the mail server. Check host and port.", code: "network" };
  }
  return { message: "Could not complete the mail operation. Try again.", code: "unknown" };
}
