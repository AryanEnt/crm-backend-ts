import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goMapOrNull } from "../../lib/go-json.js";
import { InvalidTimeError, parseOptionalTime } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { logger } from "../../logger.js";
import type { AuditService } from "../audit/audit.service.js";
import { AutomationEvent, type AutomationEmitter } from "../automation/emitter.js";
import { and, appendScope, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import type { SystemActivityService } from "../system-activity/system-activity.service.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";
import type { ActivityType, ActivityTypesRepository } from "./activity-types.service.js";

export interface Activity {
  id: string;
  title: string;
  kind: string;
  typeId: string | null;
  typeName: string | null;
  typeColor: string | null;
  status: string;
  displayStatus: string;
  priority: string;
  notes: string;
  outcome: string;
  ownerUserId: string | null;
  ownerName: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  completedByUserId: string | null;
  completedByName: string | null;
  leadId: string | null;
  leadName: string | null;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  startAt: Date | null;
  endAt: Date | null;
  dueAt: Date | null;
  completedAt: Date | null;
  externalProvider: string;
  externalId: string;
  externalThreadId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CRMContext {
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  leadId: string | null;
  leadName: string | null;
  timelineHref: string;
}

export interface FollowUpIntel {
  lastActivityAt: Date | null;
  nextActivityAt: Date | null;
  daysSinceContact: number | null;
  overdueDurationHours: number | null;
  daysInStage: number | null;
  stageEnteredAt: Date | null;
  overdueCount: number;
  upcomingCount: number;
}

export interface CreateActivityInput {
  title: string;
  subject: string;
  kind: string;
  typeCode: string;
  body: string;
  notes: string;
  outcome: string;
  status: string;
  priority: string;
  ownerUserId?: string | undefined;
  leadId?: string | undefined;
  customerId?: string | undefined;
  dealId?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  dueAt?: string | undefined;
  externalProvider: string;
  externalId: string;
  externalThreadId: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface NextActivityInput {
  title: string;
  dueAt: string;
  typeCode: string;
}

export interface UpdateActivityInput {
  title?: string | undefined;
  kind?: string | undefined;
  typeCode?: string | undefined;
  notes?: string | undefined;
  outcome?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  ownerUserId?: string | undefined;
  leadId?: string | undefined;
  customerId?: string | undefined;
  dealId?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  dueAt?: string | undefined;
  clearDueAt: boolean;
  externalProvider?: string | undefined;
  externalId?: string | undefined;
  externalThreadId?: string | undefined;
  nextActivity?: NextActivityInput | undefined;
}

export interface FollowUpRequest {
  next: NextActivityInput;
  leadId?: string | null;
  customerId?: string | null;
  dealId?: string | null;
}

export interface ActivityListFilter {
  leadId: string;
  customerId: string;
  dealId: string;
  teamId: string;
  typeCode: string;
  pipelineId: string;
  status: string;
  /** Drops the automatic stage-change records, which have no time of their own. */
  hideStageChanges?: boolean;
  from: Date | null;
  to: Date | null;
  limit: number;
  offset: number;
  scope: Visibility;
}

/** Activity fields followed by the follow-up hint; nextActivityId is omitempty. */
export interface LeadStageRef {
  stageId: string;
  stageName: string;
}

export type MutationResult = Activity & {
  needsNextActivity: boolean;
  nextActivityId?: string;
  /** Set when completing the activity moved its lead forward. */
  leadMovedTo?: LeadStageRef;
};

/** Moves a lead forward after one of its activities is completed; null when it stays put. */
export type LeadAdvancer = (actorId: string, leadId: string, meta: RequestMeta) => Promise<LeadStageRef | null>;

export interface UpdateOptions {
  /** False when the caller decides the lead's stage itself, as the due-activity prompt does. */
  advanceLead?: boolean;
}

type ActivityRow = Omit<Activity, "displayStatus" | "metadata"> & { metadata: unknown };

const ACTIVITY_KEYS: (keyof Activity)[] = [
  "id", "title", "kind", "typeId", "typeName", "typeColor", "status", "displayStatus", "priority", "notes", "outcome",
  "ownerUserId", "ownerName", "createdByUserId", "createdByName", "completedByUserId", "completedByName", "leadId",
  "leadName", "customerId", "customerName", "dealId", "dealTitle", "pipelineId", "pipelineName", "startAt", "endAt",
  "dueAt", "completedAt", "externalProvider", "externalId", "externalThreadId", "metadata", "createdAt", "updatedAt",
];

const activitySelect = sql`
  SELECT a.id::text AS "id", COALESCE(NULLIF(a.title,''), a.subject) AS "title", a.kind,
    a.activity_type_id::text AS "typeId", t.name AS "typeName", t.color AS "typeColor",
    a.status, a.priority, a.body AS "notes", a.outcome,
    a.owner_user_id::text AS "ownerUserId", ou.full_name AS "ownerName",
    a.created_by_user_id::text AS "createdByUserId", cb.full_name AS "createdByName",
    a.completed_by_user_id::text AS "completedByUserId", cp.full_name AS "completedByName",
    a.lead_id::text AS "leadId", l.full_name AS "leadName",
    a.customer_id::text AS "customerId", c.full_name AS "customerName",
    a.deal_id::text AS "dealId", d.title AS "dealTitle",
    d.pipeline_id::text AS "pipelineId", p.name AS "pipelineName",
    a.start_at AS "startAt", a.end_at AS "endAt", a.due_at AS "dueAt", a.completed_at AS "completedAt",
    a.external_provider AS "externalProvider", a.external_id AS "externalId", a.external_thread_id AS "externalThreadId",
    a.metadata, a.created_at AS "createdAt", a.updated_at AS "updatedAt"
  FROM activities a
  LEFT JOIN activity_types t ON t.id = a.activity_type_id
  LEFT JOIN users ou ON ou.id = a.owner_user_id
  LEFT JOIN users cb ON cb.id = a.created_by_user_id
  LEFT JOIN users cp ON cp.id = a.completed_by_user_id
  LEFT JOIN leads l ON l.id = a.lead_id
  LEFT JOIN customers c ON c.id = a.customer_id
  LEFT JOIN deals d ON d.id = a.deal_id
  LEFT JOIN pipelines p ON p.id = d.pipeline_id`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stored status plus due date, as the UI shows it: past due is overdue, within 24h is due. */
export function resolveDisplayStatus(stored: string, due: Date | null, now = new Date()): string {
  if (stored === "completed" || stored === "cancelled") return stored;
  if (due === null) return stored === "due" ? "due" : "upcoming";
  if (due.getTime() < now.getTime()) return "overdue";
  if (due.getTime() - now.getTime() <= DAY_MS) return "due";
  return "upcoming";
}

function toActivity(r: ActivityRow): Activity {
  const a: Activity = {
    ...r,
    displayStatus: resolveDisplayStatus(r.status, r.dueAt),
    metadata: goMapOrNull(r.metadata),
  };
  return Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, a[k]])) as unknown as Activity;
}

const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v : null);

/** Whole days/hours since t, truncated like Go's int(time.Since(t).Hours()). */
const hoursSince = (t: Date) => Math.trunc((Date.now() - t.getTime()) / 3_600_000);
const daysSince = (t: Date) => Math.trunc((Date.now() - t.getTime()) / DAY_MS);

function statusForNew(due: Date | null, start: Date | null): string {
  const now = Date.now();
  if (due !== null && due.getTime() < now) return "overdue";
  if (due !== null && due.getTime() - now <= DAY_MS) return "due";
  if (due !== null || start !== null) return "upcoming";
  return "completed";
}

export class ActivitiesRepository {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Activity | null> {
    const r = await sql<ActivityRow>`${activitySelect} WHERE a.id=${id}`.execute(this.db);
    return r.rows[0] ? toActivity(r.rows[0]) : null;
  }

  async list(f: ActivityListFilter): Promise<{ items: Activity[]; total: number }> {
    const limit = f.limit <= 0 ? 100 : f.limit;
    let where: Predicate[] = [];
    if (f.leadId !== "") where.push(sql`a.lead_id::text = ${f.leadId}`);
    if (f.customerId !== "") where.push(sql`a.customer_id::text = ${f.customerId}`);
    if (f.dealId !== "") where.push(sql`a.deal_id::text = ${f.dealId}`);
    if (f.teamId !== "") {
      where.push(sql`EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = a.owner_user_id AND tm.team_id::text = ${f.teamId})`);
    }
    where = appendScope(where, f.scope, Records.Activities.columns);
    if (f.typeCode !== "") where.push(sql`a.kind = ${f.typeCode}`);
    if (f.pipelineId !== "") where.push(sql`COALESCE(d.pipeline_id, l.pipeline_id)::text = ${f.pipelineId}`);
    if (f.hideStageChanges) where.push(sql`a.kind <> 'stage_change'`);
    if (f.status !== "" && f.status !== "all") {
      if (f.status === "overdue") {
        where.push(sql`a.status IN ('upcoming','due','overdue') AND a.due_at IS NOT NULL AND a.due_at < NOW()`);
      } else if (f.status === "upcoming") {
        where.push(sql`a.status IN ('upcoming','due') AND (a.due_at IS NULL OR a.due_at >= NOW())`);
      } else {
        where.push(sql`a.status = ${f.status}`);
      }
    }
    if (f.from) where.push(sql`(COALESCE(a.start_at, a.due_at, a.created_at) >= ${f.from})`);
    if (f.to) where.push(sql`(COALESCE(a.start_at, a.due_at, a.created_at) < ${f.to})`);

    const count = await sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM activities a
      LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN deals d ON d.id = a.deal_id
      WHERE ${and(where)}`.execute(this.db);
    const rows = await sql<ActivityRow>`
      ${activitySelect} WHERE ${and(where)}
      ORDER BY COALESCE(a.start_at, a.due_at, a.created_at) ASC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return { items: rows.rows.map(toActivity), total: count.rows[0]?.total ?? 0 };
  }

  async create(
    actorId: string,
    in_: CreateActivityInput,
    typ: ActivityType,
    start: Date | null,
    end: Date | null,
    due: Date | null,
  ): Promise<Activity | null> {
    const id = randomUUID();
    const title = in_.title.trim() || in_.subject.trim() || typ.name;
    const notes = in_.notes || in_.body;
    let status = in_.status || statusForNew(due, start);
    if (status === "planned") status = "upcoming";
    const owner = blankToNull(in_.ownerUserId) ?? actorId;
    const completed = status === "completed";
    const [leadId, customerId, dealId] = [in_.leadId, in_.customerId, in_.dealId].map(blankToNull);
    await sql`
      INSERT INTO activities (
        id, kind, activity_type_id, title, subject, body, status, priority, outcome,
        due_at, start_at, end_at, completed_at,
        actor_user_id, owner_user_id, created_by_user_id, completed_by_user_id,
        lead_id, customer_id, deal_id,
        external_provider, external_id, external_thread_id, metadata
      ) VALUES (
        ${id}, ${typ.code}, ${typ.id}, ${title}, ${title}, ${notes}, ${status}, ${in_.priority || "medium"}, ${in_.outcome},
        ${due}, ${start}, ${end}, ${completed ? new Date() : null},
        ${actorId}, ${owner}, ${actorId}, ${completed ? actorId : null},
        ${leadId}, ${customerId}, ${dealId},
        ${in_.externalProvider}, ${in_.externalId}, ${in_.externalThreadId}, ${JSON.stringify(in_.metadata ?? {})}::jsonb
      )`.execute(this.db);
    await this.touchRelated(leadId ?? null, customerId ?? null, dealId ?? null, due, status);
    return this.get(id);
  }

  async update(
    actorId: string,
    cur: Activity,
    in_: UpdateActivityInput,
    typ: ActivityType | null,
    times: { start?: Date | null; end?: Date | null; due?: Date | null },
  ): Promise<Activity | null> {
    const pickRef = (v: string | undefined, fallback: string | null) => (v !== undefined ? blankToNull(v) : fallback);
    let status = cur.status;
    if (in_.status) status = in_.status === "planned" ? "upcoming" : in_.status;
    const lead = pickRef(in_.leadId, cur.leadId);
    const customer = pickRef(in_.customerId, cur.customerId);
    const deal = pickRef(in_.dealId, cur.dealId);
    const dueAt = "due" in times ? (times.due ?? null) : cur.dueAt;
    let completedAt = cur.completedAt;
    let completedBy = cur.completedByUserId;
    if (status === "completed" && cur.status !== "completed") {
      completedAt = new Date();
      completedBy = actorId;
    }
    const title = in_.title !== undefined ? in_.title.trim() : cur.title;
    const rescheduled = "start" in times || "due" in times;
    await sql`
      UPDATE activities SET
        prompt_snoozed_until = CASE WHEN ${rescheduled}::bool THEN NULL ELSE prompt_snoozed_until END,
        title=${title}, subject=${title}, kind=${typ ? typ.code : cur.kind}, activity_type_id=${typ ? typ.id : cur.typeId},
        body=${in_.notes ?? cur.notes}, outcome=${in_.outcome ?? cur.outcome},
        status=${status}, priority=${in_.priority || cur.priority}, owner_user_id=${pickRef(in_.ownerUserId, cur.ownerUserId)},
        lead_id=${lead}, customer_id=${customer}, deal_id=${deal},
        start_at=${"start" in times ? (times.start ?? null) : cur.startAt},
        end_at=${"end" in times ? (times.end ?? null) : cur.endAt},
        due_at=${dueAt},
        completed_at=${completedAt}, completed_by_user_id=${completedBy},
        external_provider=${in_.externalProvider ?? cur.externalProvider}, external_id=${in_.externalId ?? cur.externalId},
        external_thread_id=${in_.externalThreadId ?? cur.externalThreadId}
      WHERE id=${cur.id}`.execute(this.db);
    await this.touchRelated(lead, customer, deal, dueAt, status);
    return this.get(cur.id);
  }

  /** Refreshes last/next activity on linked records; failures are ignored like in Go. */
  private async touchRelated(
    lead: string | null,
    customer: string | null,
    deal: string | null,
    due: Date | null,
    status: string,
  ): Promise<void> {
    const ignore = () => undefined;
    const open = status === "upcoming" || status === "due" || status === "overdue";
    const closed = status === "completed" || status === "cancelled";
    if (lead !== null) {
      await sql`
        UPDATE leads SET
          status = CASE WHEN status = 'inbox' THEN 'open' ELSE status END,
          last_activity_at = CASE WHEN ${status}::text IN ('completed') THEN NOW() ELSE last_activity_at END,
          next_activity_at = CASE
            WHEN ${open}::bool AND ${due}::timestamptz IS NOT NULL THEN ${due}::timestamptz
            WHEN ${closed}::bool THEN (
              SELECT MIN(COALESCE(a.due_at, a.start_at))
              FROM activities a
              WHERE a.lead_id = ${lead}
                AND a.status IN ('upcoming', 'due', 'overdue')
            )
            ELSE next_activity_at
          END
        WHERE id=${lead}`.execute(this.db).catch(ignore);
    }
    if (customer !== null) {
      await sql`
        UPDATE customers SET
          last_contacted_at = CASE WHEN ${status}::text = 'completed' THEN NOW() ELSE last_contacted_at END,
          next_follow_up_at = CASE
            WHEN ${open}::bool AND ${due}::timestamptz IS NOT NULL THEN ${due}::timestamptz
            WHEN ${closed}::bool THEN (
              SELECT MIN(COALESCE(a.due_at, a.start_at))
              FROM activities a
              WHERE a.customer_id = ${customer}
                AND a.status IN ('upcoming', 'due', 'overdue')
            )
            ELSE next_follow_up_at
          END
        WHERE id=${customer}`.execute(this.db).catch(ignore);
    }
    if (deal !== null) {
      await sql`
        UPDATE deals SET
          last_activity_at = CASE WHEN ${status}::text = 'completed' THEN ${new Date()}::timestamptz ELSE last_activity_at END,
          next_activity_at = CASE
            WHEN ${open}::bool AND ${due}::timestamptz IS NOT NULL THEN ${due}::timestamptz
            WHEN ${closed}::bool THEN (
              SELECT MIN(COALESCE(a.due_at, a.start_at))
              FROM activities a
              WHERE a.deal_id = ${deal}
                AND a.status IN ('upcoming', 'due', 'overdue')
            )
            ELSE next_activity_at
          END
        WHERE id=${deal}`.execute(this.db).catch(ignore);
    }
  }

  async linkedNeedsNext(leadId: string | null, customerId: string | null, dealId: string | null): Promise<boolean> {
    const [lead, customer, deal] = [leadId ?? "", customerId ?? "", dealId ?? ""];
    const r = await sql<{ needs: boolean }>`
      SELECT
        COALESCE((
          SELECT l.status IN ('inbox','open','qualified')
            AND (l.next_activity_at IS NULL OR l.next_activity_at <= NOW())
          FROM leads l WHERE ${lead}::text <> '' AND l.id::text = ${lead}
        ), FALSE)
        OR COALESCE((
          SELECT NOT c.is_archived
            AND (c.next_follow_up_at IS NULL OR c.next_follow_up_at <= NOW())
          FROM customers c WHERE ${customer}::text <> '' AND c.id::text = ${customer}
        ), FALSE)
        OR COALESCE((
          SELECT d.status = 'open'
            AND (d.next_activity_at IS NULL OR d.next_activity_at <= NOW())
          FROM deals d WHERE ${deal}::text <> '' AND d.id::text = ${deal}
        ), FALSE) AS needs`.execute(this.db);
    return r.rows[0]?.needs === true;
  }

  async followUpIntel(leadId: string, customerId: string, dealId: string): Promise<FollowUpIntel> {
    const match = sql`(${leadId}::text='' OR lead_id::text=${leadId})
      AND (${customerId}::text='' OR customer_id::text=${customerId})
      AND (${dealId}::text='' OR deal_id::text=${dealId})`;
    const r = await sql<{ last: Date | null; next: Date | null }>`
      SELECT
        MAX(CASE WHEN status='completed' THEN COALESCE(completed_at, created_at) END) AS last,
        MIN(CASE WHEN status IN ('upcoming','due','overdue') THEN COALESCE(due_at, start_at) END) AS next
      FROM activities WHERE ${match}`.execute(this.db);
    const last = r.rows[0]?.last ?? null;
    const next = r.rows[0]?.next ?? null;
    const intel: FollowUpIntel = {
      lastActivityAt: last,
      nextActivityAt: next,
      daysSinceContact: last ? daysSince(last) : null,
      overdueDurationHours: null,
      daysInStage: null,
      stageEnteredAt: null,
      overdueCount: 0,
      upcomingCount: 0,
    };
    // Go discards errors from the secondary queries and keeps the zero values.
    const quiet = async <T>(fn: () => Promise<T>): Promise<T | undefined> => fn().catch(() => undefined);

    const counts = await quiet(() =>
      sql<{ overdue: number; upcoming: number }>`
        SELECT COUNT(*) FILTER (WHERE status IN ('upcoming','due','overdue') AND due_at < NOW()) AS overdue,
          COUNT(*) FILTER (WHERE status IN ('upcoming','due') AND (due_at IS NULL OR due_at >= NOW())) AS upcoming
        FROM activities WHERE ${match}`.execute(this.db),
    );
    if (counts?.rows[0]) {
      intel.overdueCount = counts.rows[0].overdue;
      intel.upcomingCount = counts.rows[0].upcoming;
    }

    const setStage = (entered: Date | null | undefined) => {
      if (!entered) return;
      intel.stageEnteredAt = entered;
      intel.daysInStage = daysSince(entered);
    };
    if (dealId !== "") {
      const s = await quiet(() =>
        sql<{ entered: Date | null }>`SELECT stage_entered_at AS entered FROM deals WHERE id=${dealId}`.execute(this.db),
      );
      setStage(s?.rows[0]?.entered);
    }
    if (customerId !== "" && intel.stageEnteredAt === null) {
      const s = await quiet(() =>
        sql<{ entered: Date | null }>`
          SELECT stage_entered_at AS entered FROM deals WHERE customer_id=${customerId} AND status='open'
          ORDER BY stage_entered_at DESC NULLS LAST LIMIT 1`.execute(this.db),
      );
      setStage(s?.rows[0]?.entered);
    }

    if (next !== null && next.getTime() < Date.now()) {
      intel.overdueDurationHours = hoursSince(next);
    } else if (intel.overdueCount > 0) {
      const o = await quiet(() =>
        sql<{ oldest: Date | null }>`
          SELECT MIN(due_at) AS oldest FROM activities
          WHERE status IN ('upcoming','due','overdue') AND due_at < NOW() AND ${match}`.execute(this.db),
      );
      const oldest = o?.rows[0]?.oldest;
      if (oldest) intel.overdueDurationHours = hoursSince(oldest);
    }
    return intel;
  }

  async userTimezone(userId: string): Promise<string> {
    const r = await sql<{ tz: string | null }>`SELECT timezone AS tz FROM users WHERE id=${userId}`.execute(this.db);
    const row = r.rows[0];
    if (!row || row.tz === null) throw new Error("no timezone");
    return row.tz === "" ? "Asia/Kathmandu" : row.tz;
  }

  async setUserTimezone(userId: string, tz: string): Promise<void> {
    await sql`UPDATE users SET timezone=${tz} WHERE id=${userId}`.execute(this.db);
  }
}

/**
 * Approximates Go's time.LoadLocation: IANA names (case-sensitive, aliases allowed), "UTC" and "Local".
 * ICU matches names case-insensitively and maps aliases to CLDR ids, so case is checked against the
 * resolved id when it is the same name, and otherwise by IANA's rule that every segment starts uppercase.
 * Offsets like "+05:45", which newer ICU accepts, are rejected as Go does.
 */
export function isValidTimezone(tz: string): boolean {
  if (tz === "UTC" || tz === "Local") return true;
  if (!/^[A-Z][A-Za-z0-9_+\-]*(\/[A-Z][A-Za-z0-9_+\-]*)*$/.test(tz)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return resolved.toLowerCase() !== tz.toLowerCase() || resolved === tz;
}

const VALID_STATUSES = ["upcoming", "due", "completed", "overdue", "cancelled", "planned"];

function parseTime(v: string | undefined, field: string): Date | null {
  try {
    return parseOptionalTime(v, { localMinute: true });
  } catch (err) {
    if (err instanceof InvalidTimeError) throw AppError.validation(`invalid ${field}`);
    throw err;
  }
}

const TIMELINE_BY_KIND: Record<string, [string, string]> = {
  call: [TimelineEvent.Call, "Call"],
  whatsapp: [TimelineEvent.WhatsApp, "WhatsApp message"],
  email: [TimelineEvent.Email, "Email"],
  meeting: [TimelineEvent.Meeting, "Meeting"],
  note: [TimelineEvent.Note, "Note"],
  stage_change: [TimelineEvent.StageChange, "Stage change"],
  assignment: [TimelineEvent.AssignmentChange, "Assignment change"],
};

export class ActivitiesService {
  readonly repo: ActivitiesRepository;

  constructor(
    db: Database,
    private readonly types: ActivityTypesRepository,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    private readonly hooks: AutomationEmitter,
    private readonly sysActivity: SystemActivityService,
  ) {
    this.repo = new ActivitiesRepository(db);
  }

  private leadAdvancer: LeadAdvancer | null = null;

  setLeadAdvancer(advancer: LeadAdvancer): void {
    this.leadAdvancer = advancer;
  }

  async get(id: string): Promise<{ activity: Activity; context: CRMContext }> {
    const a = await internal("failed to load activity", () => this.repo.get(id));
    if (!a) throw AppError.notFound("activity not found");
    const timelineHref = a.leadId !== null ? `/leads?leadId=${a.leadId}` : "";
    return {
      activity: a,
      context: {
        customerId: a.customerId,
        customerName: a.customerName,
        dealId: a.dealId,
        dealTitle: a.dealTitle,
        leadId: a.leadId,
        leadName: a.leadName,
        timelineHref,
      },
    };
  }

  async list(f: ActivityListFilter): Promise<{ items: Activity[]; total: number }> {
    return internal("failed to list activities", () => this.repo.list(f));
  }

  async create(actorId: string, in_: CreateActivityInput, meta: RequestMeta): Promise<Activity & { leadMovedTo?: LeadStageRef }> {
    const code = in_.typeCode.trim() || in_.kind.trim();
    if (code === "") throw AppError.validation("activity type is required");
    const typ = await internal("failed to resolve activity type", () => this.types.byCode(code));
    if (!typ || !typ.isActive) throw AppError.validation("unknown or inactive activity type");
    if ([in_.leadId, in_.customerId, in_.dealId].every((v) => blankToNull(v) === null)) {
      throw AppError.validation("activity must belong to a lead, customer, or deal");
    }
    const start = parseTime(in_.startAt, "startAt");
    const end = parseTime(in_.endAt, "endAt");
    const due = parseTime(in_.dueAt, "dueAt");
    if (in_.status !== "" && !VALID_STATUSES.includes(in_.status)) throw AppError.validation("invalid status");

    const a = await internal("failed to create activity", async () => {
      const row = await this.repo.create(actorId, in_, typ, start, end, due);
      if (!row) throw new Error("created activity not found");
      return row;
    });
    await this.audit.record(actorId, "activity.created", "activity", a.id, { type: a.kind, title: a.title, status: a.status }, meta);
    await this.sysActivity.record({
      eventType: "activity.created",
      title: "Activity created",
      actorUserId: actorId,
      entityType: "activity",
      entityId: a.id,
      entityLabel: a.title,
      metadata: { kind: a.kind, status: a.status },
    });
    await this.emitTimeline(actorId, a, false);
    const leadMovedTo = a.status === "completed" ? await this.advanceLead(actorId, a, meta) : null;
    return leadMovedTo ? { ...a, leadMovedTo } : a;
  }

  /** A refused or failed move never fails the activity write. */
  private async advanceLead(actorId: string, a: Activity, meta: RequestMeta): Promise<LeadStageRef | null> {
    const leadId = a.leadId;
    if (leadId === null || !this.leadAdvancer) return null;
    return this.leadAdvancer(actorId, leadId, meta).catch((err: unknown) => {
      logger.warn({ activity: a.id, lead: leadId, error: err instanceof Error ? err.message : String(err) }, "lead advance after completion failed");
      return null;
    });
  }

  async update(
    actorId: string,
    id: string,
    in_: UpdateActivityInput,
    meta: RequestMeta,
    opts: UpdateOptions = {},
  ): Promise<MutationResult> {
    const cur = await internal("failed to load activity", () => this.repo.get(id));
    if (!cur) throw AppError.notFound("activity not found");
    let typ: ActivityType | null = null;
    const code = (in_.typeCode !== undefined ? in_.typeCode : (in_.kind ?? "")).trim();
    if (code !== "") {
      typ = await internal("failed to resolve activity type", () => this.types.byCode(code));
      if (!typ) throw AppError.validation("unknown activity type");
    }
    const times: { start?: Date | null; end?: Date | null; due?: Date | null } = {};
    if (in_.startAt !== undefined) times.start = parseTime(in_.startAt, "startAt");
    if (in_.endAt !== undefined) times.end = parseTime(in_.endAt, "endAt");
    if (in_.clearDueAt) times.due = null;
    else if (in_.dueAt !== undefined) times.due = parseTime(in_.dueAt, "dueAt");

    const a = await internal("failed to update activity", async () => {
      const row = await this.repo.update(actorId, cur, in_, typ, times);
      if (!row) throw new Error("updated activity not found");
      return row;
    });
    await this.audit.record(actorId, "activity.updated", "activity", id, { status: a.status, title: a.title }, meta);
    const completing = cur.status !== "completed" && a.status === "completed";
    if (completing) {
      await this.emitTimeline(actorId, a, true);
      await this.hooks.emit(AutomationEvent.ActivityCompleted, "activity", a.id, {
        title: a.title,
        kind: a.kind,
        leadId: a.leadId,
        dealId: a.dealId,
        customerId: a.customerId,
      });
    }
    const leadMovedTo = completing && opts.advanceLead !== false ? await this.advanceLead(actorId, a, meta) : null;
    let nextActivityId: string | undefined;
    if (completing && in_.nextActivity && in_.nextActivity.dueAt.trim() !== "") {
      nextActivityId = await this.scheduleFollowUp(
        actorId,
        { next: in_.nextActivity, leadId: a.leadId, customerId: a.customerId, dealId: a.dealId },
        meta,
      ).catch(() => undefined);
    }
    const needs = completing
      ? await this.repo.linkedNeedsNext(a.leadId, a.customerId, a.dealId).catch(() => false)
      : false;
    return {
      ...a,
      needsNextActivity: needs,
      ...(nextActivityId !== undefined ? { nextActivityId } : {}),
      ...(leadMovedTo ? { leadMovedTo } : {}),
    };
  }

  async followUp(leadId: string, customerId: string, dealId: string): Promise<FollowUpIntel> {
    if (leadId === "" && customerId === "" && dealId === "") {
      throw AppError.validation("leadId, customerId, or dealId is required");
    }
    return internal("failed to load follow-up intelligence", () => this.repo.followUpIntel(leadId, customerId, dealId));
  }

  async getTimezone(userId: string): Promise<string> {
    return this.repo.userTimezone(userId).catch(() => "Asia/Kathmandu");
  }

  async setTimezone(userId: string, raw: string): Promise<void> {
    const tz = raw.trim();
    if (tz === "") throw AppError.validation("timezone is required");
    if (!isValidTimezone(tz)) throw AppError.validation("invalid IANA timezone");
    await internal("failed to update timezone", () => this.repo.setUserTimezone(userId, tz));
  }

  /** Creates the next follow-up for a completed activity or a deal move; returns its id. */
  async scheduleFollowUp(actorId: string, in_: FollowUpRequest, meta: RequestMeta): Promise<string> {
    const due = in_.next.dueAt.trim();
    if (due === "") throw AppError.validation("dueAt is required");
    const a = await this.create(
      actorId,
      {
        title: in_.next.title.trim() || "Follow up",
        subject: "",
        kind: "",
        typeCode: in_.next.typeCode.trim() || "follow_up",
        body: "",
        notes: "",
        outcome: "",
        status: "upcoming",
        priority: "",
        dueAt: due,
        leadId: in_.leadId ?? undefined,
        customerId: in_.customerId ?? undefined,
        dealId: in_.dealId ?? undefined,
        externalProvider: "",
        externalId: "",
        externalThreadId: "",
      },
      meta,
    );
    return a.id;
  }

  private async emitTimeline(actorId: string, a: Activity, completed: boolean): Promise<void> {
    let [eventType, title] = completed
      ? [TimelineEvent.ActivityCompleted as string, "Activity completed"]
      : (TIMELINE_BY_KIND[a.kind] ?? [TimelineEvent.ActivityCreated as string, "Activity created"]);
    const refs = { leadId: a.leadId, customerId: a.customerId, dealId: a.dealId, activityId: a.id };
    await this.timeline.record({
      eventType,
      title,
      body: a.title,
      actorUserId: actorId,
      source: "crm",
      ...refs,
      metadata: { kind: a.kind, status: a.status },
    });
    if (!completed && a.status === "completed" && eventType !== TimelineEvent.ActivityCompleted) {
      [eventType, title] = [TimelineEvent.ActivityCompleted, "Activity completed"];
      await this.timeline.record({ eventType, title, body: a.title, actorUserId: actorId, source: "crm", ...refs });
    }
  }
}
