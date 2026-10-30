import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type { Database } from "../../db/database.js";
import type { Claims } from "../auth/types.js";
import { and, appendScope, resolve, type Predicate } from "../datascope/datascope.js";
import { P } from "../permissions/permissions.js";
import { splitName } from "./mime.js";

type Json = Record<string, unknown>;

export interface AccountPublic {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string;
  avatarUrl: string;
  connectionStatus: string;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  lastSyncAt: Date | null;
  lastSyncError: string;
  createdAt: Date;
  ownerUserId?: string;
  ownerName?: string;
}

export interface AccountRecord extends AccountPublic {
  userId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  encryptedPassword: string;
  tokenExpiry: Date | null;
  gmailHistoryId: string;
  watchExpiration: Date | null;
  imapInboxFolder: string;
  imapSentFolder: string;
  imapInboxUidValidity: number;
  imapInboxUid: number;
  imapSentUidValidity: number;
  imapSentUid: number;
}

export interface ConnectionInvite {
  id: string;
  invitedUserId: string;
  invitedBy: string;
  emailAddress: string;
  provider: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface Thread {
  id: string;
  accountId: string;
  ownerUserId: string;
  ownerName: string;
  providerThreadId: string;
  leadId: string | null;
  leadName: string | null;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  participants: string[];
  subject: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string;
  messageCount: number;
  unreadCount: number;
  starred: boolean;
  archived: boolean;
  matchStatus: string;
  hasAttachments: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Attachment {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  providerAttachmentId: string;
}

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  ownerUserId: string;
  providerMessageId: string;
  providerThreadId: string;
  direction: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  snippet: string;
  sentAt: Date | null;
  receivedAt: Date | null;
  scheduledAt: Date | null;
  status: string;
  hasAttachments: boolean;
  inReplyTo: string | null;
  attachments: Attachment[] | null;
  createdAt: Date;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  category: string;
  variables: string[];
  isActive: boolean;
  createdBy: string | null;
  teamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadListFilter {
  folder: string;
  q: string;
  leadId: string;
  customerId: string;
  ownerUserId: string;
  direction: string;
  hasAttach: string;
  unread: string;
  dateFrom: string;
  dateTo: string;
  limit: number;
  offset: number;
}

export interface FolderCounts {
  inbox: number;
  sent: number;
  drafts: number;
  starred: number;
  unmatched: number;
  scheduled: number;
  archived: number;
}

export interface CrmMatch {
  leadId: string | null;
  leadName: string;
  customerId: string | null;
  customerName: string;
  count: number;
}

// ---------------------------------------------------------------- JSON shapes (Go struct order, omitempty)

export function accountJson(a: AccountPublic): Json {
  return {
    id: a.id,
    provider: a.provider,
    emailAddress: a.emailAddress,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    connectionStatus: a.connectionStatus,
    sendingEnabled: a.sendingEnabled,
    receivingEnabled: a.receivingEnabled,
    lastSyncAt: a.lastSyncAt,
    ...(a.lastSyncError !== "" && { lastSyncError: a.lastSyncError }),
    createdAt: a.createdAt,
  };
}

export function threadJson(t: Thread): Json {
  return {
    id: t.id,
    accountId: t.accountId,
    ownerUserId: t.ownerUserId,
    ...(t.ownerName !== "" && { ownerName: t.ownerName }),
    providerThreadId: t.providerThreadId,
    leadId: t.leadId,
    leadName: t.leadName,
    customerId: t.customerId,
    customerName: t.customerName,
    dealId: t.dealId,
    participants: t.participants,
    subject: t.subject,
    lastMessageAt: t.lastMessageAt,
    lastMessagePreview: t.lastMessagePreview,
    messageCount: t.messageCount,
    unreadCount: t.unreadCount,
    starred: t.starred,
    archived: t.archived,
    matchStatus: t.matchStatus,
    hasAttachments: t.hasAttachments,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function messageJson(m: Message): Json {
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    ownerUserId: m.ownerUserId,
    providerMessageId: m.providerMessageId,
    providerThreadId: m.providerThreadId,
    direction: m.direction,
    from: m.fromAddress,
    fromName: m.fromName,
    to: m.toAddresses,
    cc: m.ccAddresses,
    bcc: m.bccAddresses,
    subject: m.subject,
    bodyHtml: m.bodyHtml,
    bodyText: m.bodyText,
    snippet: m.snippet,
    sentAt: m.sentAt,
    receivedAt: m.receivedAt,
    scheduledAt: m.scheduledAt,
    status: m.status,
    hasAttachments: m.hasAttachments,
    inReplyTo: m.inReplyTo,
    ...(m.attachments && m.attachments.length > 0 && { attachments: m.attachments }),
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------- queries

const nilIfEmpty = (s: string | null): string | null => (s === null || s === "" ? null : s);

const accountSelect = sql`
  SELECT a.id::text AS "id", a.user_id::text AS "userId", a.provider, a.email_address AS "emailAddress",
    a.display_name AS "displayName", a.avatar_url AS "avatarUrl",
    a.encrypted_access_token AS "encryptedAccessToken", a.encrypted_refresh_token AS "encryptedRefreshToken",
    COALESCE(a.encrypted_password,'') AS "encryptedPassword",
    a.token_expiry AS "tokenExpiry", a.gmail_history_id AS "gmailHistoryId", a.watch_expiration AS "watchExpiration",
    a.connection_status AS "connectionStatus", a.sending_enabled AS "sendingEnabled", a.receiving_enabled AS "receivingEnabled",
    a.last_sync_at AS "lastSyncAt", a.last_sync_error AS "lastSyncError", a.created_at AS "createdAt",
    COALESCE(a.imap_inbox_folder,'') AS "imapInboxFolder", COALESCE(a.imap_sent_folder,'') AS "imapSentFolder",
    COALESCE(a.imap_inbox_uidvalidity,0)::float8 AS "imapInboxUidValidity",
    COALESCE(a.imap_inbox_uid,0)::float8 AS "imapInboxUid",
    COALESCE(a.imap_sent_uidvalidity,0)::float8 AS "imapSentUidValidity",
    COALESCE(a.imap_sent_uid,0)::float8 AS "imapSentUid"
  FROM email_accounts a`;

const threadSelect = sql`
  SELECT t.id::text AS "id", t.account_id::text AS "accountId", t.owner_user_id::text AS "ownerUserId",
    COALESCE(u.full_name,'') AS "ownerName", t.provider_thread_id AS "providerThreadId",
    t.lead_id::text AS "leadId", l.full_name AS "leadName", t.customer_id::text AS "customerId", c.full_name AS "customerName",
    t.deal_id::text AS "dealId", t.participants, t.subject, t.last_message_at AS "lastMessageAt",
    t.last_message_preview AS "lastMessagePreview", t.message_count AS "messageCount", t.unread_count AS "unreadCount",
    t.starred, t.archived, t.match_status AS "matchStatus",
    EXISTS(SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.has_attachments) AS "hasAttachments",
    t.created_at AS "createdAt", t.updated_at AS "updatedAt"
  FROM email_threads t
  LEFT JOIN users u ON u.id=t.owner_user_id
  LEFT JOIN leads l ON l.id=t.lead_id
  LEFT JOIN customers c ON c.id=t.customer_id`;

const messageSelect = sql`
  SELECT m.id::text AS "id", m.thread_id::text AS "threadId", m.account_id::text AS "accountId",
    m.owner_user_id::text AS "ownerUserId", m.provider_message_id AS "providerMessageId",
    m.provider_thread_id AS "providerThreadId", m.direction, m.from_address AS "fromAddress", m.from_name AS "fromName",
    m.to_addresses AS "toAddresses", m.cc_addresses AS "ccAddresses", m.bcc_addresses AS "bccAddresses",
    m.subject, m.body_html AS "bodyHtml", m.body_text AS "bodyText", m.snippet, m.sent_at AS "sentAt",
    m.received_at AS "receivedAt", m.scheduled_at AS "scheduledAt", m.status, m.has_attachments AS "hasAttachments",
    m.in_reply_to::text AS "inReplyTo", m.created_at AS "createdAt"
  FROM email_messages m`;

const templateSelect = sql`
  SELECT id::text AS "id", name, subject, body_html AS "bodyHtml", category, variables, is_active AS "isActive",
    created_by::text AS "createdBy", team_id::text AS "teamId", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM email_templates`;

const toThread = (t: Thread): Thread => ({
  ...t,
  leadId: nilIfEmpty(t.leadId),
  customerId: nilIfEmpty(t.customerId),
  dealId: nilIfEmpty(t.dealId),
  participants: t.participants ?? [],
});

const toMessage = (m: Omit<Message, "attachments">): Message => ({
  ...m,
  toAddresses: m.toAddresses ?? [],
  ccAddresses: m.ccAddresses ?? [],
  bccAddresses: m.bccAddresses ?? [],
  inReplyTo: nilIfEmpty(m.inReplyTo),
  attachments: null,
});

const toTemplate = (t: Template): Template => ({ ...t, variables: t.variables ?? [] });

/** Visibility of email threads for the caller (owner-only rows unless linked to the CRM). */
function threadScope(claims: Claims, ownerUserId: string): Predicate[] {
  const vis = resolve(claims, P.EmailView, ownerUserId);
  const where = appendScope([sql`TRUE`], vis, { owner: "t.owner_user_id" });
  const ownOnly = vis.ownerIds.length === 1 && vis.ownerIds[0] === claims.userId && vis.teamIds.length === 0 && !vis.unscoped;
  const assignedMailbox =
    ownerUserId !== "" &&
    ownerUserId !== claims.userId &&
    (vis.unscoped || vis.ownerIds.includes(ownerUserId));
  if (!ownOnly && !assignedMailbox) {
    where.push(sql`(t.lead_id IS NOT NULL OR t.customer_id IS NOT NULL OR t.match_status = 'needs_association')`);
  }
  return where;
}

const draftOnlyThread = sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.status='draft' AND NOT EXISTS (SELECT 1 FROM email_messages m2 WHERE m2.thread_id=t.id AND m2.status<>'draft'))`;
const hasSent = sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.direction='outbound' AND m.status IN ('sent','delivered','sending'))`;
const hasDraft = sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.status='draft')`;
const hasScheduled = sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.status='scheduled')`;

function folderFilter(folder: string): RawBuilder<unknown>[] {
  switch (folder) {
    case "sent":
      return [hasSent, sql`t.archived=FALSE`];
    case "drafts":
      return [hasDraft];
    case "starred":
      return [sql`t.starred=TRUE`];
    case "unmatched":
      return [sql`t.match_status IN ('unmatched','needs_association')`, sql`t.archived=FALSE`];
    case "scheduled":
      return [hasScheduled];
    case "archived":
      return [sql`t.archived=TRUE`];
    default:
      return [sql`t.archived=FALSE`, sql`NOT ${draftOnlyThread}`];
  }
}

export class EmailRepository {
  constructor(private readonly db: Database) {}

  async insertOAuthState(state: string, userId: string, redirect: string, exp: Date): Promise<void> {
    await sql`
      INSERT INTO email_oauth_states (state, user_id, redirect_to, expires_at)
      VALUES (${state}, ${userId}, ${redirect}, ${exp})`.execute(this.db);
  }

  /** Throws "invalid or expired oauth state" when no live state matches. */
  async consumeOAuthState(state: string): Promise<{ userId: string; redirect: string }> {
    const r = await sql<{ userId: string; redirect: string }>`
      DELETE FROM email_oauth_states
      WHERE state=${state} AND expires_at > NOW()
      RETURNING user_id::text AS "userId", redirect_to AS "redirect"`.execute(this.db);
    if (!r.rows[0]) throw new Error("invalid or expired oauth state");
    return r.rows[0];
  }

  async upsertAccount(rec: {
    userId: string;
    emailAddress: string;
    displayName: string;
    avatarUrl: string;
    connectionStatus: string;
    encryptedAccessToken: string;
    encryptedRefreshToken: string;
    tokenExpiry: Date | null;
    gmailHistoryId: string;
    lastSyncAt: Date | null;
  }): Promise<AccountRecord | null> {
    const r = await sql<{ id: string }>`
      INSERT INTO email_accounts (
        id, user_id, provider, email_address, display_name, avatar_url,
        encrypted_access_token, encrypted_refresh_token, token_expiry,
        gmail_history_id, watch_expiration, connection_status,
        sending_enabled, receiving_enabled, last_sync_at, last_sync_error
      ) VALUES (${randomUUID()}, ${rec.userId}, 'gmail', ${rec.emailAddress}, ${rec.displayName}, ${rec.avatarUrl},
        ${rec.encryptedAccessToken}, ${rec.encryptedRefreshToken}, ${rec.tokenExpiry},
        ${rec.gmailHistoryId}, NULL, ${rec.connectionStatus}, TRUE, TRUE, ${rec.lastSyncAt}, '')
      ON CONFLICT (user_id, email_address) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = CASE
          WHEN EXCLUDED.encrypted_refresh_token = '' THEN email_accounts.encrypted_refresh_token
          ELSE EXCLUDED.encrypted_refresh_token
        END,
        token_expiry = EXCLUDED.token_expiry,
        gmail_history_id = CASE
          WHEN EXCLUDED.gmail_history_id = '' THEN email_accounts.gmail_history_id
          ELSE EXCLUDED.gmail_history_id
        END,
        watch_expiration = COALESCE(EXCLUDED.watch_expiration, email_accounts.watch_expiration),
        connection_status = EXCLUDED.connection_status,
        sending_enabled = EXCLUDED.sending_enabled,
        receiving_enabled = EXCLUDED.receiving_enabled,
        last_sync_error = '',
        updated_at = NOW()
      RETURNING id::text AS "id"`.execute(this.db);
    return this.getAccount(r.rows[0]!.id);
  }

  async getAccount(id: string): Promise<AccountRecord | null> {
    const r = await sql<AccountRecord>`${accountSelect} WHERE a.id=${id}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async getAccountByUser(userId: string): Promise<AccountRecord | null> {
    const r = await sql<AccountRecord>`
      ${accountSelect}
      WHERE a.user_id=${userId} AND a.connection_status <> 'disconnected'
      ORDER BY a.updated_at DESC LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async getAccountByEmail(email: string): Promise<AccountRecord | null> {
    const r = await sql<AccountRecord>`
      ${accountSelect}
      WHERE lower(a.email_address)=lower(${email}) AND a.connection_status <> 'disconnected'
      LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async listAccountsForUser(userId: string): Promise<AccountPublic[]> {
    const r = await sql<AccountPublic>`
      SELECT a.id::text AS "id", a.provider, a.email_address AS "emailAddress", a.display_name AS "displayName",
        a.avatar_url AS "avatarUrl", a.connection_status AS "connectionStatus", a.sending_enabled AS "sendingEnabled",
        a.receiving_enabled AS "receivingEnabled", a.last_sync_at AS "lastSyncAt", a.last_sync_error AS "lastSyncError",
        a.created_at AS "createdAt"
      FROM email_accounts a
      WHERE a.user_id=${userId} AND a.connection_status <> 'disconnected'
      ORDER BY a.created_at`.execute(this.db);
    return r.rows;
  }

  async updateTokens(id: string, access: string, refresh: string, expiry: Date | null): Promise<void> {
    await sql`
      UPDATE email_accounts SET
        encrypted_access_token=${access},
        encrypted_refresh_token=CASE WHEN ${refresh}='' THEN encrypted_refresh_token ELSE ${refresh} END,
        token_expiry=${expiry},
        updated_at=NOW()
      WHERE id=${id}`.execute(this.db);
  }

  async updateWatch(id: string, historyId: string, exp: Date | null): Promise<void> {
    await sql`
      UPDATE email_accounts SET gmail_history_id=${historyId}, watch_expiration=${exp}, updated_at=NOW()
      WHERE id=${id}`.execute(this.db);
  }

  async updateSync(id: string, status: string, historyId: string, syncErr: string): Promise<void> {
    await sql`
      UPDATE email_accounts SET
        connection_status=${status},
        gmail_history_id=CASE WHEN ${historyId}='' THEN gmail_history_id ELSE ${historyId} END,
        last_sync_at=NOW(),
        last_sync_error=${syncErr},
        updated_at=NOW()
      WHERE id=${id}`.execute(this.db);
  }

  async disconnect(id: string): Promise<void> {
    await sql`
      UPDATE email_accounts SET
        connection_status='disconnected',
        encrypted_access_token='',
        encrypted_refresh_token='',
        encrypted_password='',
        token_expiry=NULL,
        updated_at=NOW()
      WHERE id=${id}`.execute(this.db);
  }

  async listAccountsNeedingWatch(): Promise<AccountRecord[]> {
    const r = await sql<AccountRecord>`
      ${accountSelect}
      WHERE a.provider='gmail' AND a.connection_status IN ('connected','syncing','error')
        AND (a.watch_expiration IS NULL OR a.watch_expiration < NOW() + INTERVAL '24 hours')`.execute(this.db);
    return r.rows;
  }

  async listImapAccountsDue(): Promise<AccountRecord[]> {
    const r = await sql<AccountRecord>`
      ${accountSelect}
      WHERE a.provider='imap' AND a.connection_status IN ('connected','syncing','error')`.execute(this.db);
    return r.rows;
  }

  async upsertImapAccount(rec: {
    userId: string;
    emailAddress: string;
    displayName: string;
    encryptedPassword: string;
    inboxFolder: string;
    sentFolder: string;
  }): Promise<AccountRecord | null> {
    const r = await sql<{ id: string }>`
      INSERT INTO email_accounts (
        id, user_id, provider, email_address, display_name, avatar_url,
        encrypted_access_token, encrypted_refresh_token, encrypted_password,
        connection_status, sending_enabled, receiving_enabled, last_sync_error,
        imap_inbox_folder, imap_sent_folder
      ) VALUES (
        ${randomUUID()}, ${rec.userId}, 'imap', ${rec.emailAddress}, ${rec.displayName}, '',
        '', '', ${rec.encryptedPassword},
        'connected', TRUE, TRUE, '',
        ${rec.inboxFolder}, ${rec.sentFolder}
      )
      ON CONFLICT (user_id, email_address) DO UPDATE SET
        provider='imap',
        encrypted_password=EXCLUDED.encrypted_password,
        connection_status='connected',
        sending_enabled=TRUE,
        receiving_enabled=TRUE,
        last_sync_error='',
        imap_inbox_folder=EXCLUDED.imap_inbox_folder,
        imap_sent_folder=EXCLUDED.imap_sent_folder,
        updated_at=NOW()
      RETURNING id::text AS "id"`.execute(this.db);
    return this.getAccount(r.rows[0]!.id);
  }

  async updateImapCursor(
    id: string,
    folder: "inbox" | "sent",
    uidValidity: number,
    uid: number,
    path: string,
  ): Promise<void> {
    if (folder === "inbox") {
      await sql`
        UPDATE email_accounts SET
          imap_inbox_uidvalidity=${uidValidity}, imap_inbox_uid=${uid}, imap_inbox_folder=${path}, updated_at=NOW()
        WHERE id=${id}`.execute(this.db);
    } else {
      await sql`
        UPDATE email_accounts SET
          imap_sent_uidvalidity=${uidValidity}, imap_sent_uid=${uid}, imap_sent_folder=${path}, updated_at=NOW()
        WHERE id=${id}`.execute(this.db);
    }
  }

  async listAssignedPeople(userIds: string[]): Promise<{ userId: string; fullName: string; email: string }[]> {
    if (userIds.length === 0) return [];
    const r = await sql<{ userId: string; fullName: string; email: string }>`
      SELECT u.id::text AS "userId", u.full_name AS "fullName", COALESCE(u.email,'') AS "email"
      FROM users u WHERE u.id = ANY(${userIds}::uuid[]) AND u.is_active = TRUE
      ORDER BY u.full_name`.execute(this.db);
    return r.rows;
  }

  async listAccountsForUsers(userIds: string[]): Promise<(AccountPublic & { ownerUserId: string })[]> {
    if (userIds.length === 0) return [];
    const r = await sql<AccountPublic & { ownerUserId: string }>`
      SELECT a.id::text AS "id", a.provider, a.email_address AS "emailAddress", a.display_name AS "displayName",
        a.avatar_url AS "avatarUrl", a.connection_status AS "connectionStatus", a.sending_enabled AS "sendingEnabled",
        a.receiving_enabled AS "receivingEnabled", a.last_sync_at AS "lastSyncAt", a.last_sync_error AS "lastSyncError",
        a.created_at AS "createdAt", a.user_id::text AS "ownerUserId"
      FROM email_accounts a
      WHERE a.user_id = ANY(${userIds}::uuid[]) AND a.connection_status <> 'disconnected'
      ORDER BY a.created_at`.execute(this.db);
    return r.rows;
  }

  async insertInvite(rec: {
    tokenHash: string;
    invitedUserId: string;
    invitedBy: string;
    emailAddress: string;
    provider: string;
    expiresAt: Date;
  }): Promise<void> {
    await sql`
      INSERT INTO email_connection_invites (token_hash, invited_user_id, invited_by, email_address, provider, expires_at)
      VALUES (${rec.tokenHash}, ${rec.invitedUserId}, ${rec.invitedBy}, ${rec.emailAddress}, ${rec.provider}, ${rec.expiresAt})`.execute(
      this.db,
    );
  }

  async consumeInvite(tokenHash: string): Promise<ConnectionInvite | null> {
    const r = await sql<ConnectionInvite>`
      UPDATE email_connection_invites
      SET consumed_at=NOW()
      WHERE token_hash=${tokenHash} AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id::text AS "id", invited_user_id::text AS "invitedUserId", invited_by::text AS "invitedBy",
        email_address AS "emailAddress", provider, expires_at AS "expiresAt", consumed_at AS "consumedAt"`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async peekInvite(tokenHash: string): Promise<ConnectionInvite | null> {
    const r = await sql<ConnectionInvite>`
      SELECT id::text AS "id", invited_user_id::text AS "invitedUserId", invited_by::text AS "invitedBy",
        email_address AS "emailAddress", provider, expires_at AS "expiresAt", consumed_at AS "consumedAt"
      FROM email_connection_invites
      WHERE token_hash=${tokenHash} AND consumed_at IS NULL AND expires_at > NOW()`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async listScheduledDue(now: Date): Promise<Message[]> {
    const r = await sql<Omit<Message, "attachments">>`
      ${messageSelect}
      WHERE m.status='scheduled' AND m.scheduled_at IS NOT NULL AND m.scheduled_at <= ${now}`.execute(this.db);
    return r.rows.map(toMessage);
  }

  async healthCounts(): Promise<{ connected: number; attention: number }> {
    const r = await sql<{ connected: number; attention: number }>`
      SELECT
        COUNT(*) FILTER (WHERE connection_status IN ('connected','syncing'))::int AS "connected",
        COUNT(*) FILTER (WHERE connection_status IN ('needs_reauth','error'))::int AS "attention"
      FROM email_accounts
      WHERE connection_status <> 'disconnected'`.execute(this.db);
    return r.rows[0]!;
  }

  async findThreadByProvider(accountId: string, providerThreadId: string): Promise<Thread | null> {
    const r = await sql<Thread>`
      ${threadSelect} WHERE t.account_id=${accountId} AND t.provider_thread_id=${providerThreadId}`.execute(this.db);
    return r.rows[0] ? toThread(r.rows[0]) : null;
  }

  async getThread(id: string): Promise<Thread | null> {
    const r = await sql<Thread>`${threadSelect} WHERE t.id=${id}`.execute(this.db);
    return r.rows[0] ? toThread(r.rows[0]) : null;
  }

  async upsertThread(t: Thread): Promise<Thread | null> {
    await sql`
      INSERT INTO email_threads (
        id, account_id, owner_user_id, provider_thread_id, lead_id, customer_id, deal_id,
        participants, subject, last_message_at, last_message_preview, message_count,
        unread_count, starred, archived, match_status
      ) VALUES (${t.id === "" ? randomUUID() : t.id}, ${t.accountId}, ${t.ownerUserId}, ${t.providerThreadId},
        ${t.leadId}, ${t.customerId}, ${t.dealId}, ${t.participants}, ${t.subject}, ${t.lastMessageAt},
        ${t.lastMessagePreview}, ${t.messageCount}, ${t.unreadCount}, ${t.starred}, ${t.archived}, ${t.matchStatus})
      ON CONFLICT (account_id, provider_thread_id) DO UPDATE SET
        lead_id = COALESCE(email_threads.lead_id, EXCLUDED.lead_id),
        customer_id = COALESCE(email_threads.customer_id, EXCLUDED.customer_id),
        deal_id = COALESCE(email_threads.deal_id, EXCLUDED.deal_id),
        participants = EXCLUDED.participants,
        subject = CASE WHEN EXCLUDED.subject='' THEN email_threads.subject ELSE EXCLUDED.subject END,
        last_message_at = EXCLUDED.last_message_at,
        last_message_preview = EXCLUDED.last_message_preview,
        message_count = EXCLUDED.message_count,
        unread_count = EXCLUDED.unread_count,
        match_status = CASE
          WHEN email_threads.match_status='matched' THEN email_threads.match_status
          ELSE EXCLUDED.match_status
        END,
        updated_at=NOW()`.execute(this.db);
    return this.findThreadByProvider(t.accountId, t.providerThreadId);
  }

  async associateThread(id: string, leadId: string | null, customerId: string | null, dealId: string | null, match: string): Promise<void> {
    await sql`
      UPDATE email_threads SET lead_id=${leadId}, customer_id=${customerId}, deal_id=${dealId}, match_status=${match}, updated_at=NOW()
      WHERE id=${id}`.execute(this.db);
  }

  async setThreadFlags(id: string, starred: boolean | undefined, archived: boolean | undefined): Promise<void> {
    const sets: RawBuilder<unknown>[] = [sql`updated_at=NOW()`];
    if (starred !== undefined) sets.push(sql`starred=${starred}`);
    if (archived !== undefined) sets.push(sql`archived=${archived}`);
    await sql`UPDATE email_threads SET ${sql.join(sets, sql`, `)} WHERE id=${id}`.execute(this.db);
  }

  async refreshThreadStats(threadId: string): Promise<void> {
    await sql`
      UPDATE email_threads t SET
        message_count = (SELECT COUNT(*) FROM email_messages m WHERE m.thread_id=t.id AND m.status <> 'draft'),
        last_message_at = (SELECT MAX(COALESCE(m.sent_at, m.received_at, m.created_at)) FROM email_messages m WHERE m.thread_id=t.id),
        last_message_preview = COALESCE((
          SELECT m.snippet FROM email_messages m WHERE m.thread_id=t.id
          ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC LIMIT 1
        ), t.last_message_preview),
        updated_at=NOW()
      WHERE t.id=${threadId}`.execute(this.db);
  }

  async listThreads(claims: Claims, f: ThreadListFilter): Promise<{ items: Thread[]; total: number }> {
    const where = [...threadScope(claims, f.ownerUserId), ...folderFilter(f.folder)];
    if (f.leadId !== "") where.push(sql`t.lead_id=${f.leadId}`);
    if (f.customerId !== "") where.push(sql`t.customer_id=${f.customerId}`);
    if (f.q !== "") {
      const like = `%${f.q.toLowerCase()}%`;
      where.push(sql`(
        lower(t.subject) LIKE ${like} OR lower(t.last_message_preview) LIKE ${like}
        OR EXISTS (SELECT 1 FROM unnest(t.participants) p WHERE lower(p) LIKE ${like})
        OR EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND (lower(m.body_text) LIKE ${like} OR lower(m.subject) LIKE ${like}))
      )`);
    }
    if (f.unread === "true") where.push(sql`t.unread_count > 0`);
    if (f.hasAttach === "true") where.push(sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.has_attachments)`);
    if (f.direction !== "") {
      where.push(sql`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id=t.id AND m.direction=${f.direction})`);
    }
    if (f.dateFrom !== "") where.push(sql`t.last_message_at >= ${f.dateFrom}::timestamptz`);
    if (f.dateTo !== "") where.push(sql`t.last_message_at < ${f.dateTo}::timestamptz`);

    const limit = f.limit <= 0 || f.limit > 100 ? 40 : f.limit;
    const offset = f.offset < 0 ? 0 : f.offset;

    const count = await sql<{ total: number }>`
      SELECT COUNT(*)::int AS "total" FROM email_threads t WHERE ${and(where)}`.execute(this.db);
    const rows = await sql<Thread>`
      ${threadSelect} WHERE ${and(where)}
      ORDER BY t.last_message_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: rows.rows.map(toThread), total: count.rows[0]?.total ?? 0 };
  }

  async folderCounts(claims: Claims, ownerUserId: string): Promise<FolderCounts> {
    const where = threadScope(claims, ownerUserId);
    const r = await sql<FolderCounts>`
      SELECT
        COUNT(*) FILTER (WHERE t.archived=FALSE AND NOT ${draftOnlyThread})::int AS "inbox",
        COUNT(*) FILTER (WHERE t.archived=FALSE AND ${hasSent})::int AS "sent",
        COUNT(*) FILTER (WHERE ${hasDraft})::int AS "drafts",
        COUNT(*) FILTER (WHERE t.starred=TRUE)::int AS "starred",
        COUNT(*) FILTER (WHERE t.match_status IN ('unmatched','needs_association') AND t.archived=FALSE)::int AS "unmatched",
        COUNT(*) FILTER (WHERE ${hasScheduled})::int AS "scheduled",
        COUNT(*) FILTER (WHERE t.archived=TRUE)::int AS "archived"
      FROM email_threads t
      WHERE ${and(where)}`.execute(this.db);
    return r.rows[0]!;
  }

  async getMessage(id: string): Promise<Message | null> {
    const r = await sql<Omit<Message, "attachments">>`${messageSelect} WHERE m.id=${id}`.execute(this.db);
    if (!r.rows[0]) return null;
    const m = toMessage(r.rows[0]);
    m.attachments = await this.listAttachments(m.id);
    return m;
  }

  async listMessages(threadId: string): Promise<Message[]> {
    const r = await sql<Omit<Message, "attachments">>`
      ${messageSelect}
      WHERE m.thread_id=${threadId}
      ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) ASC`.execute(this.db);
    const msgs = r.rows.map(toMessage);
    for (const m of msgs) m.attachments = await this.listAttachments(m.id);
    return msgs;
  }

  async hasProviderMessage(accountId: string, providerMessageId: string): Promise<boolean> {
    const r = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS "n" FROM email_messages WHERE account_id=${accountId} AND provider_message_id=${providerMessageId}`.execute(
      this.db,
    );
    return (r.rows[0]?.n ?? 0) > 0;
  }

  async insertMessage(m: Omit<Message, "id" | "attachments" | "createdAt">): Promise<Message | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO email_messages (
        id, thread_id, account_id, owner_user_id, provider_message_id, provider_thread_id,
        direction, from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
        subject, body_html, body_text, snippet, sent_at, received_at, scheduled_at,
        status, has_attachments, in_reply_to
      ) VALUES (${id}, ${m.threadId}, ${m.accountId}, ${m.ownerUserId}, ${m.providerMessageId}, ${m.providerThreadId},
        ${m.direction}, ${m.fromAddress}, ${m.fromName}, ${m.toAddresses}, ${m.ccAddresses}, ${m.bccAddresses},
        ${m.subject}, ${m.bodyHtml}, ${m.bodyText}, ${m.snippet}, ${m.sentAt}, ${m.receivedAt}, ${m.scheduledAt},
        ${m.status}, ${m.hasAttachments}, ${m.inReplyTo})`.execute(this.db);
    return this.getMessage(id);
  }

  async updateMessage(m: Message): Promise<void> {
    await sql`
      UPDATE email_messages SET
        to_addresses=${m.toAddresses}, cc_addresses=${m.ccAddresses}, bcc_addresses=${m.bccAddresses}, subject=${m.subject},
        body_html=${m.bodyHtml}, body_text=${m.bodyText}, snippet=${m.snippet}, status=${m.status},
        provider_message_id=${m.providerMessageId}, provider_thread_id=${m.providerThreadId}, sent_at=${m.sentAt},
        scheduled_at=${m.scheduledAt}, has_attachments=${m.hasAttachments}, updated_at=NOW()
      WHERE id=${m.id}`.execute(this.db);
  }

  async insertAttachment(a: Omit<Attachment, "id">): Promise<void> {
    await sql`
      INSERT INTO email_attachments (id, message_id, filename, mime_type, size_bytes, provider_attachment_id)
      VALUES (${randomUUID()}, ${a.messageId}, ${a.filename}, ${a.mimeType}, ${a.sizeBytes}, ${a.providerAttachmentId})`.execute(
      this.db,
    );
  }

  async listAttachments(messageId: string): Promise<Attachment[]> {
    const r = await sql<Attachment>`
      SELECT id::text AS "id", message_id::text AS "messageId", filename, mime_type AS "mimeType",
        size_bytes::float8 AS "sizeBytes", provider_attachment_id AS "providerAttachmentId"
      FROM email_attachments WHERE message_id=${messageId} ORDER BY created_at`.execute(this.db);
    return r.rows;
  }

  async listTemplates(teamIds: string[]): Promise<Template[]> {
    const r = await sql<Template>`
      ${templateSelect}
      WHERE is_active=TRUE
        AND (team_id IS NULL OR team_id = ANY(${teamIds}::uuid[]) OR cardinality(${teamIds}::uuid[])=0)
      ORDER BY name`.execute(this.db);
    return r.rows.map(toTemplate);
  }

  async getTemplate(id: string): Promise<Template | null> {
    const r = await sql<Template>`${templateSelect} WHERE id=${id}`.execute(this.db);
    return r.rows[0] ? toTemplate(r.rows[0]) : null;
  }

  async insertTemplate(t: Omit<Template, "id" | "createdAt" | "updatedAt">): Promise<Template | null> {
    const r = await sql<{ id: string }>`
      INSERT INTO email_templates (id, name, subject, body_html, category, variables, is_active, created_by, team_id)
      VALUES (${randomUUID()}, ${t.name}, ${t.subject}, ${t.bodyHtml}, ${t.category}, ${t.variables}, ${t.isActive},
        ${t.createdBy}, ${t.teamId})
      RETURNING id::text AS "id"`.execute(this.db);
    return this.getTemplate(r.rows[0]!.id);
  }

  async updateTemplate(t: Template): Promise<Template | null> {
    await sql`
      UPDATE email_templates SET name=${t.name}, subject=${t.subject}, body_html=${t.bodyHtml}, category=${t.category},
        variables=${t.variables}, is_active=${t.isActive}, team_id=${t.teamId}, updated_at=NOW()
      WHERE id=${t.id}`.execute(this.db);
    return this.getTemplate(t.id);
  }

  async deleteTemplate(id: string): Promise<void> {
    await sql`DELETE FROM email_templates WHERE id=${id}`.execute(this.db);
  }

  async matchAddresses(addresses: readonly string[]): Promise<CrmMatch> {
    const m: CrmMatch = { leadId: null, leadName: "", customerId: null, customerName: "", count: 0 };
    if (addresses.length === 0) return m;
    const lower = addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== "");
    if (lower.length === 0) return m;
    // Leads only. One address can have several leads (repeat purchases): its open, most recently
    // active lead wins. More than one matching address is ambiguous and needs association.
    const leads = await sql<{ id: string; name: string; email: string }>`
      SELECT id::text AS "id", full_name AS "name", lower(email) AS "email" FROM leads
      WHERE is_archived=FALSE AND email IS NOT NULL AND lower(email)=ANY(${lower}::text[])
      ORDER BY (status IN ('open','inbox','qualified')) DESC, COALESCE(last_activity_at, created_at) DESC
      LIMIT 20`.execute(this.db);
    const rows = leads.rows;
    m.count = new Set(rows.map((r) => r.email)).size;
    if (m.count === 1) {
      m.leadId = rows[0]!.id;
      m.leadName = rows[0]!.name;
    }
    return m;
  }

  async personalizationContext(leadId: string | undefined | null, customerId: string | undefined | null): Promise<Record<string, string>> {
    let id = "";
    let table = "";
    if (customerId) {
      id = customerId;
      table = "customers";
    } else if (leadId) {
      id = leadId;
      table = "leads";
    }
    if (id === "") return {};
    const r = await sql<{ fullName: string | null; email: string | null; phone: string | null; employer: string | null; ownerName: string | null }>`
      SELECT e.full_name AS "fullName", e.email, e.phone, e.employer, u.full_name AS "ownerName"
      FROM ${sql.table(table)} e
      LEFT JOIN users u ON u.id=e.owner_user_id
      WHERE e.id=${id}`.execute(this.db);
    const row = r.rows[0];
    if (!row) return {};
    const name = row.fullName ?? "";
    const [first, last] = splitName(name);
    return {
      full_name: name,
      first_name: first,
      last_name: last,
      email: row.email ?? "",
      phone: row.phone ?? "",
      company_name: row.employer ?? "",
      lead_owner: row.ownerName ?? "",
    };
  }
}
