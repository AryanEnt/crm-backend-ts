import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { InvalidTimeError, parseDateOnly, parseOptionalTime } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { AttentionSql, computeAttention, validAttention } from "../attention/attention.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import type { AutomationEmitter } from "../automation/emitter.js";
import { AutomationEvent } from "../automation/emitter.js";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service.js";
import { and, appendScope, effectiveScope, resolve, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P, Role } from "../permissions/permissions.js";
import type { Stage } from "../pipelines/pipelines.service.js";
import { isReferralSource, validateReferral, type ReferralInput, type ReferralsService } from "../referrals/referrals.service.js";
import type { SystemActivityService } from "../system-activity/system-activity.service.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";
import type { FollowUpScheduler } from "./lead-stage.service.js";
import { leadActivityPredicate, leadValuePredicates, type LeadStageService } from "./lead-stage.service.js";
import {
  contactRemarksProblem,
  isContactedStage,
  parseContactRating,
} from "./contact-rating.js";
import { nextFollowUpRemarksProblem, requiresNextFollowUpRemarks } from "./next-follow-up-remarks.js";
import {
  enqueuePhoneValidation,
  PhoneValidationService,
} from "./phone-validation.service.js";
import type { PhoneValidationStatus } from "./phone-validation.js";

export interface BulkStageResult {
  updated: number;
  failed: { id: string; error: string }[];
}

export interface Lead {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string;
  nationality: string;
  location: string;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  source: string;
  priority: string;
  tags: string[];
  anzscoId: string | null;
  anzscoCode: string | null;
  anzscoTitle: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  stageAccent: string | null;
  notes: string;
  occupation: string;
  jobTitle: string;
  employer: string;
  experienceYears: number | null;
  qualification: string;
  skills: string[];
  potentialValue: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: string | null;
  expectedOutcome: string;
  lastActivityAt: Date | null;
  nextActivityAt: Date | null;
  status: string;
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string;
  /** Negotiation-stage category (empty when unset). */
  negotiationTag: string;
  /** Free-text note when negotiationTag is "Others". */
  negotiationRemarks: string;
  /** Contacted-stage star rating (1–5); null until set. Locked after leaving Contacted. */
  contactRating: number | null;
  contactRemarks: string;
  contactRatedAt: Date | null;
  contactRatedBy: string | null;
  contactRatedByName: string | null;
  /** Next follow-up plan; required on Contacted → Lost. */
  nextFollowUpRemarks: string;
  /** Latest overdue document-delay remark (Nurturing). */
  documentDelayRemarks: string;
  documentDelayRemarksAt: Date | null;
  documentDelayRemarksBy: string | null;
  documentDelayRemarksByName: string | null;
  stageEnteredAt: Date | null;
  daysInStage: number;
  convertedCustomerId: string | null;
  convertedAt: Date | null;
  isArchived: boolean;
  archivedAt: Date | null;
  ageDays: number;
  attention: string;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  phoneCountryCode: string;
  phoneValidationStatus: PhoneValidationStatus;
  phoneNormalized: string | null;
  phoneValidationMessage: string;
  /** Duplicate lead IDs the caller is allowed to see (redacted in attachVisibleDuplicates). */
  phoneDuplicateLeadIds: string[];
  phoneDuplicateLeads: { id: string; fullName: string }[];
  phoneValidatedAt: Date | null;
  phoneLastNotifiedAt: Date | null;
  phoneValidationVersion: number;
}

export interface CreateLeadInput {
  fullName: string;
  email?: string | undefined;
  phone?: string | undefined;
  country: string;
  nationality: string;
  location: string;
  ownerUserId?: string | undefined;
  teamId?: string | undefined;
  source: string;
  priority: string;
  tags?: string[] | undefined;
  anzscoId?: string | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  notes: string;
  occupation: string;
  jobTitle: string;
  employer: string;
  experienceYears?: number | undefined;
  qualification: string;
  skills?: string[] | undefined;
  potentialValue?: number | undefined;
  currency?: string | undefined;
  expectedCloseAt?: string | undefined;
  expectedOutcome: string;
  nextActivityAt?: string | undefined;
  forceCreate: boolean;
  /** ISO 3166-1 alpha-2 used as the default region for phone parsing. */
  phoneCountryCode?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
  referral?: ReferralInput | undefined;
}

export interface UpdateLeadInput {
  fullName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  country?: string | undefined;
  nationality?: string | undefined;
  location?: string | undefined;
  ownerUserId?: string | undefined;
  teamId?: string | undefined;
  source?: string | undefined;
  priority?: string | undefined;
  tags?: string[] | undefined;
  anzscoId?: string | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  notes?: string | undefined;
  occupation?: string | undefined;
  jobTitle?: string | undefined;
  employer?: string | undefined;
  experienceYears?: number | undefined;
  qualification?: string | undefined;
  skills?: string[] | undefined;
  potentialValue?: number | undefined;
  clearValue?: boolean | undefined;
  currency?: string | undefined;
  expectedCloseAt?: string | undefined;
  clearCloseDate?: boolean | undefined;
  expectedOutcome?: string | undefined;
  nextActivityAt?: string | undefined;
  status?: string | undefined;
  /** Used when the PATCH moves the lead into a lost stage. */
  lostReason?: string | undefined;
  negotiationTag?: string | undefined;
  negotiationRemarks?: string | undefined;
  contactRating?: number | undefined;
  contactRemarks?: string | undefined;
  nextFollowUpRemarks?: string | undefined;
  /** Set by LeadsService when saving a Contacted rating. */
  contactRatedBy?: string | null | undefined;
  /** Skips stage requirements when the PATCH moves the lead. */
  forceStage?: boolean | undefined;
  /** Allows the PATCH to move a Won or Lost lead. */
  reopen?: boolean | undefined;
  forceUpdate: boolean;
  phoneCountryCode?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
  referral?: ReferralInput | undefined;
}

export interface LeadListFilter {
  search: string;
  ownerUserId: string;
  teamId: string;
  pipelineId: string;
  stageId: string;
  source: string;
  priority: string;
  anzscoId: string;
  tag: string;
  /** Exact country name; "(Unknown)" matches blank country. */
  country: string;
  createdFrom: string;
  createdTo: string;
  /** Won or lost on/after this instant (ISO timestamp). */
  closedFrom?: string;
  /** Won or lost before this instant (ISO timestamp, exclusive). */
  closedTo?: string;
  inactiveDays: number;
  includeArchived: boolean;
  status: string;
  attention: string;
  /** overdue | today | week | none | scheduled */
  activity?: string;
  minValue?: number | null;
  maxValue?: number | null;
  sort: string;
  order: string;
  limit: number;
  offset: number;
  scope: Visibility;
}

export interface DuplicateMatch {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  entity: "lead" | "customer";
  reason: string;
}

/** Limits duplicate matching to rows the caller can see; a null entry skips that table. */
export interface DuplicateScope {
  leads: Visibility | null;
  customers: Visibility | null;
}

/** Go CreateResult: `lead` and `duplicates` are omitempty. */
export type LeadWriteResult = { lead: Lead } | { duplicates: DuplicateMatch[]; needsReview: true };

export interface BulkAssignInput {
  ids?: string[] | undefined;
  ownerUserId?: string | undefined;
  teamId?: string | undefined;
}

export interface BulkStageInput {
  ids?: string[] | undefined;
  pipelineId: string;
  stageId: string;
}

type LeadRow = Omit<Lead, "attention" | "tags" | "skills" | "phoneDuplicateLeadIds" | "phoneDuplicateLeads"> & {
  tags: string[] | null;
  skills: string[] | null;
  slaHours: number | null;
  phoneDuplicateLeadIds: string[] | null;
};

const leadSelect = sql`
  SELECT l.id::text AS "id", l.full_name AS "fullName", l.email, l.phone, l.country, l.nationality, l.location,
    l.owner_user_id::text AS "ownerUserId", ou.full_name AS "ownerName", l.team_id::text AS "teamId", t.name AS "teamName",
    l.source, l.priority, l.tags, l.anzsco_id::text AS "anzscoId", a.code AS "anzscoCode", a.title AS "anzscoTitle",
    l.pipeline_id::text AS "pipelineId", p.name AS "pipelineName", l.stage_id::text AS "stageId", ps.name AS "stageName",
    ps.visual_accent AS "stageAccent",
    l.notes, l.occupation, l.job_title AS "jobTitle", l.employer, l.experience_years AS "experienceYears",
    l.qualification, l.skills, l.potential_value AS "potentialValue", l.currency,
    COALESCE(l.probability, ps.probability) AS "probability",
    CASE WHEN l.expected_close_at IS NULL THEN NULL ELSE to_char(l.expected_close_at, 'YYYY-MM-DD') END AS "expectedCloseAt",
    l.expected_outcome AS "expectedOutcome",
    l.last_activity_at AS "lastActivityAt", l.next_activity_at AS "nextActivityAt",
    l.status, l.won_at AS "wonAt", l.lost_at AS "lostAt", l.lost_reason AS "lostReason",
    COALESCE(l.negotiation_tag, '') AS "negotiationTag",
    COALESCE(l.negotiation_remarks, '') AS "negotiationRemarks",
    l.contact_rating AS "contactRating",
    COALESCE(l.contact_remarks, '') AS "contactRemarks",
    COALESCE(l.next_follow_up_remarks, '') AS "nextFollowUpRemarks",
    l.contact_rated_at AS "contactRatedAt",
    l.contact_rated_by::text AS "contactRatedBy",
    cr.full_name AS "contactRatedByName",
    COALESCE(l.document_delay_remarks, '') AS "documentDelayRemarks",
    l.document_delay_remarks_at AS "documentDelayRemarksAt",
    l.document_delay_remarks_by::text AS "documentDelayRemarksBy",
    dr.full_name AS "documentDelayRemarksByName",
    l.stage_entered_at AS "stageEnteredAt",
    GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(l.stage_entered_at, l.created_at))::int) AS "daysInStage",
    l.converted_customer_id::text AS "convertedCustomerId", l.converted_at AS "convertedAt",
    l.is_archived AS "isArchived", l.archived_at AS "archivedAt",
    GREATEST(0, EXTRACT(DAY FROM NOW() - l.created_at)::int) AS "ageDays",
    l.created_at AS "createdAt", l.updated_at AS "updatedAt", ps.sla_hours AS "slaHours",
    l.created_by_user_id::text AS "createdByUserId",
    COALESCE(l.phone_country_code, '') AS "phoneCountryCode",
    COALESCE(l.phone_validation_status, 'pending') AS "phoneValidationStatus",
    l.phone_normalized AS "phoneNormalized",
    COALESCE(l.phone_validation_message, '') AS "phoneValidationMessage",
    COALESCE(l.phone_duplicate_lead_ids, '{}'::uuid[])::text[] AS "phoneDuplicateLeadIds",
    l.phone_validated_at AS "phoneValidatedAt",
    l.phone_last_notified_at AS "phoneLastNotifiedAt",
    COALESCE(l.phone_validation_version, 0) AS "phoneValidationVersion"
  FROM leads l
  LEFT JOIN users ou ON ou.id = l.owner_user_id
  LEFT JOIN users cr ON cr.id = l.contact_rated_by
  LEFT JOIN users dr ON dr.id = l.document_delay_remarks_by
  LEFT JOIN teams t ON t.id = l.team_id
  LEFT JOIN anzsco_occupations a ON a.id = l.anzsco_id
  LEFT JOIN pipelines p ON p.id = l.pipeline_id
  LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id`;

function toLead(r: LeadRow): Lead {
  const attention = computeAttention({
    closed: r.isArchived || CLOSED_LEAD_STATUSES.has(r.status),
    next: r.nextActivityAt,
    last: r.lastActivityAt,
    anchor: r.stageEnteredAt ?? r.updatedAt,
    createdAt: r.createdAt,
    slaHours: r.slaHours,
  });
  const ids = (r.phoneDuplicateLeadIds ?? []).map(String);
  return orderLead({
    ...r,
    tags: r.tags ?? [],
    skills: r.skills ?? [],
    attention,
    phoneDuplicateLeadIds: ids,
    phoneDuplicateLeads: [],
    phoneValidationStatus: (r.phoneValidationStatus || "pending") as PhoneValidationStatus,
    phoneValidationVersion: Number(r.phoneValidationVersion ?? 0),
  });
}

/** Go struct field order. */
const LEAD_KEYS: (keyof Lead)[] = [
  "id", "fullName", "email", "phone", "country", "nationality", "location", "ownerUserId", "ownerName", "teamId",
  "teamName", "source", "priority", "tags", "anzscoId", "anzscoCode", "anzscoTitle", "pipelineId", "pipelineName",
  "stageId", "stageName", "stageAccent", "notes", "occupation", "jobTitle", "employer", "experienceYears", "qualification",
  "skills", "potentialValue", "currency", "probability", "expectedCloseAt", "expectedOutcome", "lastActivityAt",
  "nextActivityAt", "status", "wonAt", "lostAt", "lostReason", "negotiationTag", "negotiationRemarks",
  "contactRating", "contactRemarks", "contactRatedAt", "contactRatedBy", "contactRatedByName",
  "nextFollowUpRemarks",
  "documentDelayRemarks", "documentDelayRemarksAt", "documentDelayRemarksBy", "documentDelayRemarksByName",
  "stageEnteredAt", "daysInStage", "convertedCustomerId",
  "convertedAt", "isArchived", "archivedAt", "ageDays", "attention", "createdAt", "updatedAt",
  "createdByUserId", "phoneCountryCode", "phoneValidationStatus", "phoneNormalized", "phoneValidationMessage",
  "phoneDuplicateLeadIds", "phoneDuplicateLeads", "phoneValidatedAt", "phoneLastNotifiedAt", "phoneValidationVersion",
];

function orderLead(l: Lead & { slaHours?: unknown }): Lead {
  return Object.fromEntries(LEAD_KEYS.map((k) => [k, l[k]])) as unknown as Lead;
}

/** Allowed Negotiation-stage tags on the Leads Pipeline board. */
export const NEGOTIATION_TAGS = [
  "Budget Concern",
  "Payment Scheduled",
  "Gone Quiet",
  "Follow-up Scheduled",
  "Others",
] as const;
export type NegotiationTag = (typeof NEGOTIATION_TAGS)[number];
const NEGOTIATION_TAG_SET = new Set<string>(NEGOTIATION_TAGS);

/** Statuses with no further sales work; attention flags are not computed for them. */
const CLOSED_LEAD_STATUSES = new Set(["won", "lost", "converted", "archived", "unqualified"]);
const VALID_STATUSES = new Set([
  "", "all", "working", "inbox", "open", "qualified", "won", "lost", "closed", "converted", "unqualified", "archived",
]);
/** Outcome statuses only the stage service may set. */
const MOVE_ONLY_STATUSES = new Set(["won", "lost", "converted"]);

/** Keeps non-organization callers from handing leads to people or teams outside their scope. */
export function assignTargetInScope(claims: Claims, ownerUserId: string, teamId: string): void {
  const scope = effectiveScope(claims, P.LeadsAssign);
  if (scope === "organization") return;
  if (
    ownerUserId !== "" &&
    ownerUserId !== claims.userId &&
    (scope !== "team" || !claims.teamMemberUserIds.includes(ownerUserId))
  ) {
    throw AppError.forbidden("You can only assign leads to people on your team");
  }
  if (teamId !== "" && !claims.teamIds.includes(teamId)) {
    throw AppError.forbidden("You can only assign leads to your own team");
  }
}

/** Go's time.Parse("2006-01-02") on the trimmed value. */
function parseCloseDate(v: string): string {
  const s = v.trim();
  if (!parseDateOnly(s)) throw AppError.validation("invalid expectedCloseAt");
  return s;
}
const VALID_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

export const normalizeEmail = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const s = v.trim().toLowerCase();
  return s === "" ? null : s;
};

export const normalizePhone = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const s = v.trim();
  return s === "" ? null : s;
};

/** Go nullIfEmpty: blank -> NULL, otherwise the value as given (untrimmed). */
export const nullIfBlank = (v: string | null | undefined): string | null =>
  v === undefined || v === null || v.trim() === "" ? null : v;

const changed = (a: string | null, b: string | null) => a !== b;

function nextActivity(v: string | undefined): Date | null {
  try {
    return parseOptionalTime(v);
  } catch (err) {
    if (err instanceof InvalidTimeError) throw AppError.validation("invalid nextActivityAt");
    throw err;
  }
}

/** Duplicate matches restricted to the leads and customers the caller can view. */
export function duplicateScopeFor(claims: Claims): DuplicateScope {
  const tryResolve = (perm: string) => {
    try {
      return resolve(claims, perm);
    } catch {
      return null;
    }
  };
  return { leads: tryResolve(P.LeadsView), customers: tryResolve(P.CustomersView) };
}

export class LeadsRepository {
  constructor(readonly db: Database) {}

  async get(id: string): Promise<Lead | null> {
    const r = await sql<LeadRow>`${leadSelect} WHERE l.id = ${id}`.execute(this.db);
    return r.rows[0] ? toLead(r.rows[0]) : null;
  }

  async setStatus(id: string, status: string): Promise<Lead | null> {
    const r = await sql`UPDATE leads SET status=${status} WHERE id=${id}`.execute(this.db);
    if ((r.numAffectedRows ?? 0n) === 0n) return null;
    return this.get(id);
  }

  /** Shared list predicates. Pass `includeCountry: false` for country facet counts. */
  private listWhere(f: LeadListFilter, opts: { includeCountry?: boolean } = {}): Predicate[] {
    const includeCountry = opts.includeCountry !== false;
    // Same search fields as the board, so Won/Lost tables and board counts agree.
    const search = f.search.trim();
    let where: Predicate[] = [
      sql`(${search} = '' OR l.full_name ILIKE '%' || ${search} || '%' OR COALESCE(l.email,'') ILIKE '%' || ${search} || '%' OR COALESCE(l.phone,'') ILIKE '%' || ${search} || '%' OR l.employer ILIKE '%' || ${search} || '%')`,
    ];
    if (!f.includeArchived) where.push(sql`l.is_archived = FALSE`);
    switch (f.status) {
      case "":
        // New leads start in inbox; the default table shows them with open and qualified work.
        where.push(
          f.includeArchived
            ? sql`l.status IN ('inbox','open','qualified','archived')`
            : sql`l.status IN ('inbox','open','qualified')`,
        );
        break;
      case "working":
        where.push(f.includeArchived ? sql`l.status IN ('open','qualified','archived')` : sql`l.status IN ('open','qualified')`);
        break;
      case "all":
        break;
      case "closed":
        // Timestamps survive the Sales → Nurturing handoff (status becomes open again).
        where.push(sql`(l.won_at IS NOT NULL OR l.lost_at IS NOT NULL)`);
        break;
      case "won":
        where.push(sql`l.won_at IS NOT NULL`);
        break;
      case "lost":
        where.push(sql`l.lost_at IS NOT NULL`);
        break;
      case "inbox":
      case "open":
      case "qualified":
      case "converted":
      case "unqualified":
      case "archived":
        where.push(sql`l.status = ${f.status}`);
        break;
      default:
        where.push(sql`FALSE`);
    }
    if (f.attention !== "") where.push(sql`(${sql.raw(AttentionSql.lead)}) = ${f.attention}`);
    const activity = leadActivityPredicate(f.activity ?? "");
    if (activity) where.push(activity);
    if (f.ownerUserId !== "") where.push(sql`l.owner_user_id::text = ${f.ownerUserId}`);
    if (f.teamId !== "") where.push(sql`l.team_id::text = ${f.teamId}`);
    if (f.pipelineId !== "") where.push(sql`l.pipeline_id::text = ${f.pipelineId}`);
    if (f.stageId !== "") where.push(sql`l.stage_id::text = ${f.stageId}`);
    if (f.source !== "") where.push(sql`l.source = ${f.source}`);
    if (f.priority !== "") where.push(sql`l.priority = ${f.priority}`);
    if (f.anzscoId !== "") where.push(sql`l.anzsco_id::text = ${f.anzscoId}`);
    if (f.tag !== "") where.push(sql`${f.tag} = ANY(l.tags)`);
    if (includeCountry && f.country !== "") {
      if (f.country === "(Unknown)" || f.country === "(none)") {
        where.push(sql`TRIM(l.country) = ''`);
      } else {
        where.push(sql`l.country = ${f.country}`);
      }
    }
    where.push(...leadValuePredicates(f.minValue, f.maxValue));
    if (f.createdFrom !== "") where.push(sql`l.created_at >= ${f.createdFrom}::timestamptz`);
    if (f.createdTo !== "") where.push(sql`l.created_at < (${f.createdTo}::date + INTERVAL '1 day')`);
    if (f.closedFrom) where.push(sql`COALESCE(l.won_at, l.lost_at) >= ${f.closedFrom}::timestamptz`);
    if (f.closedTo) where.push(sql`COALESCE(l.won_at, l.lost_at) < ${f.closedTo}::timestamptz`);
    if (f.inactiveDays > 0) {
      where.push(sql`(l.last_activity_at IS NULL OR l.last_activity_at < NOW() - ${f.inactiveDays}::int * INTERVAL '1 day')`);
    }
    return appendScope(where, f.scope, Records.Leads.columns);
  }

  async list(f: LeadListFilter): Promise<{ items: Lead[]; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 25 : f.limit;
    const offset = Math.max(0, f.offset);
    const where = this.listWhere(f);

    const count = await sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM leads l LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id WHERE ${and(where)}`.execute(this.db);

    const sortCols: Record<string, string> = {
      name: "l.full_name",
      created: "l.created_at",
      priority: "l.priority",
      value: "l.potential_value",
      closed: "COALESCE(l.won_at, l.lost_at)",
      lastActivity: "l.last_activity_at",
      nextActivity: "l.next_activity_at",
      age: "l.created_at",
    };
    const sortCol = Object.hasOwn(sortCols, f.sort) ? sortCols[f.sort]! : "l.created_at";
    let order = f.order.toLowerCase() === "asc" ? "ASC" : "DESC";
    if (f.sort === "age") order = order === "DESC" ? "ASC" : "DESC";

    const rows = await sql<LeadRow>`
      ${leadSelect} WHERE ${and(where)}
      ORDER BY ${sql.raw(`${sortCol} ${order}`)} NULLS LAST LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: rows.rows.map(toLead), total: count.rows[0]?.total ?? 0 };
  }

  /** Distinct residence countries for the caller's scoped, filtered lead set (country filter excluded). */
  async listCountries(f: LeadListFilter): Promise<{ country: string; count: number }[]> {
    const where = this.listWhere(f, { includeCountry: false });
    const rows = await sql<{ country: string; count: number }>`
      SELECT
        CASE WHEN TRIM(COALESCE(l.country, '')) = '' THEN '(Unknown)' ELSE TRIM(l.country) END AS country,
        COUNT(*)::int AS count
      FROM leads l
      LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
      WHERE ${and(where)}
      GROUP BY 1
      ORDER BY count DESC, country ASC`.execute(this.db);
    return rows.rows.map((r) => ({ country: r.country, count: Number(r.count) }));
  }

  async create(
    in_: CreateLeadInput,
    nextAt: Date | null,
    placement: { probability: number | null; closeDate: string | null },
    createdByUserId: string,
  ): Promise<Lead | null> {
    const id = randomUUID();
    const phoneCode = (in_.phoneCountryCode ?? "").trim().toUpperCase();
    await sql`
      INSERT INTO leads (
        id, full_name, email, phone, country, nationality, location,
        owner_user_id, team_id, source, priority, tags, anzsco_id,
        pipeline_id, stage_id, notes, occupation, job_title, employer,
        experience_years, qualification, skills, potential_value, currency, probability, expected_close_at,
        expected_outcome, next_activity_at, last_activity_at, status, stage_entered_at,
        created_by_user_id, phone_country_code, phone_validation_status, phone_validation_message
      ) VALUES (
        ${id}, ${in_.fullName.trim()}, ${normalizeEmail(in_.email)}, ${normalizePhone(in_.phone)},
        ${in_.country}, ${in_.nationality}, ${in_.location},
        ${nullIfBlank(in_.ownerUserId)}, ${nullIfBlank(in_.teamId)}, ${in_.source}, ${in_.priority || "medium"},
        ${in_.tags ?? []}::text[], ${nullIfBlank(in_.anzscoId)},
        ${nullIfBlank(in_.pipelineId)}, ${nullIfBlank(in_.stageId)}, ${in_.notes}, ${in_.occupation}, ${in_.jobTitle}, ${in_.employer},
        ${in_.experienceYears ?? null}, ${in_.qualification}, ${in_.skills ?? []}::text[], ${in_.potentialValue ?? null},
        ${in_.currency?.trim() || "AUD"}, ${placement.probability}, ${placement.closeDate}::date,
        ${in_.expectedOutcome}, ${nextAt}, NOW(), 'open', NOW(),
        ${createdByUserId}::uuid, ${phoneCode},
        ${normalizePhone(in_.phone) ? "pending" : "valid"},
        ${normalizePhone(in_.phone) ? "Queued for validation" : ""}
      )`.execute(this.db);
    return this.get(id);
  }

  async visibleLeadSummaries(
    ids: string[],
    scope: Visibility | null,
  ): Promise<{ id: string; fullName: string }[]> {
    if (ids.length === 0 || !scope) return [];
    const rec = Records.Leads;
    const where = appendScope([sql`l.id = ANY(${ids}::uuid[])`, sql`l.is_archived=FALSE`], scope, rec.columns);
    const r = await sql<{ id: string; fullName: string }>`
      SELECT l.id::text AS "id", l.full_name AS "fullName"
      FROM leads l WHERE ${and(where)}`.execute(this.db);
    return r.rows;
  }

  /** Field updates only: pipeline, stage and outcome columns belong to LeadStageService. */
  async update(
    id: string,
    cur: Lead,
    in_: UpdateLeadInput,
    nextAt: Date | null | undefined,
    closeDate: string | null | undefined,
  ): Promise<Lead | null> {
    const pick = (v: string | undefined, fallback: string) => v ?? fallback;
    const pickRef = (v: string | undefined, fallback: string | null) => (v !== undefined ? nullIfBlank(v) : fallback);
    const value = in_.clearValue ? null : (in_.potentialValue ?? cur.potentialValue);
    await sql`
      UPDATE leads SET
        full_name=${in_.fullName !== undefined ? in_.fullName.trim() : cur.fullName},
        email=${in_.email !== undefined ? normalizeEmail(in_.email) : cur.email},
        phone=${in_.phone !== undefined ? normalizePhone(in_.phone) : cur.phone},
        phone_country_code=${in_.phoneCountryCode !== undefined ? in_.phoneCountryCode.trim().toUpperCase() : cur.phoneCountryCode},
        country=${pick(in_.country, cur.country)}, nationality=${pick(in_.nationality, cur.nationality)},
        location=${pick(in_.location, cur.location)},
        owner_user_id=${pickRef(in_.ownerUserId, cur.ownerUserId)}, team_id=${pickRef(in_.teamId, cur.teamId)},
        source=${pick(in_.source, cur.source)}, priority=${pick(in_.priority, cur.priority)},
        tags=${in_.tags ?? cur.tags}::text[], anzsco_id=${pickRef(in_.anzscoId, cur.anzscoId)},
        notes=${pick(in_.notes, cur.notes)}, occupation=${pick(in_.occupation, cur.occupation)},
        job_title=${pick(in_.jobTitle, cur.jobTitle)}, employer=${pick(in_.employer, cur.employer)},
        experience_years=${in_.experienceYears ?? cur.experienceYears}, qualification=${pick(in_.qualification, cur.qualification)},
        skills=${in_.skills ?? cur.skills}::text[], potential_value=${value},
        currency=${in_.currency?.trim() || cur.currency},
        expected_close_at=${closeDate === undefined ? cur.expectedCloseAt : closeDate}::date,
        expected_outcome=${pick(in_.expectedOutcome, cur.expectedOutcome)},
        next_activity_at=${nextAt === undefined ? cur.nextActivityAt : nextAt}, status=${pick(in_.status, cur.status)},
        negotiation_tag=${in_.negotiationTag !== undefined ? in_.negotiationTag.trim() : cur.negotiationTag},
        negotiation_remarks=${in_.negotiationRemarks !== undefined ? in_.negotiationRemarks.trim() : cur.negotiationRemarks},
        contact_rating=${in_.contactRating !== undefined ? in_.contactRating : cur.contactRating},
        contact_remarks=${in_.contactRemarks !== undefined ? in_.contactRemarks.trim() : cur.contactRemarks},
        contact_rated_at=${
          in_.contactRating !== undefined || in_.contactRemarks !== undefined ? new Date() : cur.contactRatedAt
        },
        contact_rated_by=${
          in_.contactRatedBy !== undefined ? in_.contactRatedBy : cur.contactRatedBy
        }::uuid,
        next_follow_up_remarks=${
          in_.nextFollowUpRemarks !== undefined ? in_.nextFollowUpRemarks.trim() : cur.nextFollowUpRemarks
        }
      WHERE id=${id}`.execute(this.db);
    return this.get(id);
  }

  async setArchived(ids: string[], archive: boolean): Promise<number> {
    const r = await sql`
      UPDATE leads SET is_archived=${archive}, archived_at=${archive ? new Date() : null},
        status = CASE WHEN ${archive}::bool THEN 'archived' ELSE CASE WHEN status='archived' THEN ${archive ? "archived" : "open"} ELSE status END END
      WHERE id = ANY(${ids}::uuid[])`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n);
  }

  async bulkAssign(ids: string[], ownerId: string | undefined, teamId: string | undefined): Promise<number> {
    const r = await sql`
      UPDATE leads SET owner_user_id = COALESCE(${nullIfBlank(ownerId)}::uuid, owner_user_id),
        team_id = COALESCE(${nullIfBlank(teamId)}::uuid, team_id)
      WHERE id = ANY(${ids}::uuid[])`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n);
  }

  async findDuplicates(
    excludeId: string,
    email: string | null,
    phone: string | null,
    name: string | null,
    scope: DuplicateScope,
  ): Promise<DuplicateMatch[]> {
    const matches: DuplicateMatch[] = [];

    const collect = async (entity: DuplicateMatch["entity"], reason: string, from: string, alias: string, where: Predicate[]) => {
      const r = await sql<Omit<DuplicateMatch, "entity" | "reason">>`
        SELECT ${sql.raw(alias)}.id::text AS "id", ${sql.raw(alias)}.full_name AS "fullName",
          ${sql.raw(alias)}.email, ${sql.raw(alias)}.phone
        FROM ${sql.raw(from)} WHERE ${and(where)}`.execute(this.db);
      for (const m of r.rows) matches.push({ id: m.id, fullName: m.fullName, email: m.email, phone: m.phone, entity, reason });
    };

    const match = async (reason: string, predicate: (alias: string) => Predicate) => {
      if (scope.leads) {
        const rec = Records.Leads;
        const where = appendScope(
          [sql`l.is_archived=FALSE`, predicate("l"), sql`(${excludeId}='' OR l.id::text <> ${excludeId})`],
          scope.leads,
          rec.columns,
        );
        await collect("lead", reason, rec.from, rec.alias, where);
      }
      if (scope.customers) {
        const rec = Records.Customers;
        const where = appendScope([sql`c.is_archived=FALSE`, predicate("c")], scope.customers, rec.columns);
        await collect("customer", reason, rec.from, rec.alias, where);
      }
    };

    if (email) await match("email", (a) => sql`${sql.raw(a)}.email=${email}`);
    if (phone) await match("phone", (a) => sql`${sql.raw(a)}.phone=${phone}`);
    const trimmedName = name?.trim() ?? "";
    if (trimmedName !== "") await match("name", (a) => sql`lower(${sql.raw(a)}.full_name)=lower(${trimmedName})`);

    // De-dupe by entity+id, keeping the first reason.
    const seen = new Set<string>();
    return matches.filter((m) => {
      const key = `${m.entity}:${m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async markConverted(leadId: string, customerId: string): Promise<void> {
    await sql`UPDATE leads SET status='converted', converted_customer_id=${customerId}, converted_at=NOW() WHERE id=${leadId}`.execute(this.db);
  }

  async touchLastActivity(leadId: string): Promise<void> {
    await sql`UPDATE leads SET last_activity_at=NOW() WHERE id=${leadId}`.execute(this.db);
  }
}

export class LeadsService {
  readonly repo: LeadsRepository;
  readonly phones: PhoneValidationService;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    private readonly hooks: AutomationEmitter,
    private readonly referrals: ReferralsService,
    private readonly customFields: CustomFieldsService,
    private readonly sysActivity: SystemActivityService,
    readonly stages: LeadStageService,
    /** Creates a calendar activity when a lead follow-up date is set. */
    private readonly followUps: FollowUpScheduler | null = null,
  ) {
    this.repo = new LeadsRepository(db);
    this.phones = new PhoneValidationService(db);
  }

  /** Drop contact details for duplicate leads outside the caller's visibility. */
  async attachVisibleDuplicates(leads: Lead[], claims: Claims): Promise<Lead[]> {
    const allIds = [...new Set(leads.flatMap((l) => l.phoneDuplicateLeadIds))];
    if (allIds.length === 0) {
      return leads.map((l) => ({ ...l, phoneDuplicateLeads: [], phoneDuplicateLeadIds: [] }));
    }
    const scope = duplicateScopeFor(claims).leads;
    const visible = await internal("failed to load duplicate leads", () =>
      this.repo.visibleLeadSummaries(allIds, scope),
    );
    const map = new Map(visible.map((v) => [v.id, v]));
    return leads.map((l) => {
      const ids = l.phoneDuplicateLeadIds.filter((id) => map.has(id));
      return {
        ...l,
        phoneDuplicateLeadIds: ids,
        phoneDuplicateLeads: ids.map((id) => map.get(id)!),
      };
    });
  }

  /**
   * Lead next_activity_at alone does not appear on the calendar — that list is activities.
   * Schedule a follow-up activity so "When to follow up?" on create/edit shows up there.
   * Prior open follow-ups are cancelled inside scheduleFollowUp so Reset doesn't leave ghosts.
   */
  private async scheduleLeadFollowUp(actorId: string, lead: Lead, due: Date, meta: RequestMeta): Promise<void> {
    if (!this.followUps) return;
    await this.followUps
      .scheduleFollowUp(
        actorId,
        {
          next: { title: "Follow up", dueAt: due.toISOString(), typeCode: "follow_up" },
          leadId: lead.id,
          ownerUserId: lead.ownerUserId,
        },
        meta,
      )
      .catch(() => undefined);
  }

  private async clearLeadFollowUps(leadId: string): Promise<void> {
    if (!this.followUps) return;
    await this.followUps.cancelOpenFollowUps({ leadId }).catch(() => undefined);
  }

  /** Resolves where a new lead starts: the requested open stage, else the default lead pipeline. */
  private async initialPlacement(in_: CreateLeadInput): Promise<{ pipelineId: string; stage: Stage } | null> {
    const pipelineId = in_.pipelineId?.trim() ?? "";
    const stageId = in_.stageId?.trim() ?? "";
    if (stageId !== "") {
      let pid = pipelineId;
      if (pid === "") {
        const st = await internal("failed to load stage", () => this.stages.pipelines.getStage(stageId));
        if (!st) throw AppError.validation("stage does not belong to pipeline or is inactive");
        pid = st.pipelineId;
      }
      return { pipelineId: pid, stage: await this.stages.validateInitialStage(pid, stageId) };
    }
    if (pipelineId !== "") {
      const stage = await this.stages.firstOpenStage(pipelineId);
      if (!stage) throw AppError.validation("pipeline has no open stage");
      return { pipelineId, stage };
    }
    return this.stages.defaultPlacement();
  }

  async list(f: LeadListFilter): Promise<{ items: Lead[]; total: number }> {
    if (!VALID_STATUSES.has(f.status)) throw AppError.validation("invalid status");
    if (!validAttention(f.attention)) throw AppError.validation("invalid attention");
    return internal("failed to list leads", () => this.repo.list(f));
  }

  async listCountries(f: LeadListFilter): Promise<{ country: string; count: number }[]> {
    if (!VALID_STATUSES.has(f.status)) throw AppError.validation("invalid status");
    if (!validAttention(f.attention)) throw AppError.validation("invalid attention");
    return internal("failed to list lead countries", () => this.repo.listCountries(f));
  }

  async get(id: string): Promise<Lead> {
    const l = await internal("failed to load lead", () => this.repo.get(id));
    if (!l) throw AppError.notFound("lead not found");
    return l;
  }

  async qualify(actorId: string, id: string, meta: RequestMeta): Promise<Lead> {
    const cur = await this.get(id);
    if (cur.status === "qualified") return cur;
    if (cur.status !== "inbox" && cur.status !== "open") {
      throw AppError.validation("only inbox or open leads can be qualified");
    }
    const lead = await internal("failed to qualify lead", () => this.repo.setStatus(id, "qualified"));
    if (!lead) throw AppError.notFound("lead not found");
    await this.audit.record(actorId, "lead.qualified", "lead", id, { from: cur.status, to: "qualified" }, meta);
    return lead;
  }

  async create(claims: Claims, in_: CreateLeadInput, meta: RequestMeta): Promise<LeadWriteResult> {
    const actorId = claims.userId;
    if (in_.fullName.trim() === "") throw AppError.validation("full name is required");
    if (in_.source.trim() === "") throw AppError.validation("lead source is required");
    if (in_.country.trim() === "") throw AppError.fieldValidation("country", "country is required");
    const input = { ...in_, priority: in_.priority || "medium" };
    if (!VALID_PRIORITIES.has(input.priority)) throw AppError.validation("invalid priority");
    if (isReferralSource(input.source)) {
      if (!input.referral) throw AppError.validation("referral details are required when lead source is Referral");
      validateReferral(input.referral);
    }

    // Server-side ownership: sales executives cannot pick owner/team from the client.
    const isSe = claims.roleCode === Role.SalesExecutive;
    if (isSe || !input.ownerUserId) input.ownerUserId = claims.userId;
    if (claims.teamIds.length > 0 && (!input.teamId || isSe)) input.teamId = claims.teamIds[0];

    // Soft-block only on email. Phone is async; same-name leads are common and must not block create.
    const dups = (
      await internal("failed to check duplicates", () =>
        this.repo.findDuplicates("", normalizeEmail(input.email), null, null, duplicateScopeFor(claims)),
      )
    ).filter((d) => d.reason === "email");
    if (dups.length > 0 && !input.forceCreate) return { duplicates: dups, needsReview: true };

    const nextAt = nextActivity(input.nextActivityAt);
    const closeDate = input.expectedCloseAt?.trim() ? parseCloseDate(input.expectedCloseAt) : null;
    const placement = await this.initialPlacement(input);
    if (placement) {
      input.pipelineId = placement.pipelineId;
      input.stageId = placement.stage.id;
    }
    const lead = await internal("failed to create lead", async () => {
      const l = await this.repo.create(
        input,
        nextAt,
        { probability: placement?.stage.probability ?? null, closeDate },
        actorId,
      );
      if (!l) throw new Error("created lead not found");
      return l;
    });
    if (placement) await this.stages.recordInitialStage(lead.id, placement.pipelineId, placement.stage, actorId);
    if (isReferralSource(input.source) && input.referral) {
      await this.referrals.attachToLead(actorId, lead.id, input.referral, meta);
    }
    await this.audit.record(actorId, "lead.created", "lead", lead.id, { fullName: lead.fullName, source: lead.source }, meta);
    await this.timeline.record({
      eventType: TimelineEvent.LeadCreated,
      title: "Lead created",
      body: lead.fullName,
      actorUserId: actorId,
      source: "crm",
      leadId: lead.id,
      metadata: { source: lead.source },
    });
    await this.hooks.emit(AutomationEvent.LeadCreated, "lead", lead.id, {
      fullName: lead.fullName,
      source: lead.source,
      priority: lead.priority,
      pipelineId: lead.pipelineId,
      stageId: lead.stageId,
      ownerUserId: lead.ownerUserId,
    });
    if (input.customFields && Object.keys(input.customFields).length > 0) {
      await this.customFields.setValues(actorId, "lead", lead.id, input.customFields).catch(() => undefined);
    }
    await this.sysActivity.record({
      eventType: "lead.created",
      title: "Lead created",
      actorUserId: actorId,
      entityType: "lead",
      entityId: lead.id,
      entityLabel: lead.fullName,
      metadata: { source: lead.source },
    });
    if (nextAt) await this.scheduleLeadFollowUp(actorId, lead, nextAt, meta);

    const phoneMarked = await this.phones.markPending(
      lead.id,
      lead.phone,
      input.phoneCountryCode ?? lead.phoneCountryCode,
      lead.country,
    );
    if (phoneMarked.enqueue) enqueuePhoneValidation(this.phones, lead.id, phoneMarked.version);

    const [enriched] = await this.attachVisibleDuplicates([await this.get(lead.id)], claims);
    return { lead: enriched ?? lead };
  }

  async update(claims: Claims, id: string, in_: UpdateLeadInput, meta: RequestMeta): Promise<LeadWriteResult> {
    const actorId = claims.userId;
    const cur = await this.get(id);
    const email = in_.email !== undefined ? normalizeEmail(in_.email) : cur.email;
    const phone = in_.phone !== undefined ? normalizePhone(in_.phone) : cur.phone;
    const name = in_.fullName !== undefined ? in_.fullName.trim() : cur.fullName;
    if (in_.priority !== undefined && !VALID_PRIORITIES.has(in_.priority)) throw AppError.validation("invalid priority");
    if (in_.negotiationTag !== undefined) {
      const tag = in_.negotiationTag.trim();
      if (tag !== "" && !NEGOTIATION_TAG_SET.has(tag)) throw AppError.validation("invalid negotiation tag");
      in_.negotiationTag = tag;
      if (tag !== "Others") {
        in_.negotiationRemarks = "";
      } else {
        const remarks = (in_.negotiationRemarks !== undefined ? in_.negotiationRemarks : cur.negotiationRemarks).trim();
        if (remarks === "") throw AppError.validation("remarks are required when the tag is Others");
        in_.negotiationRemarks = remarks;
      }
    } else if (in_.negotiationRemarks !== undefined && cur.negotiationTag === "Others") {
      if (in_.negotiationRemarks.trim() === "") throw AppError.validation("remarks are required when the tag is Others");
    }
    const touchingContact =
      in_.contactRating !== undefined || in_.contactRemarks !== undefined;
    if (touchingContact) {
      if (!isContactedStage(cur.stageName)) {
        throw AppError.validation("Contact rating can only be edited while the lead is in Contacted", {
          reason: "contact_rating_locked",
        });
      }
      const nextRating =
        in_.contactRating !== undefined ? parseContactRating(in_.contactRating) : parseContactRating(cur.contactRating);
      const nextRemarks =
        in_.contactRemarks !== undefined ? in_.contactRemarks.trim() : (cur.contactRemarks ?? "").trim();
      if (in_.contactRating !== undefined && nextRating == null) {
        throw AppError.validation("Star rating must be a whole number from 1 to 5");
      }
      // Saving either field requires a complete, valid pair so the lead can leave Contacted.
      if (nextRating == null) throw AppError.validation("Add a star rating");
      const remarksIssue = contactRemarksProblem(nextRemarks);
      if (remarksIssue) throw AppError.validation(remarksIssue);
      in_.contactRating = nextRating;
      in_.contactRemarks = nextRemarks;
      in_.contactRatedBy = actorId;
    }
    if (in_.nextFollowUpRemarks !== undefined) {
      const next = in_.nextFollowUpRemarks.trim();
      const issue = nextFollowUpRemarksProblem(next);
      // Allow clearing only when the lead is not on a Contacted→Lost stage.
      if (issue && requiresNextFollowUpRemarks(cur.stageName)) throw AppError.validation(issue);
      if (next.length > 2000) throw AppError.validation("Keep next follow-up remarks under 2,000 characters");
      in_.nextFollowUpRemarks = next;
    }
    const curOwner = cur.ownerUserId ?? "";
    const curTeam = cur.teamId ?? "";
    const newOwner = in_.ownerUserId !== undefined ? in_.ownerUserId.trim() : curOwner;
    const newTeam = in_.teamId !== undefined ? in_.teamId.trim() : curTeam;
    if (newOwner !== curOwner || newTeam !== curTeam) {
      assignTargetInScope(claims, newOwner !== curOwner ? newOwner : "", newTeam !== curTeam ? newTeam : "");
    }

    // Soft-block only when email is changing and already belongs to another record.
    // Unrelated edits (notes, stage fields, same name as someone else) must not 409.
    if (in_.email !== undefined && !in_.forceUpdate) {
      const dups = (
        await internal("failed to check duplicates", () =>
          this.repo.findDuplicates(id, email, null, null, duplicateScopeFor(claims)),
        )
      ).filter((d) => d.reason === "email");
      if (dups.length > 0) return { duplicates: dups, needsReview: true };
    }

    const status = in_.status?.trim() ?? "";
    if (status !== "" && status !== cur.status) {
      if (MOVE_ONLY_STATUSES.has(status)) throw AppError.validation("move the lead to a Won or Lost stage to close it");
      if (cur.status === "won" || cur.status === "lost") throw AppError.validation("reopen the lead by moving it to an open stage");
      if (!VALID_STATUSES.has(status) || status === "all" || status === "working" || status === "closed") {
        throw AppError.validation("invalid status");
      }
    }
    const nextAt = in_.nextActivityAt !== undefined ? nextActivity(in_.nextActivityAt) : undefined;
    const closeDate = in_.clearCloseDate
      ? null
      : in_.expectedCloseAt !== undefined && in_.expectedCloseAt.trim() !== ""
        ? parseCloseDate(in_.expectedCloseAt)
        : undefined;

    // Stage changes go through LeadStageService; validate before any write.
    const stageId = in_.stageId?.trim() ?? "";
    const pipelineId = in_.pipelineId?.trim() ?? "";
    let targetStage = stageId;
    if (targetStage === "" && pipelineId !== "" && pipelineId !== cur.pipelineId) {
      targetStage = (await this.stages.firstOpenStage(pipelineId))?.id ?? "";
      if (targetStage === "") throw AppError.validation("pipeline has no open stage");
    }
    const pickRef = (v: string | undefined, fallback: string | null) => (v !== undefined ? v.trim() || null : fallback);
    const plan =
      targetStage !== "" && targetStage !== cur.stageId
        ? await this.stages.plan(
            { kind: "user", claims },
            id,
            {
              stageId: targetStage,
              pipelineId: pipelineId !== "" && pipelineId !== cur.pipelineId ? pipelineId : undefined,
              force: in_.forceStage,
              reopen: in_.reopen,
              lostReason: in_.lostReason,
            },
            {
              id,
              fullName: name,
              email,
              phone,
              ownerUserId: pickRef(in_.ownerUserId, cur.ownerUserId),
              teamId: pickRef(in_.teamId, cur.teamId),
              pipelineId: cur.pipelineId,
              stageId: cur.stageId,
              stageName: cur.stageName,
              source: in_.source ?? cur.source,
              priority: in_.priority ?? cur.priority,
              notes: in_.notes ?? cur.notes,
              employer: in_.employer ?? cur.employer,
              potentialValue: in_.clearValue ? null : (in_.potentialValue ?? cur.potentialValue),
              expectedCloseAt: closeDate === undefined ? cur.expectedCloseAt : closeDate,
              status: cur.status,
              isArchived: cur.isArchived,
              stageEnteredAt: cur.stageEnteredAt,
              createdAt: cur.createdAt,
              contactRating: in_.contactRating !== undefined ? in_.contactRating : cur.contactRating,
              contactRemarks: in_.contactRemarks !== undefined ? in_.contactRemarks.trim() : cur.contactRemarks,
              nextFollowUpRemarks:
                in_.nextFollowUpRemarks !== undefined ? in_.nextFollowUpRemarks.trim() : cur.nextFollowUpRemarks,
            },
          )
        : null;

    let lead = await internal("failed to update lead", async () => {
      const l = await this.repo.update(id, cur, in_, nextAt, closeDate);
      if (!l) throw new Error("updated lead not found");
      return l;
    });
    if (plan) {
      await this.stages.apply(actorId, plan, meta, "crm");
      lead = await this.get(id);
    }

    const nextSource = in_.source !== undefined ? in_.source.trim() : cur.source;
    if (isReferralSource(nextSource) && in_.referral) {
      await this.referrals.upsertForLead(actorId, id, in_.referral, meta);
    }

    await this.audit.record(actorId, "lead.updated", "lead", id, { fullName: lead.fullName }, meta);

    if (changed(cur.ownerUserId, lead.ownerUserId)) {
      await this.audit.record(actorId, "lead.assignment_changed", "lead", id, { ownerUserId: lead.ownerUserId }, meta);
      await this.timeline.record({
        eventType: TimelineEvent.AssignmentChange,
        title: "Assignment change",
        body: "Lead owner updated",
        actorUserId: actorId,
        source: "crm",
        leadId: id,
        metadata: { ownerUserId: lead.ownerUserId },
      });
      await this.hooks.emit(AutomationEvent.LeadAssigned, "lead", id, { ownerUserId: lead.ownerUserId, teamId: lead.teamId });
    }
    if (in_.customFields && Object.keys(in_.customFields).length > 0) {
      await this.customFields.setValues(actorId, "lead", id, in_.customFields).catch(() => undefined);
    }
    // New/changed follow-up → replace calendar activity; cleared date → drop open follow-ups.
    if (in_.nextActivityAt !== undefined) {
      if (nextAt && (cur.nextActivityAt === null || cur.nextActivityAt.getTime() !== nextAt.getTime())) {
        await this.scheduleLeadFollowUp(actorId, lead, nextAt, meta);
      } else if (!nextAt) {
        await this.clearLeadFollowUps(id);
      }
    }

    const phoneChanged =
      in_.phone !== undefined && (normalizePhone(in_.phone) ?? null) !== (cur.phone ?? null);
    const countryChanged = in_.country !== undefined && in_.country !== cur.country;
    const phoneCountryChanged =
      in_.phoneCountryCode !== undefined &&
      in_.phoneCountryCode.trim().toUpperCase() !== (cur.phoneCountryCode || "").toUpperCase();
    if (phoneChanged || countryChanged || phoneCountryChanged) {
      const marked = await this.phones.markPending(
        id,
        lead.phone,
        in_.phoneCountryCode ?? lead.phoneCountryCode,
        lead.country,
      );
      if (marked.enqueue) enqueuePhoneValidation(this.phones, id, marked.version);
      lead = await this.get(id);
    }

    const [enriched] = await this.attachVisibleDuplicates([lead], claims);
    return { lead: enriched ?? lead };
  }

  async archive(actorId: string, ids: string[] | undefined, archive: boolean, meta: RequestMeta): Promise<number> {
    if (!ids || ids.length === 0) throw AppError.validation("ids are required");
    const n = await internal("failed to archive leads", () => this.repo.setArchived(ids, archive));
    await this.audit.record(actorId, archive ? "lead.archived" : "lead.restored", "lead", null, { ids, count: n }, meta);
    return n;
  }

  async bulkAssign(actorId: string, in_: BulkAssignInput, meta: RequestMeta): Promise<number> {
    const ids = in_.ids;
    if (!ids || ids.length === 0) throw AppError.validation("ids are required");
    const n = await internal("failed to assign leads", () => this.repo.bulkAssign(ids, in_.ownerUserId, in_.teamId));
    const ownerUserId = in_.ownerUserId ?? null;
    const teamId = in_.teamId ?? null;
    await this.audit.record(actorId, "lead.assignment_changed", "lead", null, { ids, ownerUserId, teamId }, meta);
    for (const id of ids) {
      await this.hooks.emit(AutomationEvent.LeadAssigned, "lead", id, { ownerUserId, teamId, bulk: true });
    }
    return n;
  }

  /** Moves each lead through LeadStageService; leads that fail validation are reported, not moved. */
  async bulkStage(claims: Claims, in_: BulkStageInput, meta: RequestMeta): Promise<BulkStageResult> {
    const ids = in_.ids;
    if (!ids || ids.length === 0 || in_.pipelineId === "" || in_.stageId === "") {
      throw AppError.validation("ids, pipelineId and stageId are required");
    }
    const result: BulkStageResult = { updated: 0, failed: [] };
    for (const id of [...new Set(ids)]) {
      try {
        const out = await this.stages.move(
          { kind: "user", claims },
          id,
          { stageId: in_.stageId, pipelineId: in_.pipelineId },
          meta,
        );
        if (out.changed) result.updated++;
      } catch (err) {
        if (!(err instanceof AppError) || err.status >= 500) throw err;
        result.failed.push({ id, error: err.message });
      }
    }
    return result;
  }

  async checkDuplicates(
    claims: Claims,
    excludeId: string,
    email: string | undefined,
    phone: string | undefined,
    name: string | undefined,
  ): Promise<DuplicateMatch[]> {
    return internal("failed to check duplicates", () =>
      this.repo.findDuplicates(excludeId, normalizeEmail(email), normalizePhone(phone), name ?? null, duplicateScopeFor(claims)),
    );
  }

  /** True when the lead has an open document send-by date that is already past. */
  async hasOverdueDocumentDeadline(leadId: string): Promise<boolean> {
    const r = await internal("failed to check document deadline", () =>
      sql<{ overdue: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM documents d
          WHERE d.lead_id = ${leadId}::uuid
            AND d.expires_at IS NOT NULL
            AND d.expires_at < NOW()
            AND d.status IN ('requested', 'missing', 'uploaded', 'expired')
        ) AS overdue`.execute(this.db),
    );
    return Boolean(r.rows[0]?.overdue);
  }

  async listDocumentDelayRemarks(leadId: string): Promise<DocumentDelayRemark[]> {
    await this.get(leadId);
    const r = await internal("failed to list document delay remarks", () =>
      sql<DocumentDelayRemark>`
        SELECT r.id::text AS "id", r.lead_id::text AS "leadId", r.body,
          r.author_user_id::text AS "authorUserId", u.full_name AS "authorName",
          r.created_at AS "createdAt"
        FROM lead_document_delay_remarks r
        LEFT JOIN users u ON u.id = r.author_user_id
        WHERE r.lead_id = ${leadId}::uuid
        ORDER BY r.created_at DESC`.execute(this.db),
    );
    return r.rows;
  }

  /**
   * Appends an overdue-document remark and refreshes the latest copy on the lead.
   * History rows are kept so TL/SA can see prior explanations.
   */
  async addDocumentDelayRemark(
    claims: Claims,
    leadId: string,
    body: string,
    meta: RequestMeta,
  ): Promise<{ lead: Lead; remark: DocumentDelayRemark }> {
    const text = body.trim();
    if (text === "") throw AppError.validation("remarks are required");
    if (text.length > 1000) throw AppError.validation("remarks must be at most 1000 characters");
    const lead = await this.get(leadId);
    if (!(await this.hasOverdueDocumentDeadline(leadId))) {
      throw AppError.validation("Document deliverables are not overdue for this lead", {
        reason: "document_not_overdue",
      });
    }
    const now = new Date();
    const id = randomUUID();
    await internal("failed to save document delay remarks", async () => {
      await sql`
        INSERT INTO lead_document_delay_remarks (id, lead_id, body, author_user_id, created_at)
        VALUES (${id}::uuid, ${leadId}::uuid, ${text}, ${claims.userId}::uuid, ${now})`.execute(this.db);
      await sql`
        UPDATE leads SET
          document_delay_remarks = ${text},
          document_delay_remarks_at = ${now},
          document_delay_remarks_by = ${claims.userId}::uuid,
          updated_at = ${now}
        WHERE id = ${leadId}::uuid`.execute(this.db);
    });
    await this.audit.record(
      claims.userId,
      "lead.document_delay_remarks",
      "lead",
      leadId,
      { body: text },
      meta,
    );
    const history = await internal("failed to list document delay remarks", () =>
      sql<DocumentDelayRemark>`
        SELECT r.id::text AS "id", r.lead_id::text AS "leadId", r.body,
          r.author_user_id::text AS "authorUserId", u.full_name AS "authorName",
          r.created_at AS "createdAt"
        FROM lead_document_delay_remarks r
        LEFT JOIN users u ON u.id = r.author_user_id
        WHERE r.id = ${id}::uuid`.execute(this.db),
    );
    return {
      lead: await this.get(leadId),
      remark: history.rows[0] ?? {
        id,
        leadId,
        body: text,
        authorUserId: claims.userId,
        authorName: null,
        createdAt: now,
      },
    };
  }
}

export interface DocumentDelayRemark {
  id: string;
  leadId: string;
  body: string;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: Date;
}
