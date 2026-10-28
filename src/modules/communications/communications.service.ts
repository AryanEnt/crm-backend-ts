import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goSortKeys } from "../../lib/go-json.js";
import { truncateBytes } from "../../lib/go-strings.js";
import { NoRowsError, pgxMessage } from "../../lib/pgx.js";
import type { RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";
import { TimelineEvent, type TimelineService, type TimelineWriteInput } from "../timeline/timeline.service.js";
import {
  DevTwilioProvider,
  DevWhatsAppProvider,
  DirectionInbound,
  DirectionOutbound,
  MetaWhatsAppProvider,
  ProviderMetaWhatsApp,
  ProviderTwilioVoice,
  TwilioVoiceProvider,
  coalesce,
  digitsOnly,
  normalizePhone,
  type CallStatusEvent,
  type Form,
  type InboundWhatsAppCallEvent,
  type InboundWhatsAppEvent,
  type TwilioProvider,
  type WhatsAppProvider,
} from "./providers.js";
import {
  exchangeEmbeddedSignupCode,
  fetchPhoneDisplayNumber,
  metaWhatsAppConfigured,
  registerPhoneNumber,
  subscribeWaba,
  type MetaWhatsAppEnv,
} from "./meta-embedded-signup.js";

type Json = Record<string, unknown>;

/** A WhatsApp or Twilio number usable by several SEs. Credentials never leave the service. */
export interface Account {
  id: string;
  provider: string;
  name: string;
  displayIdentifier: string;
  externalAccountId: string;
  isActive: boolean;
  ownerUserId: string | null;
  teamId: string | null;
  allowRecordings: boolean;
  metadata: Json | null;
  createdAt: Date;
  updatedAt: Date;
  credentials: Record<string, string>;
}

export interface WhatsAppMessage {
  id: string;
  accountId: string;
  direction: string;
  status: string;
  providerMessageId: string;
  conversationKey: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrl: string;
  mediaMime: string;
  mediaFilename: string;
  errorCode: string;
  errorMessage: string;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  activityId: string | null;
  timelineEventId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface TwilioCall {
  id: string;
  accountId: string;
  direction: string;
  status: string;
  providerCallSid: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number | null;
  recordingSid: string;
  recordingUrl: string;
  errorCode: string;
  errorMessage: string;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  activityId: string | null;
  timelineEventId: string | null;
  actorUserId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export interface WhatsAppCall {
  id: string;
  accountId: string;
  direction: string;
  status: string;
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number | null;
  remoteSdp: string;
  remoteSdpType: string;
  localSdp: string;
  localSdpType: string;
  errorCode: string;
  errorMessage: string;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  activityId: string | null;
  timelineEventId: string | null;
  actorUserId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

/** One row per conversation_key for the WhatsApp inbox. */
export interface WhatsAppConversation {
  conversationKey: string;
  lastMessageId: string;
  direction: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  occurredAt: Date;
}

export interface CreateAccountInput {
  provider: string;
  name: string;
  displayIdentifier: string;
  externalAccountId: string;
  credentials: Record<string, string> | undefined;
  ownerUserId: string | undefined;
  teamId: string | undefined;
  allowRecordings: boolean;
  isActive: boolean | undefined;
}

interface Links {
  leadId: string | undefined;
  customerId: string | undefined;
  dealId: string | undefined;
}

export type SendWhatsAppInput = Links & { accountId: string; to: string; body: string; mediaUrl: string };
export type PlaceCallInput = Links & { accountId: string; to: string };
export type CallPermissionInput = Links & { accountId: string; to: string; body: string };
/** Self-serve WhatsApp Business Cloud API connect (credentials never returned later). */
export type ConnectWhatsAppInput = {
  name: string;
  displayIdentifier: string;
  externalAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
};

/** Result of Meta Embedded Signup in the browser (SE one-click connect). */
export type EmbeddedSignupInput = {
  code: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
};
export type InitiateWhatsAppCallInput = Links & {
  accountId: string;
  to: string;
  sdp: string;
  sdpType: string;
};
export type WhatsAppCallSignalInput = { sdp: string; sdpType: string };

type NewWhatsApp = Omit<WhatsAppMessage, "id" | "createdAt" | "occurredAt"> & { occurredAt: Date };
type NewCall = Omit<TwilioCall, "id" | "createdAt" | "startedAt" | "endedAt">;
type NewWhatsAppCall = Omit<WhatsAppCall, "id" | "createdAt" | "startedAt" | "endedAt">;

/** RFC3339 with whole seconds, as the Go DTOs format every timestamp. */
const rfc3339 = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

/** Second precision, like the RFC3339 round trip Go makes before storing occurred_at. */
const toSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** Go's emptyUUIDPtr: blank becomes NULL. */
const emptyToNull = (s: string | null | undefined): string | null => (s && s.trim() !== "" ? s : null);

// ---------------------------------------------------------------- JSON shapes (Go struct order, omitempty)

export function accountJson(a: Account): Json {
  return {
    id: a.id,
    provider: a.provider,
    name: a.name,
    displayIdentifier: a.displayIdentifier,
    externalAccountId: a.externalAccountId,
    isActive: a.isActive,
    ...(a.ownerUserId !== null && { ownerUserId: a.ownerUserId }),
    ...(a.teamId !== null && { teamId: a.teamId }),
    allowRecordings: a.allowRecordings,
    ...(a.metadata && Object.keys(a.metadata).length > 0 && { metadata: goSortKeys(a.metadata) }),
    createdAt: rfc3339(a.createdAt),
    updatedAt: rfc3339(a.updatedAt),
  };
}

const opt = (key: string, v: string) => (v !== "" ? { [key]: v } : {});
const optRef = (key: string, v: string | null) => (v !== null ? { [key]: v } : {});

export function whatsappJson(m: WhatsAppMessage): Json {
  return {
    id: m.id,
    accountId: m.accountId,
    direction: m.direction,
    status: m.status,
    providerMessageId: m.providerMessageId,
    conversationKey: m.conversationKey,
    fromNumber: m.fromNumber,
    toNumber: m.toNumber,
    body: m.body,
    ...opt("mediaUrl", m.mediaUrl),
    ...opt("mediaMime", m.mediaMime),
    ...opt("mediaFilename", m.mediaFilename),
    ...opt("errorCode", m.errorCode),
    ...opt("errorMessage", m.errorMessage),
    ...optRef("leadId", m.leadId),
    ...optRef("customerId", m.customerId),
    ...optRef("dealId", m.dealId),
    ...optRef("activityId", m.activityId),
    ...optRef("timelineEventId", m.timelineEventId),
    ...optRef("actorUserId", m.actorUserId),
    occurredAt: rfc3339(m.occurredAt),
    createdAt: rfc3339(m.createdAt),
  };
}

export function callJson(c: TwilioCall): Json {
  return {
    id: c.id,
    accountId: c.accountId,
    direction: c.direction,
    status: c.status,
    providerCallSid: c.providerCallSid,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    ...(c.durationSeconds !== null && { durationSeconds: c.durationSeconds }),
    ...opt("recordingSid", c.recordingSid),
    ...opt("recordingUrl", c.recordingUrl),
    ...opt("errorCode", c.errorCode),
    ...opt("errorMessage", c.errorMessage),
    ...optRef("leadId", c.leadId),
    ...optRef("customerId", c.customerId),
    ...optRef("dealId", c.dealId),
    ...optRef("activityId", c.activityId),
    ...optRef("timelineEventId", c.timelineEventId),
    ...optRef("actorUserId", c.actorUserId),
    ...(c.startedAt && { startedAt: rfc3339(c.startedAt) }),
    ...(c.endedAt && { endedAt: rfc3339(c.endedAt) }),
    createdAt: rfc3339(c.createdAt),
  };
}

export function whatsappConversationJson(c: WhatsAppConversation): Json {
  return {
    conversationKey: c.conversationKey,
    lastMessageId: c.lastMessageId,
    direction: c.direction,
    status: c.status,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    body: c.body,
    ...optRef("leadId", c.leadId),
    ...optRef("customerId", c.customerId),
    ...optRef("dealId", c.dealId),
    occurredAt: rfc3339(c.occurredAt),
  };
}

export function whatsappCallJson(c: WhatsAppCall): Json {
  return {
    id: c.id,
    accountId: c.accountId,
    direction: c.direction,
    status: c.status,
    providerCallId: c.providerCallId,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    ...(c.durationSeconds !== null && { durationSeconds: c.durationSeconds }),
    ...opt("remoteSdp", c.remoteSdp),
    ...opt("remoteSdpType", c.remoteSdpType),
    ...opt("localSdp", c.localSdp),
    ...opt("localSdpType", c.localSdpType),
    ...opt("errorCode", c.errorCode),
    ...opt("errorMessage", c.errorMessage),
    ...optRef("leadId", c.leadId),
    ...optRef("customerId", c.customerId),
    ...optRef("dealId", c.dealId),
    ...optRef("activityId", c.activityId),
    ...optRef("timelineEventId", c.timelineEventId),
    ...optRef("actorUserId", c.actorUserId),
    ...(c.startedAt && { startedAt: rfc3339(c.startedAt) }),
    ...(c.endedAt && { endedAt: rfc3339(c.endedAt) }),
    createdAt: rfc3339(c.createdAt),
  };
}

// ---------------------------------------------------------------- repository

interface AccountRow {
  id: string;
  provider: string;
  name: string;
  displayIdentifier: string;
  externalAccountId: string;
  credentials: unknown;
  isActive: boolean;
  ownerUserId: string | null;
  teamId: string | null;
  allowRecordings: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const accountSelect = sql`
  SELECT id::text AS "id", provider, name, display_identifier AS "displayIdentifier", external_account_id AS "externalAccountId",
    credentials, is_active AS "isActive", owner_user_id::text AS "ownerUserId", team_id::text AS "teamId",
    allow_recordings AS "allowRecordings", metadata, created_at AS "createdAt", updated_at AS "updatedAt"
  FROM communication_accounts`;

/** json.Unmarshal into a pre-made map: null clears it, a non-object leaves it empty. */
function toAccount(r: AccountRow): Account {
  const credentials: Record<string, string> = {};
  if (r.credentials !== null && typeof r.credentials === "object" && !Array.isArray(r.credentials)) {
    for (const [k, v] of Object.entries(r.credentials)) if (typeof v === "string") credentials[k] = v;
  }
  let metadata: Json | null = {};
  if (r.metadata === null) metadata = null;
  else if (typeof r.metadata === "object" && !Array.isArray(r.metadata)) metadata = r.metadata as Json;
  const { credentials: _c, metadata: _m, ...rest } = r;
  return { ...rest, metadata, credentials };
}

const whatsappSelect = sql`
  SELECT id::text AS "id", account_id::text AS "accountId", direction, status, provider_message_id AS "providerMessageId",
    conversation_key AS "conversationKey", from_number AS "fromNumber", to_number AS "toNumber", body,
    media_url AS "mediaUrl", media_mime AS "mediaMime", media_filename AS "mediaFilename",
    error_code AS "errorCode", error_message AS "errorMessage", lead_id::text AS "leadId", customer_id::text AS "customerId",
    deal_id::text AS "dealId", activity_id::text AS "activityId", timeline_event_id::text AS "timelineEventId",
    actor_user_id::text AS "actorUserId", occurred_at AS "occurredAt", created_at AS "createdAt"
  FROM whatsapp_messages`;

const callSelect = sql`
  SELECT id::text AS "id", account_id::text AS "accountId", direction, status, provider_call_sid AS "providerCallSid",
    from_number AS "fromNumber", to_number AS "toNumber", duration_seconds AS "durationSeconds",
    recording_sid AS "recordingSid", recording_url AS "recordingUrl", error_code AS "errorCode", error_message AS "errorMessage",
    lead_id::text AS "leadId", customer_id::text AS "customerId", deal_id::text AS "dealId", activity_id::text AS "activityId",
    timeline_event_id::text AS "timelineEventId", actor_user_id::text AS "actorUserId",
    started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
  FROM twilio_calls`;

const waCallSelect = sql`
  SELECT id::text AS "id", account_id::text AS "accountId", direction, status, provider_call_id AS "providerCallId",
    from_number AS "fromNumber", to_number AS "toNumber", duration_seconds AS "durationSeconds",
    remote_sdp AS "remoteSdp", remote_sdp_type AS "remoteSdpType", local_sdp AS "localSdp", local_sdp_type AS "localSdpType",
    error_code AS "errorCode", error_message AS "errorMessage",
    lead_id::text AS "leadId", customer_id::text AS "customerId", deal_id::text AS "dealId", activity_id::text AS "activityId",
    timeline_event_id::text AS "timelineEventId", actor_user_id::text AS "actorUserId",
    started_at AS "startedAt", ended_at AS "endedAt", created_at AS "createdAt"
  FROM whatsapp_calls`;

const linkFilter = (customerId: string, dealId: string, leadId: string) => sql`
  (${customerId}='' OR customer_id::text=${customerId}) AND (${dealId}='' OR deal_id::text=${dealId}) AND (${leadId}='' OR lead_id::text=${leadId})`;

export class CommunicationsRepository {
  constructor(private readonly db: Database) {}

  async listAccounts(provider: string, activeOnly: boolean): Promise<Account[]> {
    const r = await sql<AccountRow>`
      ${accountSelect}
      WHERE (${provider}='' OR provider=${provider}) AND (${activeOnly}=FALSE OR is_active=TRUE)
      ORDER BY name ASC`.execute(this.db);
    return r.rows.map(toAccount);
  }

  async getAccount(id: string): Promise<Account | null> {
    const r = await sql<AccountRow>`${accountSelect} WHERE id=${id}`.execute(this.db);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }

  async findAccountByExternal(provider: string, externalId: string): Promise<Account | null> {
    const r = await sql<AccountRow>`
      ${accountSelect} WHERE provider=${provider} AND external_account_id=${externalId} AND is_active=TRUE LIMIT 1`.execute(this.db);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }

  async createAccount(in_: CreateAccountInput): Promise<Account | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO communication_accounts (
        id, provider, name, display_identifier, external_account_id, credentials,
        is_active, owner_user_id, team_id, allow_recordings
      ) VALUES (${id}, ${in_.provider}, ${in_.name.trim()}, ${in_.displayIdentifier.trim()}, ${in_.externalAccountId.trim()},
        ${JSON.stringify(in_.credentials ?? {})}::jsonb, ${in_.isActive ?? true}, ${emptyToNull(in_.ownerUserId)},
        ${emptyToNull(in_.teamId)}, ${in_.allowRecordings})`.execute(this.db);
    return this.getAccount(id);
  }

  async deactivateAccount(id: string): Promise<Account | null> {
    await sql`UPDATE communication_accounts SET is_active=FALSE WHERE id=${id}`.execute(this.db);
    return this.getAccount(id);
  }

  async claimWebhook(provider: string, eventKey: string, payload: Json | null): Promise<boolean> {
    const r = await sql`
      INSERT INTO webhook_receipts (id, provider, event_key, payload, result)
      VALUES (${randomUUID()}, ${provider}, ${eventKey}, ${JSON.stringify(payload ?? {})}::jsonb, 'processing')
      ON CONFLICT (provider, event_key) DO NOTHING`.execute(this.db);
    return Number(r.numAffectedRows ?? 0) > 0;
  }

  async completeWebhook(provider: string, eventKey: string, result: string, errMsg: string, status: number): Promise<void> {
    await sql`
      UPDATE webhook_receipts
      SET result=${result}, error_message=${errMsg}, http_status=${status}, processed_at=NOW()
      WHERE provider=${provider} AND event_key=${eventKey}`.execute(this.db);
  }

  async insertWhatsAppMessage(m: NewWhatsApp, raw: Json | null): Promise<WhatsAppMessage> {
    if (m.providerMessageId !== "") {
      const existing = await this.getWhatsAppByProviderId(m.accountId, m.providerMessageId);
      if (existing) return existing;
    }
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO whatsapp_messages (
          id, account_id, direction, status, provider_message_id, conversation_key,
          from_number, to_number, body, media_url, media_mime, media_filename,
          error_code, error_message, lead_id, customer_id, deal_id, activity_id,
          timeline_event_id, actor_user_id, raw_payload, occurred_at
        ) VALUES (
          ${id}, ${m.accountId}, ${m.direction}, ${m.status}, ${m.providerMessageId}, ${m.conversationKey},
          ${m.fromNumber}, ${m.toNumber}, ${m.body}, ${m.mediaUrl}, ${m.mediaMime}, ${m.mediaFilename},
          ${m.errorCode}, ${m.errorMessage}, ${emptyToNull(m.leadId)}, ${emptyToNull(m.customerId)},
          ${emptyToNull(m.dealId)}, ${emptyToNull(m.activityId)}, ${emptyToNull(m.timelineEventId)},
          ${emptyToNull(m.actorUserId)}, ${JSON.stringify(raw ?? {})}::jsonb, ${toSecond(m.occurredAt)}
        )`.execute(this.db);
    } catch (err) {
      if (m.providerMessageId !== "") {
        const existing = await this.getWhatsAppByProviderId(m.accountId, m.providerMessageId).catch(() => null);
        if (existing) return existing;
      }
      throw err;
    }
    return this.getWhatsApp(id);
  }

  async getWhatsApp(id: string): Promise<WhatsAppMessage> {
    const r = await sql<WhatsAppMessage>`${whatsappSelect} WHERE id=${id}`.execute(this.db);
    if (!r.rows[0]) throw new NoRowsError();
    return r.rows[0];
  }

  async getWhatsAppByProviderId(accountId: string, providerMsgId: string): Promise<WhatsAppMessage | null> {
    const r = await sql<WhatsAppMessage>`
      ${whatsappSelect} WHERE account_id=${accountId} AND provider_message_id=${providerMsgId}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async updateWhatsAppStatus(accountId: string, providerMsgId: string, status: string, errCode: string, errMsg: string): Promise<WhatsAppMessage | null> {
    await sql`
      UPDATE whatsapp_messages
      SET status=${status}, error_code=COALESCE(NULLIF(${errCode},''), error_code),
        error_message=COALESCE(NULLIF(${errMsg},''), error_message)
      WHERE account_id=${accountId} AND provider_message_id=${providerMsgId}`.execute(this.db);
    return this.getWhatsAppByProviderId(accountId, providerMsgId);
  }

  async listWhatsAppMessages(
    customerId: string,
    dealId: string,
    leadId: string,
    conversationKey: string,
    limit: number,
    offset: number,
  ): Promise<{ items: WhatsAppMessage[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const where = sql`
      (${customerId}='' OR customer_id::text=${customerId})
      AND (${dealId}='' OR deal_id::text=${dealId})
      AND (${leadId}='' OR lead_id::text=${leadId})
      AND (${conversationKey}='' OR conversation_key=${conversationKey})`;
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM whatsapp_messages WHERE ${where}`.execute(this.db);
    const r = await sql<WhatsAppMessage>`
      ${whatsappSelect} WHERE ${where} ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: r.rows, total: count.rows[0]?.n ?? 0 };
  }

  async listWhatsAppConversations(q: string, limit: number, offset: number): Promise<{ items: WhatsAppConversation[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const needle = q.trim().toLowerCase();
    const search = sql`
      (${needle}='' OR lower(conversation_key) LIKE '%' || ${needle} || '%'
        OR lower(from_number) LIKE '%' || ${needle} || '%'
        OR lower(to_number) LIKE '%' || ${needle} || '%'
        OR lower(COALESCE(body,'')) LIKE '%' || ${needle} || '%')`;
    const count = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM (
        SELECT conversation_key FROM whatsapp_messages
        WHERE conversation_key <> '' AND ${search}
        GROUP BY conversation_key
      ) t`.execute(this.db);
    const r = await sql<WhatsAppConversation>`
      SELECT * FROM (
        SELECT DISTINCT ON (conversation_key)
          conversation_key AS "conversationKey",
          id::text AS "lastMessageId",
          direction,
          status,
          from_number AS "fromNumber",
          to_number AS "toNumber",
          body,
          lead_id::text AS "leadId",
          customer_id::text AS "customerId",
          deal_id::text AS "dealId",
          occurred_at AS "occurredAt"
        FROM whatsapp_messages
        WHERE conversation_key <> '' AND ${search}
        ORDER BY conversation_key, occurred_at DESC
      ) latest
      ORDER BY "occurredAt" DESC
      LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: r.rows, total: count.rows[0]?.n ?? 0 };
  }

  async insertCall(c: NewCall, raw: Json | null): Promise<TwilioCall> {
    if (c.providerCallSid !== "") {
      const existing = await this.getCallBySid(c.accountId, c.providerCallSid);
      if (existing) return existing;
    }
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO twilio_calls (
          id, account_id, direction, status, provider_call_sid, from_number, to_number,
          duration_seconds, recording_sid, recording_url, error_code, error_message,
          lead_id, customer_id, deal_id, activity_id, timeline_event_id, actor_user_id,
          raw_payload, started_at
        ) VALUES (
          ${id}, ${c.accountId}, ${c.direction}, ${c.status}, ${c.providerCallSid}, ${c.fromNumber}, ${c.toNumber},
          ${c.durationSeconds}, ${c.recordingSid}, ${c.recordingUrl}, ${c.errorCode}, ${c.errorMessage},
          ${emptyToNull(c.leadId)}, ${emptyToNull(c.customerId)}, ${emptyToNull(c.dealId)},
          ${emptyToNull(c.activityId)}, ${emptyToNull(c.timelineEventId)}, ${emptyToNull(c.actorUserId)},
          ${JSON.stringify(raw ?? {})}::jsonb, NOW()
        )`.execute(this.db);
    } catch (err) {
      if (c.providerCallSid !== "") {
        const existing = await this.getCallBySid(c.accountId, c.providerCallSid).catch(() => null);
        if (existing) return existing;
      }
      throw err;
    }
    return this.getCall(id);
  }

  async getCall(id: string): Promise<TwilioCall> {
    const r = await sql<TwilioCall>`${callSelect} WHERE id=${id}`.execute(this.db);
    if (!r.rows[0]) throw new NoRowsError();
    return r.rows[0];
  }

  async getCallBySid(accountId: string, sid: string): Promise<TwilioCall | null> {
    const r = await sql<TwilioCall>`${callSelect} WHERE account_id=${accountId} AND provider_call_sid=${sid}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async getCallBySidAny(sid: string): Promise<TwilioCall | null> {
    const r = await sql<TwilioCall>`${callSelect} WHERE provider_call_sid=${sid} ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async updateCallStatus(sid: string, status: string, duration: number | null, recordingSid: string, recordingUrl: string): Promise<TwilioCall | null> {
    await sql`
      UPDATE twilio_calls
      SET status=${status},
        duration_seconds=COALESCE(${duration}::int, duration_seconds),
        recording_sid=CASE WHEN ${recordingSid}='' THEN recording_sid ELSE ${recordingSid} END,
        recording_url=CASE WHEN ${recordingUrl}='' THEN recording_url ELSE ${recordingUrl} END,
        ended_at=CASE WHEN ${status} IN ('completed','busy','failed','no-answer','canceled') THEN NOW() ELSE ended_at END
      WHERE provider_call_sid=${sid}`.execute(this.db);
    return this.getCallBySidAny(sid);
  }

  async listCalls(customerId: string, dealId: string, leadId: string, limit: number, offset: number): Promise<{ items: TwilioCall[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const where = linkFilter(customerId, dealId, leadId);
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM twilio_calls WHERE ${where}`.execute(this.db);
    const r = await sql<TwilioCall>`
      ${callSelect} WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: r.rows, total: count.rows[0]?.n ?? 0 };
  }

  /**
   * The lead whose phone digits end with the given digits (open leads first, then most recently updated);
   * historical customers only when no lead matches. Errors count as no match.
   */
  async resolvePhoneContext(phone: string): Promise<{ customerId: string | null; leadId: string | null }> {
    const digits = digitsOnly(normalizePhone(phone));
    if (digits === "") return { customerId: null, leadId: null };
    const phoneMatches = sql`(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = ${digits}
      OR regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE '%' || ${digits})`;
    const first = async (query: ReturnType<typeof sql<{ id: string }>>) => {
      try {
        return (await query.execute(this.db)).rows[0]?.id ?? null;
      } catch {
        return null;
      }
    };
    const leadId = await first(sql<{ id: string }>`
      SELECT id::text AS id FROM leads
      WHERE is_archived = FALSE AND ${phoneMatches}
      ORDER BY (status IN ('open','inbox','qualified')) DESC, updated_at DESC LIMIT 1`);
    if (leadId !== null) return { customerId: null, leadId };
    const customerId = await first(sql<{ id: string }>`
      SELECT id::text AS id FROM customers WHERE ${phoneMatches} ORDER BY updated_at DESC LIMIT 1`);
    return { customerId, leadId: null };
  }

  async loadEntityPhone(customerId: string, leadId: string, dealId: string): Promise<string> {
    const phoneOf = async (query: ReturnType<typeof sql<{ phone: string | null }>>) => {
      const r = await query.execute(this.db);
      if (!r.rows[0]) throw new NoRowsError();
      return r.rows[0].phone;
    };
    if (customerId !== "") {
      const phone = await phoneOf(sql`SELECT phone FROM customers WHERE id=${customerId}`);
      if (phone !== null) return phone;
    }
    if (leadId !== "") {
      const phone = await phoneOf(sql`SELECT phone FROM leads WHERE id=${leadId}`);
      if (phone !== null) return phone;
    }
    if (dealId !== "") {
      const phone = await phoneOf(sql`SELECT c.phone FROM deals d JOIN customers c ON c.id=d.customer_id WHERE d.id=${dealId}`);
      if (phone !== null) return phone;
    }
    return "";
  }

  async dealCustomerId(dealId: string): Promise<string> {
    const r = await sql<{ id: string | null }>`SELECT customer_id::text AS id FROM deals WHERE id=${dealId}`.execute(this.db);
    const id = r.rows[0]?.id;
    if (id === undefined || id === null) throw new NoRowsError();
    return id;
  }

  async linkWhatsAppTimeline(messageId: string, eventId: string): Promise<void> {
    await sql`UPDATE whatsapp_messages SET timeline_event_id=${eventId} WHERE id=${messageId}`.execute(this.db);
  }

  async linkCallTimeline(callId: string, eventId: string): Promise<void> {
    await sql`UPDATE twilio_calls SET timeline_event_id=${eventId} WHERE id=${callId}`.execute(this.db);
  }

  async insertWhatsAppCall(c: NewWhatsAppCall, raw: Json | null): Promise<WhatsAppCall> {
    if (c.providerCallId !== "") {
      const existing = await this.getWhatsAppCallByProviderId(c.accountId, c.providerCallId);
      if (existing) return existing;
    }
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO whatsapp_calls (
          id, account_id, direction, status, provider_call_id, from_number, to_number,
          duration_seconds, remote_sdp, remote_sdp_type, local_sdp, local_sdp_type,
          error_code, error_message, lead_id, customer_id, deal_id, activity_id,
          timeline_event_id, actor_user_id, raw_payload, started_at
        ) VALUES (
          ${id}, ${c.accountId}, ${c.direction}, ${c.status}, ${c.providerCallId}, ${c.fromNumber}, ${c.toNumber},
          ${c.durationSeconds}, ${c.remoteSdp}, ${c.remoteSdpType}, ${c.localSdp}, ${c.localSdpType},
          ${c.errorCode}, ${c.errorMessage},
          ${emptyToNull(c.leadId)}, ${emptyToNull(c.customerId)}, ${emptyToNull(c.dealId)},
          ${emptyToNull(c.activityId)}, ${emptyToNull(c.timelineEventId)}, ${emptyToNull(c.actorUserId)},
          ${JSON.stringify(raw ?? {})}::jsonb, NOW()
        )`.execute(this.db);
    } catch (err) {
      if (c.providerCallId !== "") {
        const existing = await this.getWhatsAppCallByProviderId(c.accountId, c.providerCallId).catch(() => null);
        if (existing) return existing;
      }
      throw err;
    }
    return this.getWhatsAppCall(id);
  }

  async getWhatsAppCall(id: string): Promise<WhatsAppCall> {
    const r = await sql<WhatsAppCall>`${waCallSelect} WHERE id=${id}`.execute(this.db);
    if (!r.rows[0]) throw new NoRowsError();
    return r.rows[0];
  }

  async getWhatsAppCallByProviderId(accountId: string, providerCallId: string): Promise<WhatsAppCall | null> {
    const r = await sql<WhatsAppCall>`
      ${waCallSelect} WHERE account_id=${accountId} AND provider_call_id=${providerCallId}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async getWhatsAppCallByProviderIdAny(providerCallId: string): Promise<WhatsAppCall | null> {
    const r = await sql<WhatsAppCall>`
      ${waCallSelect} WHERE provider_call_id=${providerCallId} ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async updateWhatsAppCallLocalSdp(id: string, localSdp: string, localSdpType: string, status: string): Promise<WhatsAppCall> {
    await sql`
      UPDATE whatsapp_calls
      SET local_sdp=${localSdp}, local_sdp_type=${localSdpType},
          status=CASE WHEN ${status}='' THEN status ELSE ${status} END
      WHERE id=${id}`.execute(this.db);
    return this.getWhatsAppCall(id);
  }

  async updateWhatsAppCallFromWebhook(
    providerCallId: string,
    status: string,
    remoteSdp: string,
    remoteSdpType: string,
    duration: number | null,
    ended: boolean,
  ): Promise<WhatsAppCall | null> {
    await sql`
      UPDATE whatsapp_calls
      SET status=CASE WHEN ${status}='' THEN status ELSE ${status} END,
          remote_sdp=CASE WHEN ${remoteSdp}='' THEN remote_sdp ELSE ${remoteSdp} END,
          remote_sdp_type=CASE WHEN ${remoteSdpType}='' THEN remote_sdp_type ELSE ${remoteSdpType} END,
          duration_seconds=COALESCE(${duration}::int, duration_seconds),
          ended_at=CASE WHEN ${ended} THEN COALESCE(ended_at, NOW()) ELSE ended_at END
      WHERE provider_call_id=${providerCallId}`.execute(this.db);
    return this.getWhatsAppCallByProviderIdAny(providerCallId);
  }

  async listWhatsAppCalls(
    customerId: string,
    dealId: string,
    leadId: string,
    status: string,
    activeOnly: boolean,
    limit: number,
    offset: number,
  ): Promise<{ items: WhatsAppCall[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const where = sql`
      (${customerId}='' OR customer_id::text=${customerId})
      AND (${dealId}='' OR deal_id::text=${dealId})
      AND (${leadId}='' OR lead_id::text=${leadId})
      AND (${status}='' OR status=${status})
      AND (
        ${activeOnly}=FALSE
        OR status IN ('queued','ringing','connecting','in-progress')
      )`;
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM whatsapp_calls WHERE ${where}`.execute(this.db);
    const r = await sql<WhatsAppCall>`
      ${waCallSelect} WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: r.rows, total: count.rows[0]?.n ?? 0 };
  }

  async linkWhatsAppCallTimeline(callId: string, eventId: string): Promise<void> {
    await sql`UPDATE whatsapp_calls SET timeline_event_id=${eventId} WHERE id=${callId}`.execute(this.db);
  }
}

// ---------------------------------------------------------------- service

const mapWaStatus = (s: string) => (["sent", "delivered", "read", "failed"].includes(s.toLowerCase()) ? s.toLowerCase() : s);
const mapTwilioStatus = (s: string) => s.toLowerCase();
const conversationKey = (phone: string) => digitsOnly(normalizePhone(phone));
const errorText = (err: unknown) => pgxMessage(err);

export interface CommunicationsDeps {
  whatsapp?: WhatsAppProvider;
  twilio?: TwilioProvider;
}

/** Meta WhatsApp messaging and Twilio calling; both write into the unified CRM timeline. */
export class CommunicationsService {
  readonly repo: CommunicationsRepository;
  private readonly whatsapp: WhatsAppProvider;
  private readonly twilio: TwilioProvider;
  private readonly publicBaseUrl: string;
  private readonly meta: MetaWhatsAppEnv;

  constructor(
    db: Database,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
    publicBaseUrl: string,
    meta: MetaWhatsAppEnv = { appId: "", appSecret: "", configId: "", verifyToken: "", graphApiVersion: "v21.0", publicApiUrl: "" },
    deps: CommunicationsDeps = {},
  ) {
    this.repo = new CommunicationsRepository(db);
    this.whatsapp = deps.whatsapp ?? new MetaWhatsAppProvider();
    this.twilio = deps.twilio ?? new TwilioVoiceProvider();
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    this.meta = {
      ...meta,
      publicApiUrl: (meta.publicApiUrl || publicBaseUrl).replace(/\/+$/, ""),
      graphApiVersion: meta.graphApiVersion || "v21.0",
    };
  }

  /** Public Embedded Signup config for the frontend (no secrets). */
  whatsappConnectConfig(): Json {
    const configured = metaWhatsAppConfigured(this.meta);
    return {
      configured,
      appId: configured ? this.meta.appId : "",
      configId: configured ? this.meta.configId : "",
      graphApiVersion: this.meta.graphApiVersion || "v21.0",
    };
  }

  async listAccounts(provider: string): Promise<Json[]> {
    try {
      return (await this.repo.listAccounts(provider, true)).map(accountJson);
    } catch (err) {
      throw AppError.internal("failed to list communication accounts", err);
    }
  }

  async createAccount(actorId: string, in_: CreateAccountInput, meta: RequestMeta): Promise<Json | null> {
    if (in_.provider !== ProviderMetaWhatsApp && in_.provider !== ProviderTwilioVoice) {
      throw AppError.validation("provider must be meta_whatsapp or twilio_voice");
    }
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    let a: Account | null;
    try {
      a = await this.repo.createAccount(in_);
    } catch (err) {
      throw AppError.internal("failed to create account", err);
    }
    if (!a) throw AppError.internal("failed to create account", new NoRowsError());
    await this.audit.record(actorId, "communications.account_created", "communication_account", a.id, { name: a.name, provider: a.provider }, meta);
    return accountJson(a);
  }

  /**
   * Finish Meta Embedded Signup: exchange the short-lived code, subscribe the WABA,
   * and store the SE's WhatsApp number. Platform Meta app credentials come from env.
   */
  async completeEmbeddedSignup(actorId: string, in_: EmbeddedSignupInput, meta: RequestMeta): Promise<Json | null> {
    if (!metaWhatsAppConfigured(this.meta)) {
      throw AppError.validation("WhatsApp connect is not configured — set META_APP_ID, META_APP_SECRET, and META_WHATSAPP_CONFIG_ID");
    }
    if (in_.code.trim() === "") throw AppError.validation("authorization code is required");
    if (in_.phoneNumberId.trim() === "") throw AppError.validation("phone number ID is required");
    if (in_.wabaId.trim() === "") throw AppError.validation("WhatsApp Business Account ID is required");

    const existing = await this.repo.findAccountByExternal(ProviderMetaWhatsApp, in_.phoneNumberId.trim()).catch(() => null);
    if (existing) throw AppError.conflict("this WhatsApp number is already connected");

    let accessToken: string;
    try {
      ({ accessToken } = await exchangeEmbeddedSignupCode(this.meta, in_.code.trim()));
    } catch (err) {
      throw AppError.internal("failed to exchange WhatsApp authorization code", err);
    }

    try {
      await subscribeWaba(this.meta, in_.wabaId.trim(), accessToken);
    } catch (err) {
      throw AppError.internal("failed to subscribe WhatsApp webhooks for this number", err);
    }

    try {
      await registerPhoneNumber(this.meta, in_.phoneNumberId.trim(), accessToken, "");
    } catch {
      // Optional when Meta already registered the number during Embedded Signup.
    }

    let display = in_.displayPhoneNumber.trim();
    if (display === "") {
      display = await fetchPhoneDisplayNumber(this.meta, in_.phoneNumberId.trim(), accessToken).catch(() => "");
    }
    if (display === "") display = in_.phoneNumberId.trim();

    const verifyToken = this.meta.verifyToken.trim() || `aurora-${actorId.slice(0, 8)}`;
    const credentials: Record<string, string> = {
      access_token: accessToken,
      app_secret: this.meta.appSecret,
      verify_token: verifyToken,
      graph_api_version: this.meta.graphApiVersion || "v21.0",
      waba_id: in_.wabaId.trim(),
    };

    return this.createAccount(
      actorId,
      {
        provider: ProviderMetaWhatsApp,
        name: display,
        displayIdentifier: normalizePhone(display),
        externalAccountId: in_.phoneNumberId.trim(),
        credentials,
        ownerUserId: actorId,
        teamId: undefined,
        allowRecordings: false,
        isActive: true,
      },
      meta,
    );
  }

  /** Connect a Meta WhatsApp Cloud API number for the signed-in user (manual credentials). */
  async connectWhatsApp(actorId: string, in_: ConnectWhatsAppInput, meta: RequestMeta): Promise<Json | null> {
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    if (in_.displayIdentifier.trim() === "") throw AppError.validation("WhatsApp number is required");
    if (in_.externalAccountId.trim() === "") throw AppError.validation("phone number ID is required");
    if (in_.accessToken.trim() === "") throw AppError.validation("access token is required");
    if (in_.appSecret.trim() === "") throw AppError.validation("app secret is required");
    if (in_.verifyToken.trim() === "") throw AppError.validation("verify token is required");

    const existing = await this.repo.findAccountByExternal(ProviderMetaWhatsApp, in_.externalAccountId.trim()).catch(() => null);
    if (existing) throw AppError.conflict("this WhatsApp number is already connected");

    const credentials: Record<string, string> = {
      access_token: in_.accessToken.trim(),
      app_secret: in_.appSecret.trim(),
      verify_token: in_.verifyToken.trim(),
    };
    const ver = in_.graphApiVersion.trim();
    if (ver !== "") credentials.graph_api_version = ver;

    return this.createAccount(
      actorId,
      {
        provider: ProviderMetaWhatsApp,
        name: in_.name.trim(),
        displayIdentifier: normalizePhone(in_.displayIdentifier),
        externalAccountId: in_.externalAccountId.trim(),
        credentials,
        ownerUserId: actorId,
        teamId: undefined,
        allowRecordings: false,
        isActive: true,
      },
      meta,
    );
  }

  async disconnectAccount(actorId: string, accountId: string, canManage: boolean, meta: RequestMeta): Promise<Json> {
    let a: Account | null;
    try {
      a = await this.repo.getAccount(accountId);
    } catch (err) {
      throw AppError.internal("failed to load account", err);
    }
    if (!a) throw AppError.notFound("communication account not found");
    if (!a.isActive) return accountJson(a);
    const isOwner = a.ownerUserId !== null && a.ownerUserId === actorId;
    if (!isOwner && !canManage) {
      throw AppError.forbidden("you can only disconnect WhatsApp accounts you connected");
    }
    let updated: Account | null;
    try {
      updated = await this.repo.deactivateAccount(accountId);
    } catch (err) {
      throw AppError.internal("failed to disconnect account", err);
    }
    if (!updated) throw AppError.notFound("communication account not found");
    await this.audit.record(actorId, "communications.account_disconnected", "communication_account", updated.id, { provider: updated.provider }, meta);
    return accountJson(updated);
  }

  async listWhatsApp(
    customerId: string,
    dealId: string,
    leadId: string,
    conversationKey: string,
    limit: number,
    offset: number,
  ) {
    if (customerId === "" && dealId === "" && leadId === "" && conversationKey === "") {
      throw AppError.validation("customerId, dealId, leadId, or conversationKey is required");
    }
    const { items, total } = await this.repo.listWhatsAppMessages(
      customerId,
      dealId,
      leadId,
      conversationKey,
      limit,
      offset,
    );
    return { items: items.map(whatsappJson), total };
  }

  async listWhatsAppConversations(q: string, limit: number, offset: number) {
    const { items, total } = await this.repo.listWhatsAppConversations(q, limit, offset);
    return { items: items.map(whatsappConversationJson), total };
  }

  async listCalls(customerId: string, dealId: string, leadId: string, limit: number, offset: number) {
    if (customerId === "" && dealId === "" && leadId === "") {
      throw AppError.validation("customerId, dealID, or leadId is required");
    }
    const { items, total } = await this.repo.listCalls(customerId, dealId, leadId, limit, offset);
    return { items: items.map(callJson), total };
  }

  async sendWhatsApp(actorId: string, in_: SendWhatsAppInput, meta: RequestMeta): Promise<Json> {
    if (in_.body.trim() === "" && in_.mediaUrl.trim() === "") throw AppError.validation("body or mediaUrl is required");
    const links = await this.normalizeLinks(in_);
    const acct = await this.resolveAccount(ProviderMetaWhatsApp, in_.accountId);
    const to = await this.recipient(in_.to, links, "recipient phone is required");

    let result;
    try {
      result = await this.pickWhatsAppProvider(acct).send({
        toPhoneNumberId: acct.externalAccountId,
        to,
        body: in_.body,
        mediaUrl: in_.mediaUrl,
        accessToken: acct.credentials.access_token ?? "",
        graphApiVersion: coalesce(acct.credentials.graph_api_version ?? "", "v21.0"),
      });
    } catch (err) {
      throw AppError.internal("whatsapp send failed", err);
    }

    let saved: WhatsAppMessage;
    try {
      saved = await this.repo.insertWhatsAppMessage(
        {
          accountId: acct.id, direction: DirectionOutbound, status: "sent",
          providerMessageId: result.providerMessageId, conversationKey: conversationKey(to),
          fromNumber: acct.displayIdentifier, toNumber: normalizePhone(to),
          body: in_.body, mediaUrl: in_.mediaUrl, mediaMime: "", mediaFilename: "", errorCode: "", errorMessage: "",
          leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
          activityId: null, timelineEventId: null, actorUserId: actorId, occurredAt: new Date(),
        },
        result.raw,
      );
    } catch (err) {
      throw AppError.internal("failed to store whatsapp message", err);
    }
    const ev = await this.recordTimeline({
      eventType: TimelineEvent.WhatsApp, title: "WhatsApp message", body: truncateBytes(in_.body, 500), source: "whatsapp",
      externalId: result.providerMessageId, externalProvider: ProviderMetaWhatsApp,
      actorUserId: actorId, ...links,
      metadata: { accountId: acct.id, direction: DirectionOutbound, messageId: saved.id, status: "sent", to: normalizePhone(to) },
    });
    if (ev) {
      saved = { ...saved, timelineEventId: ev };
      await this.repo.updateWhatsAppStatus(acct.id, result.providerMessageId, "sent", "", "").catch(() => null);
      await this.repo.linkWhatsAppTimeline(saved.id, ev).catch(() => undefined);
    }
    await this.audit.record(actorId, "whatsapp.message_sent", "whatsapp_message", saved.id, { accountId: acct.id, to }, meta);
    return whatsappJson(saved);
  }

  async placeCall(actorId: string, in_: PlaceCallInput, meta: RequestMeta): Promise<Json> {
    const links = await this.normalizeLinks(in_);
    const acct = await this.resolveAccount(ProviderTwilioVoice, in_.accountId);
    const to = await this.recipient(in_.to, links, "destination phone is required");
    const from = coalesce(acct.displayIdentifier, acct.credentials.from_number ?? "");

    let result;
    try {
      result = await this.pickTwilioProvider(acct).placeCall({
        accountSid: acct.credentials.account_sid ?? "",
        authToken: acct.credentials.auth_token ?? "",
        from,
        to,
        statusCallbackUrl: `${this.publicBaseUrl}/api/v1/webhooks/twilio/voice/status`,
        twimlUrl: "",
      });
    } catch (err) {
      throw AppError.internal("twilio call failed", err);
    }

    let saved: TwilioCall;
    try {
      saved = await this.repo.insertCall(
        {
          accountId: acct.id, direction: DirectionOutbound, status: coalesce(result.status, "queued"),
          providerCallSid: result.callSid, fromNumber: from, toNumber: normalizePhone(to),
          durationSeconds: null, recordingSid: "", recordingUrl: "", errorCode: "", errorMessage: "",
          leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
          activityId: null, timelineEventId: null, actorUserId: actorId,
        },
        result.raw,
      );
    } catch (err) {
      throw AppError.internal("failed to store call", err);
    }
    const ev = await this.recordTimeline({
      eventType: TimelineEvent.Call, title: "Call", body: `Outbound call to ${normalizePhone(to)}`,
      source: "twilio", externalId: result.callSid, externalProvider: ProviderTwilioVoice,
      actorUserId: actorId, ...links,
      metadata: { accountId: acct.id, callId: saved.id, direction: DirectionOutbound, status: saved.status },
    });
    if (ev) {
      await this.repo.linkCallTimeline(saved.id, ev).catch(() => undefined);
      saved = { ...saved, timelineEventId: ev };
    }
    await this.audit.record(actorId, "twilio.call_placed", "twilio_call", saved.id, { accountId: acct.id, to }, meta);
    return callJson(saved);
  }

  async listWhatsAppCalls(
    customerId: string,
    dealId: string,
    leadId: string,
    status: string,
    activeOnly: boolean,
    limit: number,
    offset: number,
  ) {
    const { items, total } = await this.repo.listWhatsAppCalls(customerId, dealId, leadId, status, activeOnly, limit, offset);
    return { items: items.map(whatsappCallJson), total };
  }

  async getWhatsAppCall(id: string): Promise<Json> {
    try {
      return whatsappCallJson(await this.repo.getWhatsAppCall(id));
    } catch (err) {
      if (err instanceof NoRowsError) throw AppError.notFound("whatsapp call not found");
      throw AppError.internal("failed to load whatsapp call", err);
    }
  }

  async requestCallPermission(actorId: string, in_: CallPermissionInput, meta: RequestMeta): Promise<Json> {
    const links = await this.normalizeLinks(in_);
    const acct = await this.resolveAccount(ProviderMetaWhatsApp, in_.accountId);
    const to = await this.recipient(in_.to, links, "recipient phone is required");
    let result;
    try {
      result = await this.pickWhatsAppProvider(acct).sendCallPermission({
        phoneNumberId: acct.externalAccountId,
        accessToken: acct.credentials.access_token ?? "",
        graphApiVersion: coalesce(acct.credentials.graph_api_version ?? "", "v21.0"),
        to,
        body: in_.body,
      });
    } catch (err) {
      throw AppError.internal("whatsapp call permission failed", err);
    }
    const saved = await this.repo.insertWhatsAppMessage(
      {
        accountId: acct.id, direction: DirectionOutbound, status: "sent",
        providerMessageId: result.providerMessageId, conversationKey: conversationKey(to),
        fromNumber: acct.displayIdentifier, toNumber: normalizePhone(to),
        body: in_.body.trim() || "Call permission request", mediaUrl: "", mediaMime: "", mediaFilename: "",
        errorCode: "", errorMessage: "",
        leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
        activityId: null, timelineEventId: null, actorUserId: actorId, occurredAt: toSecond(new Date()),
      },
      result.raw,
    );
    await this.recordTimeline({
      eventType: TimelineEvent.WhatsApp, title: "WhatsApp call permission",
      body: "Requested permission to call on WhatsApp", source: "whatsapp",
      externalId: result.providerMessageId, externalProvider: ProviderMetaWhatsApp,
      leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
      metadata: { accountId: acct.id, messageId: saved.id, kind: "call_permission_request" },
    });
    await this.audit.record(actorId, "whatsapp.call_permission", "whatsapp_message", saved.id, { accountId: acct.id, to }, meta);
    return whatsappJson(saved);
  }

  async initiateWhatsAppCall(actorId: string, in_: InitiateWhatsAppCallInput, meta: RequestMeta): Promise<Json> {
    if (in_.sdp.trim() === "") throw AppError.validation("sdp is required");
    const links = await this.normalizeLinks(in_);
    const acct = await this.resolveAccount(ProviderMetaWhatsApp, in_.accountId);
    const to = await this.recipient(in_.to, links, "recipient phone is required");
    const sdpType = coalesce(in_.sdpType, "offer");
    let result;
    try {
      result = await this.pickWhatsAppProvider(acct).callAction({
        phoneNumberId: acct.externalAccountId,
        accessToken: acct.credentials.access_token ?? "",
        graphApiVersion: coalesce(acct.credentials.graph_api_version ?? "", "v21.0"),
        action: "connect",
        callId: "",
        to,
        sdp: in_.sdp,
        sdpType,
        bizOpaqueCallbackData: "",
      });
    } catch (err) {
      throw AppError.internal("whatsapp call initiate failed", err);
    }
    let saved: WhatsAppCall;
    try {
      saved = await this.repo.insertWhatsAppCall(
        {
          accountId: acct.id, direction: DirectionOutbound, status: "connecting",
          providerCallId: result.callId, fromNumber: acct.displayIdentifier, toNumber: normalizePhone(to),
          durationSeconds: null, remoteSdp: "", remoteSdpType: "", localSdp: in_.sdp, localSdpType: sdpType,
          errorCode: "", errorMessage: "",
          leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
          activityId: null, timelineEventId: null, actorUserId: actorId,
        },
        result.raw,
      );
    } catch (err) {
      throw AppError.internal("failed to store whatsapp call", err);
    }
    const tev = await this.recordTimeline({
      eventType: TimelineEvent.Call, title: "WhatsApp call",
      body: `Outbound WhatsApp call to ${normalizePhone(to)}`, source: "whatsapp",
      externalId: result.callId, externalProvider: ProviderMetaWhatsApp,
      leadId: links.leadId ?? null, customerId: links.customerId ?? null, dealId: links.dealId ?? null,
      metadata: { accountId: acct.id, callId: saved.id, direction: DirectionOutbound, status: saved.status, channel: "whatsapp" },
    });
    if (tev) await this.repo.linkWhatsAppCallTimeline(saved.id, tev).catch(() => undefined);
    await this.audit.record(actorId, "whatsapp.call_initiated", "whatsapp_call", saved.id, { accountId: acct.id, to }, meta);
    return whatsappCallJson(saved);
  }

  async preAcceptWhatsAppCall(actorId: string, callId: string, in_: WhatsAppCallSignalInput, meta: RequestMeta): Promise<Json> {
    return this.signalWhatsAppCall(actorId, callId, "pre_accept", in_, "connecting", meta);
  }

  async acceptWhatsAppCall(actorId: string, callId: string, in_: WhatsAppCallSignalInput, meta: RequestMeta): Promise<Json> {
    return this.signalWhatsAppCall(actorId, callId, "accept", in_, "in-progress", meta);
  }

  async rejectWhatsAppCall(actorId: string, callId: string, meta: RequestMeta): Promise<Json> {
    return this.signalWhatsAppCall(actorId, callId, "reject", { sdp: "", sdpType: "" }, "rejected", meta);
  }

  async terminateWhatsAppCall(actorId: string, callId: string, meta: RequestMeta): Promise<Json> {
    return this.signalWhatsAppCall(actorId, callId, "terminate", { sdp: "", sdpType: "" }, "completed", meta);
  }

  private async signalWhatsAppCall(
    actorId: string,
    callId: string,
    action: "pre_accept" | "accept" | "reject" | "terminate",
    in_: WhatsAppCallSignalInput,
    nextStatus: string,
    meta: RequestMeta,
  ): Promise<Json> {
    let call: WhatsAppCall;
    try {
      call = await this.repo.getWhatsAppCall(callId);
    } catch (err) {
      if (err instanceof NoRowsError) throw AppError.notFound("whatsapp call not found");
      throw AppError.internal("failed to load whatsapp call", err);
    }
    if (call.providerCallId === "") throw AppError.validation("call has no provider id yet");
    const acct = await this.resolveAccount(ProviderMetaWhatsApp, call.accountId);
    try {
      await this.pickWhatsAppProvider(acct).callAction({
        phoneNumberId: acct.externalAccountId,
        accessToken: acct.credentials.access_token ?? "",
        graphApiVersion: coalesce(acct.credentials.graph_api_version ?? "", "v21.0"),
        action,
        callId: call.providerCallId,
        to: "",
        sdp: in_.sdp,
        sdpType: in_.sdpType || (in_.sdp ? "answer" : ""),
        bizOpaqueCallbackData: "",
      });
    } catch (err) {
      throw AppError.internal(`whatsapp call ${action} failed`, err);
    }
    if (in_.sdp.trim() !== "") {
      call = await this.repo.updateWhatsAppCallLocalSdp(call.id, in_.sdp, in_.sdpType || "answer", nextStatus);
    } else {
      call = (await this.repo.updateWhatsAppCallFromWebhook(call.providerCallId, nextStatus, "", "", null, action === "terminate" || action === "reject"))!;
    }
    await this.audit.record(actorId, `whatsapp.call_${action}`, "whatsapp_call", call.id, { status: nextStatus }, meta);
    return whatsappCallJson(call);
  }

  // ---------------------------------------------------------------- webhooks

  /** The challenge to echo, or null to reject. Account load errors propagate unwrapped. */
  async verifyMetaWhatsApp(mode: string, token: string, challenge: string): Promise<string | null> {
    // Shared env verify token (Embedded Signup) before per-account tokens.
    if (this.meta.verifyToken.trim() !== "") {
      const out = this.whatsapp.verifyWebhook(mode, token, challenge, this.meta.verifyToken);
      if (out !== null) return out;
    }
    for (const a of await this.repo.listAccounts(ProviderMetaWhatsApp, true)) {
      const out = this.pickWhatsAppProvider(a).verifyWebhook(mode, token, challenge, a.credentials.verify_token ?? "");
      if (out !== null) return out;
    }
    return null;
  }

  async handleMetaWhatsAppWebhook(signature: string, body: Buffer): Promise<void> {
    let accounts: Account[];
    try {
      accounts = await this.repo.listAccounts(ProviderMetaWhatsApp, true);
    } catch (err) {
      throw AppError.internal("failed to load accounts", err);
    }
    if (accounts.length === 0) throw AppError.validation("no whatsapp accounts configured");
    let parser: WhatsAppProvider = this.whatsapp;
    let valid = false;
    if (this.meta.appSecret.trim() !== "" && this.whatsapp.validateSignature(this.meta.appSecret, body, signature)) {
      valid = true;
    }
    for (const a of accounts) {
      const p = this.pickWhatsAppProvider(a);
      if (p.validateSignature(a.credentials.app_secret ?? "", body, signature)) {
        valid = true;
        parser = p;
        break;
      }
    }
    const anySecret = this.meta.appSecret.trim() !== "" || accounts.some((a) => !!(a.credentials.app_secret ?? ""));
    if (!valid && anySecret) {
      throw AppError.forbidden("invalid Meta webhook signature");
    }
    let events: InboundWhatsAppEvent[];
    let callEvents: InboundWhatsAppCallEvent[];
    try {
      events = parser.parseWebhook(body);
      callEvents = parser.parseCallWebhook(body);
    } catch {
      throw AppError.validation("invalid webhook payload");
    }
    for (const ev of events) {
      let claimed: boolean;
      try {
        claimed = await this.repo.claimWebhook(ProviderMetaWhatsApp, ev.eventKey, ev.raw);
      } catch (err) {
        throw AppError.internal("webhook idempotency failed", err);
      }
      if (!claimed) continue;
      try {
        await this.applyWhatsAppEvent(ev);
        await this.repo.completeWebhook(ProviderMetaWhatsApp, ev.eventKey, "processed", "", 200).catch(() => undefined);
      } catch (err) {
        await this.repo.completeWebhook(ProviderMetaWhatsApp, ev.eventKey, "failed", errorText(err), 200).catch(() => undefined);
      }
    }
    for (const ev of callEvents) {
      let claimed: boolean;
      try {
        claimed = await this.repo.claimWebhook(ProviderMetaWhatsApp, ev.eventKey, ev.raw);
      } catch (err) {
        throw AppError.internal("webhook idempotency failed", err);
      }
      if (!claimed) continue;
      try {
        await this.applyWhatsAppCallEvent(ev);
        await this.repo.completeWebhook(ProviderMetaWhatsApp, ev.eventKey, "processed", "", 200).catch(() => undefined);
      } catch (err) {
        await this.repo.completeWebhook(ProviderMetaWhatsApp, ev.eventKey, "failed", errorText(err), 200).catch(() => undefined);
      }
    }
  }

  /** form is the parsed POST body; fullUrl the public URL Twilio signed. */
  async handleTwilioStatus(signature: string, fullUrlPath: string, form: Form): Promise<void> {
    let accounts: Account[];
    try {
      accounts = await this.repo.listAccounts(ProviderTwilioVoice, true);
    } catch (err) {
      throw AppError.internal("failed to load accounts", err);
    }
    const fullUrl = this.publicBaseUrl + fullUrlPath;
    let provider: TwilioProvider = this.twilio;
    let valid = false;
    for (const a of accounts) {
      const p = this.pickTwilioProvider(a);
      if (p.validateSignature(a.credentials.auth_token ?? "", fullUrl, form, signature)) {
        valid = true;
        provider = p;
        break;
      }
    }
    if (!valid && !accounts.every((a) => !a.credentials.auth_token)) {
      throw AppError.forbidden("invalid Twilio signature");
    }
    let ev: CallStatusEvent;
    try {
      ev = provider.parseStatusCallback(form);
    } catch (err) {
      throw AppError.validation(err instanceof Error ? err.message : String(err));
    }
    let claimed: boolean;
    try {
      claimed = await this.repo.claimWebhook(ProviderTwilioVoice, ev.eventKey, ev.raw);
    } catch (err) {
      throw AppError.internal("webhook idempotency failed", err);
    }
    if (!claimed) return;
    try {
      await this.applyCallStatus(ev);
      await this.repo.completeWebhook(ProviderTwilioVoice, ev.eventKey, "processed", "", 200).catch(() => undefined);
    } catch (err) {
      await this.repo.completeWebhook(ProviderTwilioVoice, ev.eventKey, "failed", errorText(err), 200).catch(() => undefined);
    }
  }

  private async applyWhatsAppEvent(ev: InboundWhatsAppEvent): Promise<void> {
    let acct = await this.repo.findAccountByExternal(ProviderMetaWhatsApp, ev.phoneNumberId);
    if (!acct) {
      const list = await this.repo.listAccounts(ProviderMetaWhatsApp, true).catch(() => []);
      if (list.length === 0) throw new Error(`no matching whatsapp account for phone_number_id ${ev.phoneNumberId}`);
      acct = list[0]!;
    }

    if (ev.kind === "status") {
      const msg = await this.repo.updateWhatsAppStatus(acct.id, ev.providerMessageId, mapWaStatus(ev.status), "", "");
      if (msg) {
        await this.recordTimeline({
          eventType: TimelineEvent.WhatsApp, title: `WhatsApp ${ev.status}`, body: `Message ${ev.status}`, source: "whatsapp",
          externalId: `${ev.providerMessageId}:${ev.status}`, externalProvider: ProviderMetaWhatsApp,
          leadId: msg.leadId, customerId: msg.customerId, dealId: msg.dealId,
          metadata: { direction: msg.direction, messageId: msg.id, status: ev.status },
        });
      }
      return;
    }

    const { customerId, leadId } = await this.repo.resolvePhoneContext(ev.from);
    if (customerId === null && leadId === null) throw new Error(`no CRM contact matched phone ${ev.from}`);
    const saved = await this.repo.insertWhatsAppMessage(
      {
        accountId: acct.id, direction: DirectionInbound, status: "received",
        providerMessageId: ev.providerMessageId, conversationKey: conversationKey(ev.from),
        fromNumber: normalizePhone(ev.from), toNumber: coalesce(ev.to, acct.displayIdentifier),
        body: ev.body, mediaUrl: ev.mediaUrl, mediaMime: ev.mediaMime, mediaFilename: ev.mediaFilename,
        errorCode: "", errorMessage: "", leadId, customerId, dealId: null, activityId: null, timelineEventId: null,
        actorUserId: null, occurredAt: ev.timestamp,
      },
      ev.raw,
    );
    const tev = await this.recordTimeline({
      eventType: TimelineEvent.WhatsApp, title: ev.mediaUrl !== "" ? "WhatsApp attachment" : "WhatsApp message",
      body: truncateBytes(ev.body, 500), source: "whatsapp", externalId: ev.providerMessageId, externalProvider: ProviderMetaWhatsApp,
      occurredAt: ev.timestamp, leadId, customerId,
      metadata: {
        accountId: acct.id, direction: DirectionInbound, from: normalizePhone(ev.from), hasAttachment: ev.mediaUrl !== "",
        messageId: saved.id, status: "received",
      },
    });
    if (tev) await this.repo.linkWhatsAppTimeline(saved.id, tev).catch(() => undefined);
  }

  private async applyWhatsAppCallEvent(ev: InboundWhatsAppCallEvent): Promise<void> {
    let acct = await this.repo.findAccountByExternal(ProviderMetaWhatsApp, ev.phoneNumberId);
    if (!acct) {
      const list = await this.repo.listAccounts(ProviderMetaWhatsApp, true).catch(() => []);
      if (list.length === 0) throw new Error(`no matching whatsapp account for phone_number_id ${ev.phoneNumberId}`);
      acct = list[0]!;
    }

    const event = ev.event.toLowerCase();
    const isTerminate = event === "terminate";
    const isUserInitiated = ev.direction.toUpperCase().includes("USER") || (!ev.direction && event === "connect");

    if (event === "connect" || event === "terminate") {
      let call = await this.repo.getWhatsAppCallByProviderIdAny(ev.callId);
      if (!call && event === "connect" && isUserInitiated) {
        const userPhone = coalesce(ev.from, ev.to);
        const ctx = await this.repo.resolvePhoneContext(userPhone);
        const status = "ringing";
        call = await this.repo.insertWhatsAppCall(
          {
            accountId: acct.id,
            direction: DirectionInbound,
            status,
            providerCallId: ev.callId,
            fromNumber: normalizePhone(ev.from),
            toNumber: coalesce(normalizePhone(ev.to), acct.displayIdentifier),
            durationSeconds: null,
            remoteSdp: ev.sdp,
            remoteSdpType: ev.sdpType || "offer",
            localSdp: "",
            localSdpType: "",
            errorCode: "",
            errorMessage: "",
            leadId: ctx.leadId,
            customerId: ctx.customerId,
            dealId: null,
            activityId: null,
            timelineEventId: null,
            actorUserId: null,
          },
          ev.raw,
        );
        const tev = await this.recordTimeline({
          eventType: TimelineEvent.Call,
          title: "Incoming WhatsApp call",
          body: `Incoming WhatsApp call from ${normalizePhone(ev.from)}`,
          source: "whatsapp",
          externalId: ev.callId,
          externalProvider: ProviderMetaWhatsApp,
          leadId: ctx.leadId,
          customerId: ctx.customerId,
          metadata: { accountId: acct.id, callId: call.id, direction: DirectionInbound, status, channel: "whatsapp" },
        });
        if (tev) await this.repo.linkWhatsAppCallTimeline(call.id, tev).catch(() => undefined);
        return;
      }

      let status = "";
      if (isTerminate) {
        const raw = ev.status.toLowerCase();
        if (raw.includes("fail")) status = "failed";
        else if (raw.includes("reject")) status = "rejected";
        else if (raw.includes("miss") || raw.includes("not answer")) status = "missed";
        else status = "completed";
      } else if (event === "connect" && ev.sdp) {
        status = "connecting";
      }

      call = await this.repo.updateWhatsAppCallFromWebhook(
        ev.callId,
        status,
        ev.sdp,
        ev.sdpType,
        ev.duration,
        isTerminate,
      );
      if (!call) return;

      await this.recordTimeline({
        eventType: TimelineEvent.Call,
        title: isTerminate ? "WhatsApp call ended" : "WhatsApp call update",
        body: call.durationSeconds !== null ? `WhatsApp call ${call.status} - ${call.durationSeconds}s` : `WhatsApp call ${call.status}`,
        source: "whatsapp",
        externalId: `${ev.callId}:${event}`,
        externalProvider: ProviderMetaWhatsApp,
        leadId: call.leadId,
        customerId: call.customerId,
        dealId: call.dealId,
        metadata: {
          accountId: acct.id,
          callId: call.id,
          direction: call.direction,
          durationSeconds: call.durationSeconds,
          status: call.status,
          channel: "whatsapp",
        },
      });
    }
  }

  private async applyCallStatus(ev: CallStatusEvent): Promise<void> {
    let call = await this.repo.updateCallStatus(ev.callSid, mapTwilioStatus(ev.callStatus), ev.duration, ev.recordingSid, ev.recordingUrl);
    if (!call) {
      // An inbound call not placed from the CRM: attach it by phone.
      let ctx = await this.repo.resolvePhoneContext(ev.from);
      if (ctx.customerId === null && ctx.leadId === null) ctx = await this.repo.resolvePhoneContext(ev.to);
      if (ctx.customerId === null && ctx.leadId === null) throw new Error(`unknown call sid ${ev.callSid}`);
      const accounts = await this.repo.listAccounts(ProviderTwilioVoice, true).catch(() => []);
      if (accounts.length === 0) throw new Error("no twilio accounts");
      const acct = accounts.find((a) => (a.credentials.account_sid ?? "") === ev.accountSid) ?? accounts[0]!;
      call = await this.repo.insertCall(
        {
          accountId: acct.id, direction: ev.direction.toLowerCase().includes("outbound") ? DirectionOutbound : DirectionInbound,
          status: mapTwilioStatus(ev.callStatus), providerCallSid: ev.callSid, fromNumber: ev.from, toNumber: ev.to,
          durationSeconds: ev.duration, recordingSid: ev.recordingSid, recordingUrl: ev.recordingUrl, errorCode: "", errorMessage: "",
          customerId: ctx.customerId, leadId: ctx.leadId, dealId: null, activityId: null, timelineEventId: null, actorUserId: null,
        },
        ev.raw,
      );
    }

    const recording: Json = {};
    if (call.recordingUrl !== "") {
      // Recording references are only surfaced when the account allows them.
      const acct = await this.repo.getAccount(call.accountId).catch(() => null);
      if (acct?.allowRecordings) {
        recording.recordingSid = call.recordingSid;
        recording.recordingUrl = call.recordingUrl;
      }
    }
    await this.recordTimeline({
      eventType: TimelineEvent.Call, title: "Call update",
      body: call.durationSeconds !== null ? `Call ${call.status} - ${call.durationSeconds}s` : `Call ${call.status}`,
      source: "twilio", externalId: `${ev.callSid}:${ev.callStatus}`, externalProvider: ProviderTwilioVoice,
      leadId: call.leadId, customerId: call.customerId, dealId: call.dealId,
      metadata: { callId: call.id, direction: call.direction, durationSeconds: call.durationSeconds, status: call.status, ...recording },
    });
  }

  // ---------------------------------------------------------------- helpers

  /** RecordIdempotent with the error discarded; the event id, or null when the write failed. */
  private async recordTimeline(in_: TimelineWriteInput): Promise<string | null> {
    try {
      return (await this.timeline.recordIdempotent(in_)).event.id;
    } catch {
      return null;
    }
  }

  private async normalizeLinks(in_: Links): Promise<Links> {
    let { leadId, customerId, dealId } = in_;
    if (dealId !== undefined && dealId.trim() !== "" && (customerId === undefined || customerId === "")) {
      try {
        customerId = await this.repo.dealCustomerId(dealId);
      } catch {
        throw AppError.notFound("deal not found");
      }
    }
    if ((leadId === undefined || leadId === "") && (customerId === undefined || customerId === "") && (dealId === undefined || dealId === "")) {
      throw AppError.validation("customerId, leadId, or dealId is required");
    }
    return { leadId, customerId, dealId };
  }

  private async resolveAccount(provider: string, id: string): Promise<Account> {
    const whatsapp = provider === ProviderMetaWhatsApp;
    if (id !== "") {
      // Go treats any load error as not found: the account is nil whenever err is set.
      const a = await this.repo.getAccount(id).catch(() => null);
      if (!a) throw AppError.notFound(whatsapp ? "whatsapp account not found" : "twilio account not found");
      if (a.provider !== provider || !a.isActive) {
        throw AppError.validation(whatsapp ? "account is not an active WhatsApp account" : "account is not an active Twilio voice account");
      }
      return a;
    }
    let list: Account[];
    try {
      list = await this.repo.listAccounts(provider, true);
    } catch (err) {
      throw AppError.internal("failed to list accounts", err);
    }
    if (list.length === 0) {
      throw AppError.validation(
        whatsapp
          ? "no WhatsApp accounts configured — add one under communications"
          : "no Twilio accounts configured — add one under communications",
      );
    }
    return list[0]!;
  }

  private async recipient(given: string, links: Links, missing: string): Promise<string> {
    let to = given.trim();
    if (to === "") {
      try {
        to = await this.repo.loadEntityPhone(links.customerId ?? "", links.leadId ?? "", links.dealId ?? "");
      } catch (err) {
        throw AppError.internal("failed to resolve phone", err);
      }
    }
    if (to.trim() === "") throw AppError.validation(missing);
    return to;
  }

  private pickWhatsAppProvider(a: Account): WhatsAppProvider {
    if ((a.credentials.access_token ?? "") !== "" && a.externalAccountId !== "") {
      return this.whatsapp instanceof MetaWhatsAppProvider ? this.whatsapp : new MetaWhatsAppProvider();
    }
    return new DevWhatsAppProvider();
  }

  private pickTwilioProvider(a: Account): TwilioProvider {
    if ((a.credentials.account_sid ?? "") !== "" && (a.credentials.auth_token ?? "") !== "") {
      return this.twilio instanceof TwilioVoiceProvider ? this.twilio : new TwilioVoiceProvider();
    }
    return new DevTwilioProvider();
  }
}
