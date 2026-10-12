import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { truncateBytes } from "../../lib/go-strings.js";
import { parseRfc3339 } from "../../lib/go-time.js";
import type { RequestMeta } from "../../lib/request-meta.js";
import { logger } from "../../logger.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import { P, Role, scopeFor } from "../permissions/permissions.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";
import { decodeStdBase64, TokenBox } from "./crypto.js";
import {
  EmailRepository,
  type AccountPublic,
  type AccountRecord,
  type FolderCounts,
  type Message,
  type Template,
  type Thread,
  type ThreadListFilter,
} from "./email.repository.js";
import { collectBodies, GmailApiError, GmailClient, googleErrorLogFields, headerValue } from "./gmail.js";
import { applyVars, buildRfc822, findUnresolved, parseAddress, parseAddressList, parseInt64, stripTags, uniqueEmails } from "./mime.js";

export interface EmailConfig {
  publicApiUrl: string;
  frontendUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  gmailPubSubTopic: string;
  tokenEncryptionKey: string;
  jwtSecret: string;
}

export interface IntegrationHealth {
  configured: boolean;
  oauthConfigured: boolean;
  gmailApiEnabled: boolean;
  pubSubConfigured: boolean;
  pushSyncHealthy: boolean;
  connectedAccounts: number;
  needsAttention: number;
  message?: string;
}

export interface PreviewResult {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  unresolved: string[] | null;
  canSend: boolean;
}

/** Go *string fields: undefined when absent or null. */
type Ref = string | undefined;

export interface ComposeInput {
  accountId: string;
  to: string[] | undefined;
  cc: string[] | undefined;
  bcc: string[] | undefined;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  leadId: Ref;
  customerId: Ref;
  dealId: Ref;
  inReplyTo: Ref;
  threadId: Ref;
  scheduledAt: Ref;
  send: boolean;
}

export interface DraftPatch {
  to: string[] | undefined;
  cc: string[] | undefined;
  bcc: string[] | undefined;
  subject: Ref;
  bodyHtml: Ref;
  bodyText: Ref;
}

export interface AssociateInput {
  leadId: Ref;
  customerId: Ref;
  dealId: Ref;
}

export interface TemplateInput {
  name: string;
  subject: string;
  bodyHtml: string;
  category: string;
  variables: string[] | undefined;
  isActive: boolean | undefined;
  teamId: Ref;
}

const NO_META: RequestMeta = { ip: "", userAgent: "" };
const ref = (v: Ref): string | null => v ?? null;

export class EmailService {
  readonly repo: EmailRepository;
  private readonly box: TokenBox;
  private readonly gmail: GmailClient;

  constructor(
    db: Database,
    private readonly cfg: EmailConfig,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    deps: { gmail?: GmailClient } = {},
  ) {
    this.repo = new EmailRepository(db);
    this.box = new TokenBox(cfg.tokenEncryptionKey || cfg.jwtSecret);
    const redirect = `${cfg.publicApiUrl.replace(/\/+$/, "")}/api/v1/email/google/callback`;
    this.gmail = deps.gmail ?? new GmailClient(cfg.googleClientId, cfg.googleClientSecret, redirect);
  }

  configured(): boolean {
    return this.cfg.googleClientId.trim() !== "" && this.cfg.googleClientSecret.trim() !== "";
  }

  private frontSettings(): string {
    return `${this.cfg.frontendUrl.replace(/\/+$/, "")}/settings/email`;
  }

  async health(): Promise<IntegrationHealth> {
    const h: IntegrationHealth = {
      configured: this.configured(),
      oauthConfigured: this.configured(),
      gmailApiEnabled: this.configured(),
      pubSubConfigured: this.cfg.gmailPubSubTopic.trim() !== "",
      pushSyncHealthy: false,
      connectedAccounts: 0,
      needsAttention: 0,
    };
    if (!h.configured) return { ...h, message: "Gmail integration is not configured" };
    try {
      const c = await this.repo.healthCounts();
      h.connectedAccounts = c.connected;
      h.needsAttention = c.attention;
    } catch (err) {
      logger.error({ err }, "email health counts");
    }
    h.pushSyncHealthy = h.pubSubConfigured && h.needsAttention === 0;
    return h;
  }

  listAccounts(userId: string): Promise<AccountPublic[]> {
    return this.repo.listAccountsForUser(userId);
  }

  async startConnect(claims: Claims, redirectTo: string): Promise<string> {
    if (!this.configured()) throw AppError.validation("Gmail integration is not configured");
    const state = randomBytes(24).toString("base64url");
    await this.repo.insertOAuthState(state, claims.userId, redirectTo || this.frontSettings(), new Date(Date.now() + 10 * 60_000));
    return this.gmail.authUrl(state);
  }

  /** Where to redirect the browser; never throws (the handler redirects either way). */
  async oauthCallback(code: string, state: string, errorCode: string): Promise<string> {
    let front = this.frontSettings();
    if (errorCode !== "") return `${front}?gmail=denied`;
    if (code === "" || state === "") return `${front}?gmail=invalid`;
    let consumed: { userId: string; redirect: string };
    try {
      consumed = await this.repo.consumeOAuthState(state);
    } catch {
      return `${front}?gmail=invalid`;
    }
    const { userId, redirect } = consumed;
    if (redirect !== "") front = redirect;
    try {
      let tok;
      try {
        tok = await this.gmail.exchangeCode(code);
      } catch (err) {
        logger.error(googleErrorLogFields(err, "oauth.token.exchange"), "gmail oauth exchange failed");
        return `${front}?gmail=error`;
      }
      const prof = await this.gmail.userInfo(tok.accessToken).catch((err: unknown) => {
        logger.error(googleErrorLogFields(err, "oauth.userinfo"), "gmail userinfo failed");
        throw err;
      });
      const gp = await this.gmail.gmailProfile(tok.accessToken).catch((err: unknown) => {
        logger.error(googleErrorLogFields(err, "gmail.users.getProfile"), "gmail profile failed");
        throw err;
      });
      let emailAddr = gp.emailAddress.trim().toLowerCase();
      if (emailAddr === "") emailAddr = prof.email.trim().toLowerCase();
      const encAccess = this.box.encrypt(tok.accessToken);
      const encRefresh = this.box.encrypt(tok.refreshToken);
      const hist = String(gp.historyId);
      const saved = await this.repo
        .upsertAccount({
          userId,
          emailAddress: emailAddr,
          displayName: prof.name,
          avatarUrl: prof.picture,
          connectionStatus: "connected",
          encryptedAccessToken: encAccess,
          encryptedRefreshToken: encRefresh,
          tokenExpiry: new Date(Date.now() + tok.expiresIn * 1000),
          gmailHistoryId: hist,
          lastSyncAt: null,
        })
        .catch((err: unknown) => {
          logger.error({ err }, "gmail account upsert failed");
          throw err;
        });
      if (!saved) return `${front}?gmail=error`;
      await this.audit.record(userId, "gmail.connected", "email_account", saved.id, { email: emailAddr }, NO_META);
      try {
        await this.ensureWatch(saved);
        void this.initialSync(saved.id).catch((err: unknown) => logger.warn({ err, account: saved.id }, "gmail initial sync failed"));
      } catch (err) {
        logger.warn({ err, account: saved.id }, "gmail watch after connect failed");
        await this.repo.updateSync(saved.id, "error", hist, "Watch setup failed. Sync will retry.").catch(() => undefined);
      }
      return `${front}${front.includes("?") ? "&" : "?"}gmail=connected`;
    } catch {
      return `${front}?gmail=error`;
    }
  }

  async disconnect(claims: Claims, accountId: string, meta: RequestMeta): Promise<void> {
    const acc = await this.requireOwnAccount(claims, accountId);
    const token = await this.accessToken(acc).catch(() => "");
    if (token !== "") await this.gmail.stopWatch(token);
    await this.repo.disconnect(acc.id);
    await this.audit.record(claims.userId, "gmail.disconnected", "email_account", acc.id, { email: acc.emailAddress }, meta);
  }

  private async requireOwnAccount(claims: Claims, accountId: string): Promise<AccountRecord> {
    const acc = await this.repo.getAccount(accountId);
    if (!acc || acc.connectionStatus === "disconnected") throw AppError.notFound("email account not found");
    if (acc.userId !== claims.userId && claims.roleCode !== Role.SuperAdmin) {
      throw AppError.forbidden("cannot manage another user's Gmail account");
    }
    return acc;
  }

  private async accessToken(acc: AccountRecord): Promise<string> {
    const refresh = this.box.decrypt(acc.encryptedRefreshToken);
    const access = this.box.decrypt(acc.encryptedAccessToken);
    const needsRefresh = acc.tokenExpiry === null || acc.tokenExpiry.getTime() - Date.now() < 2 * 60_000;
    if (!needsRefresh && access !== "") return access;
    if (refresh === "") {
      await this.repo.updateSync(acc.id, "needs_reauth", "", "Reconnect Gmail").catch(() => undefined);
      throw AppError.unauthorized("Gmail connection needs attention");
    }
    let tok;
    try {
      tok = await this.gmail.refresh(refresh);
    } catch (err) {
      logger.error({ ...googleErrorLogFields(err, "oauth.token.refresh"), account: acc.id }, "gmail token refresh failed");
      await this.repo.updateSync(acc.id, "needs_reauth", "", "Reconnect Gmail").catch(() => undefined);
      await this.audit.record(acc.userId, "gmail.authorization_revoked", "email_account", acc.id, { email: acc.emailAddress }, NO_META);
      throw AppError.unauthorized("Gmail connection needs attention");
    }
    const encA = this.box.encrypt(tok.accessToken);
    const encR = tok.refreshToken !== "" ? this.box.encrypt(tok.refreshToken) : "";
    const exp = new Date(Date.now() + tok.expiresIn * 1000);
    await this.repo.updateTokens(acc.id, encA, encR, exp);
    acc.encryptedAccessToken = encA;
    acc.tokenExpiry = exp;
    return tok.accessToken;
  }

  private async ensureWatch(acc: AccountRecord): Promise<void> {
    if (this.cfg.gmailPubSubTopic.trim() === "") return;
    const token = await this.accessToken(acc);
    const w = await this.gmail.watch(token, this.cfg.gmailPubSubTopic);
    let exp: Date | null = null;
    if (w.expiration !== "") {
      const ms = parseInt64(w.expiration);
      if (ms !== null && ms > 0) exp = new Date(ms);
    }
    let hist = String(w.historyId).trim();
    if (hist === "0") hist = acc.gmailHistoryId;
    await this.repo.updateWatch(acc.id, hist, exp);
  }

  /** Gmail push notification; malformed envelopes are acknowledged and ignored. */
  async handlePubSub(raw: Buffer): Promise<void> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const message = goField(envelope, "message");
    if (message === BAD) return;
    const data = goField(message, "data");
    if (data === BAD || (data !== undefined && data !== null && typeof data !== "string")) return;
    const messageId = goField(message, "messageId");
    if (messageId !== undefined && messageId !== null && typeof messageId !== "string") return;
    if (typeof data !== "string" || data === "") return;
    const decoded = decodeStdBase64(data);
    if (decoded === null) return;
    let n: unknown;
    try {
      n = JSON.parse(decoded.toString());
    } catch {
      return;
    }
    const email = goField(n, "emailAddress");
    const historyId = goField(n, "historyId");
    if (email === BAD || historyId === BAD) return;
    if (email !== undefined && email !== null && typeof email !== "string") return;
    const validHistory =
      historyId === undefined ||
      historyId === null ||
      historyId === "" ||
      historyId === "null" ||
      (typeof historyId === "number" && Number.isInteger(historyId) && historyId >= 0) ||
      (typeof historyId === "string" && /^\d+$/.test(historyId));
    if (!validHistory) return;
    const acc = await this.repo.getAccountByEmail(typeof email === "string" ? email : "");
    if (!acc) return;
    await this.syncAccount(acc);
  }

  async syncAccountFor(claims: Claims, accountId: string): Promise<void> {
    const acc = await this.requireOwnAccount(claims, accountId);
    await this.syncAccount(acc);
  }

  private async initialSync(accountId: string): Promise<void> {
    const acc = await this.repo.getAccount(accountId);
    if (!acc) return;
    const token = await this.accessToken(acc);
    let ids: string[];
    try {
      ids = await this.gmail.listRecent(token, 40);
    } catch (err) {
      await this.repo.updateSync(acc.id, "error", "", "Sync problem").catch(() => undefined);
      throw err;
    }
    for (const id of ids) {
      await this.ingestMessage(acc, token, id).catch((err: unknown) => logger.warn({ err, id }, "gmail ingest failed"));
    }
    await this.repo.updateSync(acc.id, "connected", acc.gmailHistoryId, "");
  }

  private async syncAccount(acc: AccountRecord): Promise<void> {
    await this.repo.updateSync(acc.id, "syncing", acc.gmailHistoryId, "").catch(() => undefined);
    const token = await this.accessToken(acc);
    if (acc.gmailHistoryId === "") {
      await this.initialSync(acc.id);
      return;
    }
    let hist;
    try {
      hist = await this.gmail.history(token, acc.gmailHistoryId);
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return this.initialSync(acc.id);
      if (err instanceof GmailApiError && err.revoked) {
        await this.repo.updateSync(acc.id, "needs_reauth", "", "Reconnect Gmail").catch(() => undefined);
        return;
      }
      await this.repo.updateSync(acc.id, "error", "", "Sync problem").catch(() => undefined);
      await this.audit.record(acc.userId, "gmail.sync_failed", "email_account", acc.id, {}, NO_META);
      throw err;
    }
    const seen = new Set<string>();
    for (const h of hist.history) {
      for (const added of h.messagesAdded) {
        const id = added.message.id;
        if (id === "" || seen.has(id)) continue;
        seen.add(id);
        await this.ingestMessage(acc, token, id).catch((err: unknown) => logger.warn({ err, id }, "gmail history ingest failed"));
      }
    }
    const newHist = hist.historyId > 0 ? String(hist.historyId) : acc.gmailHistoryId;
    await this.repo.updateSync(acc.id, "connected", newHist, "");
    await this.audit.record(acc.userId, "gmail.sync_restored", "email_account", acc.id, {}, NO_META);
  }

  private async ingestMessage(acc: AccountRecord, token: string, providerMessageId: string): Promise<void> {
    if (await this.repo.hasProviderMessage(acc.id, providerMessageId)) return;
    const gm = await this.gmail.getMessage(token, providerMessageId);
    const headers = gm.payload.headers;
    const { name: fromName, addr: fromAddr } = parseAddress(headerValue(headers, "From"));
    const to = parseAddressList(headerValue(headers, "To"));
    const cc = parseAddressList(headerValue(headers, "Cc"));
    const subj = headerValue(headers, "Subject");
    const { html, attachments } = collectBodies(gm.payload);
    let text = collectBodies(gm.payload).text;
    if (text === "") text = stripTags(html);
    const snippet = gm.snippet !== "" ? gm.snippet : truncateBytes(text, 180);
    const outbound = fromAddr.toLowerCase() === acc.emailAddress.toLowerCase();
    const direction = outbound ? "outbound" : "inbound";
    const status = outbound ? "sent" : "received";
    let when = new Date();
    if (gm.internalDate !== "") {
      const ms = parseInt64(gm.internalDate);
      if (ms !== null) when = new Date(ms);
    }
    let thread = await this.repo.findThreadByProvider(acc.id, gm.threadId);
    const participants = uniqueEmails([fromAddr, ...to, ...cc]);
    let matchStatus = "unmatched";
    let leadId: string | null = null;
    let customerId: string | null = null;
    if (thread) {
      leadId = thread.leadId;
      customerId = thread.customerId;
      if (thread.matchStatus === "matched") matchStatus = "matched";
    }
    if (matchStatus !== "matched") {
      const hit = await this.repo.matchAddresses(participants);
      if (hit.count === 0) {
        matchStatus = "unmatched";
      } else if (hit.count === 1 && (hit.leadId !== null || hit.customerId !== null)) {
        matchStatus = "matched";
        leadId = hit.leadId;
        customerId = hit.customerId;
      } else {
        matchStatus = "needs_association";
        if (!thread || thread.leadId === null) leadId = hit.leadId;
        if (!thread || thread.customerId === null) customerId = hit.customerId;
      }
    }
    if (!thread) {
      thread = await this.repo.upsertThread({
        ...blankThread(),
        accountId: acc.id,
        ownerUserId: acc.userId,
        providerThreadId: gm.threadId !== "" ? gm.threadId : `local-${randomUUID()}`,
        leadId,
        customerId,
        participants,
        subject: subj,
        lastMessageAt: when,
        lastMessagePreview: snippet,
        messageCount: 1,
        unreadCount: direction === "inbound" ? 1 : 0,
        matchStatus,
      });
    } else {
      thread.participants = uniqueEmails([...thread.participants, ...participants]);
      thread.lastMessageAt = when;
      thread.lastMessagePreview = snippet;
      thread.matchStatus = matchStatus;
      if (leadId !== null) thread.leadId = leadId;
      if (customerId !== null) thread.customerId = customerId;
      if (direction === "inbound") thread.unreadCount++;
      thread = await this.repo.upsertThread(thread);
    }
    if (!thread) throw new Error("thread vanished after upsert");
    let saved: Message | null;
    try {
      saved = await this.repo.insertMessage({
        threadId: thread.id,
        accountId: acc.id,
        ownerUserId: acc.userId,
        providerMessageId: gm.id,
        providerThreadId: gm.threadId,
        direction,
        fromAddress: fromAddr,
        fromName,
        toAddresses: to,
        ccAddresses: cc,
        bccAddresses: [],
        subject: subj,
        bodyHtml: html,
        bodyText: text,
        snippet,
        sentAt: outbound ? when : null,
        receivedAt: outbound ? null : when,
        scheduledAt: null,
        status,
        hasAttachments: attachments.length > 0,
        inReplyTo: null,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("email_messages_provider_id_unique")) return;
      throw err;
    }
    if (!saved) return;
    for (const a of attachments) {
      await this.repo
        .insertAttachment({ messageId: saved.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.size, providerAttachmentId: a.providerId })
        .catch(() => undefined);
    }
    await this.repo.refreshThreadStats(thread.id).catch(() => undefined);
    await this.writeTimeline(acc.userId, thread, saved);
  }

  private async writeTimeline(actorId: string, thread: Thread | null, msg: Message): Promise<void> {
    if (!thread || (thread.leadId === null && thread.customerId === null)) return;
    try {
      await this.timeline.recordIdempotent({
        eventType: TimelineEvent.Email,
        title: msg.direction === "outbound" ? "Email sent" : "Email received",
        body: msg.subject,
        actorUserId: actorId,
        source: "gmail",
        externalId: msg.providerMessageId !== "" ? msg.providerMessageId : msg.id,
        externalProvider: "gmail",
        leadId: thread.leadId,
        customerId: thread.customerId,
        dealId: thread.dealId,
        metadata: { threadId: thread.id, messageId: msg.id, direction: msg.direction },
      });
    } catch (err) {
      logger.warn({ err }, "email timeline write failed");
    }
  }

  async listThreads(claims: Claims, f: ThreadListFilter): Promise<{ items: Thread[]; total: number; counts: FolderCounts }> {
    const { items, total } = await this.repo.listThreads(claims, f);
    const counts = await this.repo.folderCounts(claims, f.ownerUserId);
    return { items, total, counts };
  }

  async getThread(claims: Claims, id: string): Promise<{ thread: Thread; messages: Message[] }> {
    const t = await this.repo.getThread(id);
    if (!t) throw AppError.notFound("thread not found");
    assertThreadVisible(claims, t);
    return { thread: t, messages: await this.repo.listMessages(t.id) };
  }

  async associate(claims: Claims, threadId: string, in_: AssociateInput): Promise<Thread | null> {
    const t = await this.repo.getThread(threadId);
    if (!t) throw AppError.notFound("thread not found");
    assertThreadVisible(claims, t);
    const match = in_.leadId || in_.customerId ? "matched" : "unmatched";
    await this.repo.associateThread(threadId, ref(in_.leadId), ref(in_.customerId), ref(in_.dealId), match);
    return this.repo.getThread(threadId);
  }

  async patchThread(claims: Claims, id: string, starred: boolean | undefined, archived: boolean | undefined): Promise<Thread | null> {
    const t = await this.repo.getThread(id);
    if (!t) throw AppError.notFound("thread not found");
    assertThreadVisible(claims, t);
    await this.repo.setThreadFlags(id, starred, archived);
    return this.repo.getThread(id);
  }

  async compose(claims: Claims, in_: ComposeInput, meta: RequestMeta): Promise<Message | null> {
    const acc = await this.accountForCompose(claims, in_.accountId);
    const preview = await this.preview(in_.subject, in_.bodyHtml, in_.bodyText, in_.leadId, in_.customerId);
    if (in_.send && !preview.canSend) throw AppError.validation("Email still contains unresolved variables");
    const to = uniqueEmails(in_.to);
    if (in_.send && to.length === 0) throw AppError.validation("Add at least one recipient");
    const thread = await this.threadForCompose(acc, in_, to);
    const scheduled = in_.scheduledAt !== undefined && in_.scheduledAt.trim() !== "";
    const status = scheduled ? "scheduled" : in_.send ? "sending" : "draft";
    let snippet = truncateBytes(stripTags(preview.bodyHtml), 180);
    if (snippet === "") snippet = truncateBytes(preview.bodyText, 180);
    let scheduledAt: Date | null = null;
    if (scheduled) {
      scheduledAt = parseRfc3339(in_.scheduledAt!.trim());
      if (scheduledAt === null) throw AppError.validation("Invalid schedule time");
    }
    const saved = await this.repo.insertMessage({
      threadId: thread!.id,
      accountId: acc.id,
      ownerUserId: acc.userId,
      providerMessageId: "",
      providerThreadId: "",
      direction: "outbound",
      fromAddress: acc.emailAddress,
      fromName: acc.displayName,
      toAddresses: to,
      ccAddresses: uniqueEmails(in_.cc),
      bccAddresses: uniqueEmails(in_.bcc),
      subject: preview.subject,
      bodyHtml: preview.bodyHtml,
      bodyText: preview.bodyText,
      snippet,
      sentAt: null,
      receivedAt: null,
      scheduledAt,
      status,
      hasAttachments: false,
      inReplyTo: ref(in_.inReplyTo),
    });
    await this.repo.refreshThreadStats(thread!.id).catch(() => undefined);
    if (status === "sending") return this.sendMessage(claims.userId, acc, thread!, saved!, meta);
    return saved;
  }

  private async accountForCompose(claims: Claims, accountId: string): Promise<AccountRecord> {
    if (accountId !== "") return this.requireOwnAccount(claims, accountId);
    const acc = await this.repo.getAccountByUser(claims.userId);
    if (!acc) throw AppError.validation("Connect your Gmail account first");
    if (acc.connectionStatus === "needs_reauth") throw AppError.unauthorized("Gmail connection needs attention");
    return acc;
  }

  private async threadForCompose(acc: AccountRecord, in_: ComposeInput, to: string[]): Promise<Thread | null> {
    if (in_.threadId) {
      const t = await this.repo.getThread(in_.threadId);
      if (!t) throw AppError.notFound("thread not found");
      return t;
    }
    return this.repo.upsertThread({
      ...blankThread(),
      accountId: acc.id,
      ownerUserId: acc.userId,
      providerThreadId: `local-${randomUUID()}`,
      leadId: ref(in_.leadId),
      customerId: ref(in_.customerId),
      dealId: ref(in_.dealId),
      participants: uniqueEmails([acc.emailAddress, ...to]),
      subject: in_.subject,
      lastMessageAt: new Date(),
      lastMessagePreview: truncateBytes(stripTags(in_.bodyHtml), 180),
      matchStatus: in_.leadId !== undefined || in_.customerId !== undefined ? "matched" : "unmatched",
    });
  }

  async patchDraft(claims: Claims, id: string, in_: DraftPatch): Promise<Message | null> {
    const m = await this.repo.getMessage(id);
    if (!m || m.status !== "draft") throw AppError.notFound("draft not found");
    if (m.ownerUserId !== claims.userId) throw AppError.forbidden("cannot edit this draft");
    if (in_.to !== undefined) m.toAddresses = uniqueEmails(in_.to);
    if (in_.cc !== undefined) m.ccAddresses = uniqueEmails(in_.cc);
    if (in_.bcc !== undefined) m.bccAddresses = uniqueEmails(in_.bcc);
    if (in_.subject !== undefined) m.subject = in_.subject;
    if (in_.bodyHtml !== undefined) m.bodyHtml = in_.bodyHtml;
    if (in_.bodyText !== undefined) m.bodyText = in_.bodyText;
    m.snippet = truncateBytes(stripTags(m.bodyHtml), 180);
    await this.repo.updateMessage(m);
    return this.repo.getMessage(id);
  }

  async sendExisting(claims: Claims, id: string, meta: RequestMeta): Promise<Message | null> {
    const m = await this.repo.getMessage(id);
    if (!m) throw AppError.notFound("message not found");
    if (m.ownerUserId !== claims.userId) throw AppError.forbidden("cannot send this message");
    const acc = await this.requireOwnAccount(claims, m.accountId);
    const thread = await this.repo.getThread(m.threadId);
    if (!thread) throw new Error("thread not found for message");
    const preview = await this.preview(m.subject, m.bodyHtml, m.bodyText, thread.leadId, thread.customerId);
    if (!preview.canSend) throw AppError.validation("Email still contains unresolved variables");
    m.subject = preview.subject;
    m.bodyHtml = preview.bodyHtml;
    m.bodyText = preview.bodyText;
    return this.sendMessage(claims.userId, acc, thread, m, meta);
  }

  private async sendMessage(actorId: string, acc: AccountRecord, thread: Thread, m: Message, meta: RequestMeta): Promise<Message | null> {
    if (m.toAddresses.length === 0) throw AppError.validation("Add at least one recipient");
    let token: string;
    try {
      token = await this.accessToken(acc);
    } catch (err) {
      m.status = "failed";
      await this.repo.updateMessage(m).catch(() => undefined);
      await this.audit.record(actorId, "email.send_failed", "email_message", m.id, { reason: "reauth" }, meta);
      throw err;
    }
    const raw = buildRfc822(acc.displayName, acc.emailAddress, m);
    const threadId = thread.providerThreadId.startsWith("local-") ? "" : thread.providerThreadId;
    let sent;
    try {
      sent = await this.gmail.send(token, raw, threadId);
    } catch (err) {
      logger.error({ err, account: acc.id }, "gmail send failed");
      m.status = "failed";
      await this.repo.updateMessage(m).catch(() => undefined);
      await this.audit.record(actorId, "email.send_failed", "email_message", m.id, {}, meta);
      throw AppError.validation("Failed to send. Check your Gmail connection and try again.");
    }
    const now = new Date();
    m.status = "sent";
    m.sentAt = now;
    m.providerMessageId = sent.id;
    m.providerThreadId = sent.threadId;
    await this.repo.updateMessage(m);
    thread.providerThreadId = sent.threadId;
    thread.lastMessageAt = now;
    thread.lastMessagePreview = m.snippet;
    if (thread.matchStatus !== "matched") {
      const hit = await this.repo
        .matchAddresses([...m.toAddresses, ...m.ccAddresses])
        .catch(() => ({ leadId: null, customerId: null, count: 0 }));
      if (hit.count === 1) {
        thread.leadId = hit.leadId;
        thread.customerId = hit.customerId;
        thread.matchStatus = "matched";
      } else if (hit.count > 1) {
        thread.matchStatus = "needs_association";
      }
    }
    await this.repo.upsertThread(thread).catch(() => undefined);
    await this.repo.refreshThreadStats(thread.id).catch(() => undefined);
    const saved = await this.repo.getMessage(m.id).catch(() => null);
    if (saved) await this.writeTimeline(actorId, thread, saved);
    await this.audit.record(actorId, "email.sent", "email_message", m.id, { to: m.toAddresses }, meta);
    return saved;
  }

  async preview(subject: string, html: string, text: string, leadId: string | null | undefined, customerId: string | null | undefined): Promise<PreviewResult> {
    const vars = await this.repo.personalizationContext(leadId, customerId);
    const out = { subject: applyVars(subject, vars), bodyHtml: applyVars(html, vars), bodyText: applyVars(text, vars) };
    const unresolved = findUnresolved(`${out.subject} ${out.bodyHtml} ${out.bodyText}`);
    return { ...out, unresolved, canSend: unresolved === null };
  }

  listTemplates(claims: Claims): Promise<Template[]> {
    return this.repo.listTemplates(claims.teamIds);
  }

  async createTemplate(claims: Claims, in_: TemplateInput): Promise<Template | null> {
    if (in_.name.trim() === "") throw AppError.validation("Template name is required");
    return this.repo.insertTemplate({
      name: in_.name.trim(),
      subject: in_.subject,
      bodyHtml: in_.bodyHtml,
      category: in_.category !== "" ? in_.category : "general",
      variables: in_.variables ?? [],
      isActive: in_.isActive ?? true,
      createdBy: claims.userId,
      teamId: ref(in_.teamId),
    });
  }

  async updateTemplate(id: string, in_: TemplateInput): Promise<Template | null> {
    const t = await this.repo.getTemplate(id);
    if (!t) throw AppError.notFound("template not found");
    if (in_.name.trim() !== "") t.name = in_.name.trim();
    if (in_.subject !== "") t.subject = in_.subject;
    if (in_.bodyHtml !== "") t.bodyHtml = in_.bodyHtml;
    if (in_.category !== "") t.category = in_.category;
    if (in_.variables !== undefined) t.variables = in_.variables;
    if (in_.isActive !== undefined) t.isActive = in_.isActive;
    if (in_.teamId !== undefined) t.teamId = in_.teamId;
    return this.repo.updateTemplate(t);
  }

  deleteTemplate(id: string): Promise<void> {
    return this.repo.deleteTemplate(id);
  }

  async renewWatches(): Promise<void> {
    let accs: AccountRecord[];
    try {
      accs = await this.repo.listAccountsNeedingWatch();
    } catch (err) {
      logger.error({ err }, "list watches failed");
      return;
    }
    for (const acc of accs) {
      await this.ensureWatch(acc).catch((err: unknown) => logger.warn({ err, account: acc.id }, "renew gmail watch failed"));
    }
  }

  async sendDueScheduled(): Promise<void> {
    let due: Message[];
    try {
      due = await this.repo.listScheduledDue(new Date());
    } catch (err) {
      logger.error({ err }, "list scheduled email failed");
      return;
    }
    for (const m of due) {
      const acc = await this.repo.getAccount(m.accountId).catch(() => null);
      if (!acc) continue;
      const thread = await this.repo.getThread(m.threadId).catch(() => null);
      if (!thread) continue;
      await this.sendMessage(m.ownerUserId, acc, thread, m, { ip: "", userAgent: "scheduler" }).catch(() => undefined);
    }
  }
}

function blankThread(): Thread {
  return {
    id: "",
    accountId: "",
    ownerUserId: "",
    ownerName: "",
    providerThreadId: "",
    leadId: null,
    leadName: null,
    customerId: null,
    customerName: null,
    dealId: null,
    participants: [],
    subject: "",
    lastMessageAt: null,
    lastMessagePreview: "",
    messageCount: 0,
    unreadCount: 0,
    starred: false,
    archived: false,
    matchStatus: "unmatched",
    hasAttachments: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function assertThreadVisible(claims: Claims, t: Thread): void {
  if (t.ownerUserId === claims.userId) return;
  const scope = scopeFor(claims.permissionScopes, P.EmailView);
  if (scope === "organization") return;
  if (scope === "team" && claims.teamMemberUserIds.includes(t.ownerUserId)) return;
  throw AppError.forbidden("thread is outside your scope");
}

const BAD = Symbol("bad");

/**
 * A struct field as json.Unmarshal decodes it: the last key matching case-insensitively,
 * undefined when absent, BAD when the container is not an object (Go reports an error).
 */
function goField(container: unknown, name: string): unknown {
  if (container === undefined || container === null) return undefined;
  if (typeof container !== "object" || Array.isArray(container)) return BAD;
  let value: unknown;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(container)) if (k.toLowerCase() === lower) value = v;
  return value;
}
