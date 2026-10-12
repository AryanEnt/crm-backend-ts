import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError, ErrorCode } from "../../lib/app-error.js";
import { goMapOrNull } from "../../lib/go-json.js";
import { parseRfc3339 } from "../../lib/go-time.js";
import { internal } from "../../lib/request-meta.js";
import { logger } from "../../logger.js";

/** Event type constants; stable for filters and external writers. */
export const TimelineEvent = {
  LeadCreated: "lead.created",
  CustomerCreated: "customer.created",
  DealCreated: "deal.created",
  ActivityCreated: "activity.created",
  ActivityCompleted: "activity.completed",
  Call: "call",
  WhatsApp: "whatsapp",
  Email: "email",
  Meeting: "meeting",
  Note: "note",
  StageChange: "stage_change",
  AssignmentChange: "assignment_change",
  DocumentRequested: "document.requested",
  DocumentUploaded: "document.uploaded",
  DocumentVerified: "document.verified",
  DocumentRejected: "document.rejected",
  Automation: "automation.event",
} as const;

export interface TimelineWriteInput {
  eventType: string;
  title: string;
  body?: string;
  occurredAt?: Date;
  actorUserId?: string | null;
  source?: string;
  externalId?: string;
  externalProvider?: string;
  leadId?: string | null;
  customerId?: string | null;
  dealId?: string | null;
  activityId?: string | null;
  documentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Go timeline.Event, in struct field order. */
export interface TimelineEventRow {
  id: string;
  eventType: string;
  title: string;
  body: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  source: string;
  externalId: string;
  externalProvider: string;
  leadId: string | null;
  customerId: string | null;
  dealId: string | null;
  activityId: string | null;
  documentId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface TimelineListFilter {
  customerId: string;
  dealId: string;
  leadId: string;
  eventTypes: string[];
  source: string;
  limit: number;
  offset: number;
}

/** The public payload for integrations (WhatsApp, Twilio, email, ...). */
export interface ExternalWriteInput {
  eventType: string;
  title: string;
  body: string;
  occurredAt: string | undefined;
  source: string;
  externalId: string;
  externalProvider: string;
  leadId: string | undefined;
  customerId: string | undefined;
  dealId: string | undefined;
  activityId: string | undefined;
  documentId: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

const EXTERNAL_SOURCES = new Set(["whatsapp", "twilio", "email", "automation", "external", "system"]);

/** Codes and labels served by GET /timeline/types, in Go's order. */
export const TIMELINE_EVENT_TYPES = [
  { code: TimelineEvent.LeadCreated, label: "Lead created" },
  { code: TimelineEvent.CustomerCreated, label: "Customer created" },
  { code: TimelineEvent.DealCreated, label: "Deal created" },
  { code: TimelineEvent.ActivityCreated, label: "Activity created" },
  { code: TimelineEvent.ActivityCompleted, label: "Activity completed" },
  { code: TimelineEvent.Call, label: "Call" },
  { code: TimelineEvent.WhatsApp, label: "WhatsApp message" },
  { code: TimelineEvent.Email, label: "Email" },
  { code: TimelineEvent.Meeting, label: "Meeting" },
  { code: TimelineEvent.Note, label: "Note" },
  { code: TimelineEvent.StageChange, label: "Stage change" },
  { code: TimelineEvent.AssignmentChange, label: "Assignment change" },
  { code: TimelineEvent.DocumentRequested, label: "Document requested" },
  { code: TimelineEvent.DocumentUploaded, label: "Document uploaded" },
  { code: TimelineEvent.DocumentVerified, label: "Document verified" },
  { code: TimelineEvent.DocumentRejected, label: "Document rejected" },
  { code: TimelineEvent.Automation, label: "Automation event" },
];

const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v : null);

const eventSelect = sql`
  SELECT e.id::text AS "id", e.event_type AS "eventType", e.title, e.body, e.occurred_at AS "occurredAt",
    e.actor_user_id::text AS "actorUserId", u.full_name AS "actorName", e.source,
    e.external_id AS "externalId", e.external_provider AS "externalProvider",
    e.lead_id::text AS "leadId", e.customer_id::text AS "customerId", e.deal_id::text AS "dealId",
    e.activity_id::text AS "activityId", e.document_id::text AS "documentId", e.metadata, e.created_at AS "createdAt"
  FROM timeline_events e
  LEFT JOIN users u ON u.id = e.actor_user_id`;

const toEvent = (r: TimelineEventRow): TimelineEventRow => ({ ...r, metadata: goMapOrNull(r.metadata) });

const refsOf = (in_: TimelineWriteInput) =>
  [in_.leadId, in_.customerId, in_.dealId, in_.activityId, in_.documentId].map(blankToNull);

function validateWrite(in_: TimelineWriteInput): void {
  if (in_.eventType.trim() === "") throw AppError.validation("eventType is required");
  if (refsOf(in_).every((r) => r === null)) throw AppError.validation("timeline event must reference a CRM entity");
}

export class TimelineService {
  constructor(private readonly db: Database) {}

  /**
   * Writes a timeline event. Never throws: every CRM caller discards the result
   * (`_, _ = s.timeline.Record(...)`), including validation failures.
   */
  async record(in_: TimelineWriteInput): Promise<void> {
    try {
      await this.write(in_);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.Validation) return;
      logger.warn({ err, eventType: in_.eventType }, "timeline record failed");
    }
  }

  /**
   * Go Service.RecordIdempotent: writes once per external_provider + external_id (webhook-safe).
   * Without both keys it is a plain write.
   */
  async recordIdempotent(in_: TimelineWriteInput): Promise<{ event: TimelineEventRow; existed: boolean }> {
    validateWrite(in_);
    const provider = in_.externalProvider ?? "";
    const externalId = in_.externalId ?? "";
    if (provider.trim() === "" || externalId.trim() === "") return { event: await this.write(in_), existed: false };
    const find = () =>
      internal("failed to write timeline event", async () => {
        const r = await sql<TimelineEventRow>`
          ${eventSelect} WHERE e.external_provider = ${provider} AND e.external_id = ${externalId} LIMIT 1`.execute(this.db);
        return r.rows[0] ? toEvent(r.rows[0]) : null;
      });
    const existing = await find();
    if (existing) return { event: existing, existed: true };
    try {
      return { event: await this.write(in_), existed: false };
    } catch (err) {
      // Lost a race on the unique index: return the winner.
      const winner = await find().catch(() => null);
      if (winner) return { event: winner, existed: true };
      throw err;
    }
  }

  /** Go Service.Record: validates, inserts and returns the stored event. */
  async write(in_: TimelineWriteInput): Promise<TimelineEventRow> {
    validateWrite(in_);
    const [leadId, customerId, dealId, activityId, documentId] = refsOf(in_);
    return internal("failed to write timeline event", async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO timeline_events (
          id, event_type, title, body, occurred_at, actor_user_id, source,
          external_id, external_provider, lead_id, customer_id, deal_id, activity_id, document_id, metadata
        ) VALUES (
          ${id}, ${in_.eventType}, ${in_.title.trim() === "" ? in_.eventType : in_.title}, ${in_.body ?? ""},
          ${in_.occurredAt ?? new Date()}, ${blankToNull(in_.actorUserId)}, ${in_.source || "crm"},
          ${in_.externalId ?? ""}, ${in_.externalProvider ?? ""},
          ${leadId}, ${customerId}, ${dealId}, ${activityId}, ${documentId}, ${JSON.stringify(in_.metadata ?? {})}::jsonb
        )`.execute(this.db);
      const r = await sql<TimelineEventRow>`${eventSelect} WHERE e.id = ${id}`.execute(this.db);
      if (!r.rows[0]) throw new Error("inserted timeline event not found");
      return toEvent(r.rows[0]);
    });
  }

  async writeExternal(actorId: string, in_: ExternalWriteInput): Promise<TimelineEventRow> {
    const source = in_.source || "external";
    if (!EXTERNAL_SOURCES.has(source)) throw AppError.validation("invalid source for external timeline write");
    let occurredAt: Date | undefined;
    const rawOccurred = in_.occurredAt?.trim() ?? "";
    if (rawOccurred !== "") {
      const t = parseRfc3339(rawOccurred);
      if (!t) throw AppError.validation("invalid occurredAt");
      occurredAt = t;
    }
    return this.write({
      eventType: in_.eventType,
      title: in_.title,
      body: in_.body,
      occurredAt,
      actorUserId: actorId || null,
      source,
      externalId: in_.externalId,
      externalProvider: in_.externalProvider,
      leadId: in_.leadId,
      customerId: in_.customerId,
      dealId: in_.dealId,
      activityId: in_.activityId,
      documentId: in_.documentId,
      metadata: in_.metadata,
    });
  }

  async list(f: TimelineListFilter): Promise<{ items: TimelineEventRow[]; total: number }> {
    if (f.customerId === "" && f.dealId === "" && f.leadId === "") {
      throw AppError.validation("customerId, dealId, or leadId is required");
    }
    const limit = f.limit <= 0 || f.limit > 100 ? 30 : f.limit;
    const where = [sql`1=1`];
    if (f.customerId !== "") where.push(sql`e.customer_id::text = ${f.customerId}`);
    if (f.dealId !== "") where.push(sql`e.deal_id::text = ${f.dealId}`);
    if (f.leadId !== "") where.push(sql`e.lead_id::text = ${f.leadId}`);
    if (f.source !== "") where.push(sql`e.source = ${f.source}`);
    if (f.eventTypes.length > 0) where.push(sql`e.event_type = ANY(${f.eventTypes}::text[])`);
    const whereSql = sql.join(where, sql` AND `);
    return internal("failed to list timeline", async () => {
      const count = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM timeline_events e WHERE ${whereSql}`.execute(this.db);
      const rows = await sql<TimelineEventRow>`
        ${eventSelect}
        WHERE ${whereSql}
        ORDER BY e.occurred_at DESC, e.created_at DESC
        LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
      return { items: rows.rows.map(toEvent), total: count.rows[0]?.total ?? 0 };
    });
  }

  async get(id: string): Promise<TimelineEventRow> {
    const r = await internal("failed to load timeline event", () =>
      sql<TimelineEventRow>`${eventSelect} WHERE e.id = ${id}`.execute(this.db),
    );
    if (!r.rows[0]) throw AppError.notFound("timeline event not found");
    return toEvent(r.rows[0]);
  }
}
