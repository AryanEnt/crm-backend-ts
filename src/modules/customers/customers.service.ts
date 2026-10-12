import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { InvalidTimeError, parseOptionalTime } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { AttentionSql, computeAttention, validAttention } from "../attention/attention.js";
import { goMapOrNull } from "../../lib/go-json.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import { AutomationEvent, type AutomationEmitter } from "../automation/emitter.js";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service.js";
import { and, appendScope, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import {
  duplicateScopeFor,
  normalizeEmail,
  normalizePhone,
  nullIfBlank,
  type DuplicateMatch,
  type Lead,
  type LeadsRepository,
} from "../leads/leads.service.js";
import {
  isReferralSource,
  validateReferral,
  type Referral,
  type ReferralInput,
  type ReferralsService,
} from "../referrals/referrals.service.js";
import type { SystemActivityService } from "../system-activity/system-activity.service.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";

export interface Customer {
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
  occupation: string;
  jobTitle: string;
  employer: string;
  experienceYears: number | null;
  qualification: string;
  skills: string[];
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  potentialValue: number | null;
  expectedOutcome: string;
  lastContactedAt: Date | null;
  nextFollowUpAt: Date | null;
  notes: string;
  convertedFromLeadId: string | null;
  isArchived: boolean;
  attention: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DealSummary {
  id: string;
  title: string;
  value: number | null;
  currency: string;
  status: string;
  stageName: string | null;
  pipelineName: string | null;
  ownerName: string | null;
  createdAt: Date;
}

export interface ActivityItem {
  id: string;
  kind: string;
  subject: string;
  body: string;
  status: string;
  dueAt: Date | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface DocumentItem {
  id: string;
  name: string;
  type: string;
  category: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByName: string | null;
  verifiedByName: string | null;
  requestedDate: Date | null;
  uploadedDate: Date | null;
  expiryDate: Date | null;
  createdAt: Date;
}

export interface Profile360 {
  customer: Customer;
  deals: DealSummary[];
  activities: ActivityItem[];
  documents: DocumentItem[];
  referral: Referral | null;
}

export interface CreateCustomerInput {
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
  occupation: string;
  jobTitle: string;
  employer: string;
  experienceYears?: number | undefined;
  qualification: string;
  skills?: string[] | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  potentialValue?: number | undefined;
  expectedOutcome: string;
  notes: string;
  forceCreate: boolean;
  customFields?: Record<string, unknown> | undefined;
  referral?: ReferralInput | undefined;
}

export interface UpdateCustomerInput {
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
  occupation?: string | undefined;
  jobTitle?: string | undefined;
  employer?: string | undefined;
  experienceYears?: number | undefined;
  qualification?: string | undefined;
  skills?: string[] | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  potentialValue?: number | undefined;
  expectedOutcome?: string | undefined;
  notes?: string | undefined;
  nextFollowUpAt?: string | undefined;
  forceUpdate: boolean;
  customFields?: Record<string, unknown> | undefined;
}

export interface CustomerListFilter {
  search: string;
  teamId: string;
  source: string;
  country: string;
  createdFrom: string;
  createdTo: string;
  attention: string;
  limit: number;
  offset: number;
  scope: Visibility;
}

export type CustomerWriteResult = { customer: Customer } | { duplicates: DuplicateMatch[] };

type CustomerRow = Omit<Customer, "attention" | "tags" | "skills"> & { tags: string[] | null; skills: string[] | null };

const customerSelect = sql`
  SELECT c.id::text AS "id", c.full_name AS "fullName", c.email, c.phone, c.country, c.nationality, c.location,
    c.owner_user_id::text AS "ownerUserId", ou.full_name AS "ownerName", c.team_id::text AS "teamId", t.name AS "teamName",
    c.source, c.priority, c.tags, c.anzsco_id::text AS "anzscoId", a.code AS "anzscoCode", a.title AS "anzscoTitle",
    c.occupation, c.job_title AS "jobTitle", c.employer, c.experience_years AS "experienceYears", c.qualification, c.skills,
    c.pipeline_id::text AS "pipelineId", p.name AS "pipelineName", c.stage_id::text AS "stageId", ps.name AS "stageName",
    c.potential_value AS "potentialValue", c.expected_outcome AS "expectedOutcome",
    c.last_contacted_at AS "lastContactedAt", c.next_follow_up_at AS "nextFollowUpAt",
    c.notes, c.converted_from_lead_id::text AS "convertedFromLeadId", c.is_archived AS "isArchived",
    c.created_at AS "createdAt", c.updated_at AS "updatedAt"
  FROM customers c
  LEFT JOIN users ou ON ou.id = c.owner_user_id
  LEFT JOIN teams t ON t.id = c.team_id
  LEFT JOIN anzsco_occupations a ON a.id = c.anzsco_id
  LEFT JOIN pipelines p ON p.id = c.pipeline_id
  LEFT JOIN pipeline_stages ps ON ps.id = c.stage_id`;

/** Go struct field order (dealCount is omitempty and never set, so it is always omitted). */
const CUSTOMER_KEYS: (keyof Customer)[] = [
  "id", "fullName", "email", "phone", "country", "nationality", "location", "ownerUserId", "ownerName", "teamId",
  "teamName", "source", "priority", "tags", "anzscoId", "anzscoCode", "anzscoTitle", "occupation", "jobTitle",
  "employer", "experienceYears", "qualification", "skills", "pipelineId", "pipelineName", "stageId", "stageName",
  "potentialValue", "expectedOutcome", "lastContactedAt", "nextFollowUpAt", "notes", "convertedFromLeadId",
  "isArchived", "attention", "createdAt", "updatedAt",
];

function toCustomer(r: CustomerRow): Customer {
  const c: Customer = {
    ...r,
    tags: r.tags ?? [],
    skills: r.skills ?? [],
    attention: computeAttention({
      closed: r.isArchived,
      next: r.nextFollowUpAt,
      last: r.lastContactedAt,
      anchor: null,
      createdAt: r.createdAt,
      slaHours: null,
    }),
  };
  return Object.fromEntries(CUSTOMER_KEYS.map((k) => [k, c[k]])) as unknown as Customer;
}

export class CustomersRepository {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Customer | null> {
    const r = await sql<CustomerRow>`${customerSelect} WHERE c.id=${id}`.execute(this.db);
    return r.rows[0] ? toCustomer(r.rows[0]) : null;
  }

  async list(f: CustomerListFilter): Promise<{ items: Customer[]; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 25 : f.limit;
    let where: Predicate[] = [
      sql`c.is_archived=FALSE`,
      sql`(${f.search}='' OR c.full_name ILIKE '%'||${f.search}||'%' OR COALESCE(c.email,'') ILIKE '%'||${f.search}||'%')`,
    ];
    if (f.teamId !== "") where.push(sql`c.team_id::text = ${f.teamId}`);
    if (f.source !== "") where.push(sql`c.source = ${f.source}`);
    if (f.country !== "") where.push(sql`c.country = ${f.country}`);
    if (f.createdFrom !== "") where.push(sql`c.created_at >= ${f.createdFrom}::timestamptz`);
    if (f.createdTo !== "") where.push(sql`c.created_at < (${f.createdTo}::date + INTERVAL '1 day')`);
    if (f.attention !== "") where.push(sql`(${sql.raw(AttentionSql.customer)}) = ${f.attention}`);
    where = appendScope(where, f.scope, Records.Customers.columns);

    const count = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM customers c WHERE ${and(where)}`.execute(this.db);
    // Go does not clamp a negative offset here; Postgres rejects it and the list fails.
    const rows = await sql<CustomerRow>`
      ${customerSelect} WHERE ${and(where)}
      ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return { items: rows.rows.map(toCustomer), total: count.rows[0]?.total ?? 0 };
  }

  async createFromLead(lead: Lead): Promise<Customer | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO customers (
        id, full_name, email, phone, country, nationality, location,
        owner_user_id, team_id, source, priority, tags, anzsco_id,
        occupation, job_title, employer, experience_years, qualification, skills,
        pipeline_id, stage_id, potential_value, expected_outcome, notes,
        converted_from_lead_id, last_contacted_at, next_follow_up_at
      ) VALUES (
        ${id}, ${lead.fullName}, ${lead.email}, ${lead.phone}, ${lead.country}, ${lead.nationality}, ${lead.location},
        ${lead.ownerUserId}, ${lead.teamId}, ${lead.source}, ${lead.priority}, ${lead.tags}::text[], ${lead.anzscoId},
        ${lead.occupation}, ${lead.jobTitle}, ${lead.employer}, ${lead.experienceYears}, ${lead.qualification}, ${lead.skills}::text[],
        NULL, NULL, ${lead.potentialValue}, ${lead.expectedOutcome}, ${lead.notes},
        ${lead.id}, ${lead.lastActivityAt}, ${lead.nextActivityAt}
      )`.execute(this.db);
    return this.get(id);
  }

  async create(in_: CreateCustomerInput): Promise<Customer | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO customers (
        id, full_name, email, phone, country, nationality, location,
        owner_user_id, team_id, source, priority, tags, anzsco_id,
        occupation, job_title, employer, experience_years, qualification, skills,
        pipeline_id, stage_id, potential_value, expected_outcome, notes
      ) VALUES (
        ${id}, ${in_.fullName.trim()}, ${normalizeEmail(in_.email)}, ${normalizePhone(in_.phone)},
        ${in_.country}, ${in_.nationality}, ${in_.location},
        ${nullIfBlank(in_.ownerUserId)}, ${nullIfBlank(in_.teamId)}, ${in_.source}, ${in_.priority || "medium"},
        ${in_.tags ?? []}::text[], ${nullIfBlank(in_.anzscoId)},
        ${in_.occupation}, ${in_.jobTitle}, ${in_.employer}, ${in_.experienceYears ?? null}, ${in_.qualification},
        ${in_.skills ?? []}::text[],
        ${nullIfBlank(in_.pipelineId)}, ${nullIfBlank(in_.stageId)}, ${in_.potentialValue ?? null}, ${in_.expectedOutcome}, ${in_.notes}
      )`.execute(this.db);
    return this.get(id);
  }

  async update(id: string, cur: Customer, in_: UpdateCustomerInput, next: Date | null | undefined): Promise<Customer | null> {
    const pick = (v: string | undefined, fallback: string) => v ?? fallback;
    const pickRef = (v: string | undefined, fallback: string | null) => (v !== undefined ? nullIfBlank(v) : fallback);
    await sql`
      UPDATE customers SET
        full_name=${in_.fullName !== undefined ? in_.fullName.trim() : cur.fullName},
        email=${in_.email !== undefined ? normalizeEmail(in_.email) : cur.email},
        phone=${in_.phone !== undefined ? normalizePhone(in_.phone) : cur.phone},
        country=${pick(in_.country, cur.country)}, nationality=${pick(in_.nationality, cur.nationality)},
        location=${pick(in_.location, cur.location)},
        owner_user_id=${pickRef(in_.ownerUserId, cur.ownerUserId)}, team_id=${pickRef(in_.teamId, cur.teamId)},
        source=${pick(in_.source, cur.source)}, priority=${pick(in_.priority, cur.priority)},
        tags=${in_.tags ?? cur.tags}::text[], anzsco_id=${pickRef(in_.anzscoId, cur.anzscoId)},
        occupation=${pick(in_.occupation, cur.occupation)}, job_title=${pick(in_.jobTitle, cur.jobTitle)},
        employer=${pick(in_.employer, cur.employer)}, experience_years=${in_.experienceYears ?? cur.experienceYears},
        qualification=${pick(in_.qualification, cur.qualification)}, skills=${in_.skills ?? cur.skills}::text[],
        pipeline_id=${pickRef(in_.pipelineId, cur.pipelineId)}, stage_id=${pickRef(in_.stageId, cur.stageId)},
        potential_value=${in_.potentialValue ?? cur.potentialValue},
        expected_outcome=${pick(in_.expectedOutcome, cur.expectedOutcome)}, notes=${pick(in_.notes, cur.notes)},
        next_follow_up_at=${next === undefined ? cur.nextFollowUpAt : next}
      WHERE id=${id}`.execute(this.db);
    return this.get(id);
  }

  async listDeals(customerId: string): Promise<DealSummary[]> {
    const r = await sql<DealSummary>`
      SELECT d.id::text AS "id", d.title, d.value, d.currency, d.status, ps.name AS "stageName", p.name AS "pipelineName",
        ou.full_name AS "ownerName", d.created_at AS "createdAt"
      FROM deals d
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      LEFT JOIN pipelines p ON p.id = d.pipeline_id
      LEFT JOIN users ou ON ou.id = d.owner_user_id
      WHERE d.customer_id = ${customerId}
      ORDER BY d.created_at DESC`.execute(this.db);
    return r.rows;
  }

  async listActivities(customerId: string, limit: number): Promise<ActivityItem[]> {
    const r = await sql<Omit<ActivityItem, "metadata"> & { metadata: unknown }>`
      SELECT a.id::text AS "id", a.kind, a.subject, a.body, a.status, a.due_at AS "dueAt", u.full_name AS "actorName",
        a.metadata, a.created_at AS "createdAt"
      FROM activities a
      LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.customer_id = ${customerId}
      ORDER BY a.created_at DESC
      LIMIT ${limit <= 0 ? 50 : limit}`.execute(this.db);
    return r.rows.map((a) => ({ ...a, metadata: goMapOrNull(a.metadata) }));
  }

  async listDocuments(customerId: string): Promise<DocumentItem[]> {
    const r = await sql<DocumentItem>`
      SELECT d.id::text AS "id", d.name, d.doc_type AS "type", d.category, d.status, d.mime_type AS "mimeType",
        d.size_bytes AS "sizeBytes", ub.full_name AS "uploadedByName", vb.full_name AS "verifiedByName",
        d.requested_at AS "requestedDate", d.uploaded_at AS "uploadedDate", d.expires_at AS "expiryDate", d.created_at AS "createdAt"
      FROM documents d
      LEFT JOIN users ub ON ub.id = d.uploaded_by
      LEFT JOIN users vb ON vb.id = d.verified_by
      WHERE d.customer_id=${customerId}
      ORDER BY COALESCE(d.uploaded_at, d.requested_at, d.created_at) DESC`.execute(this.db);
    return r.rows;
  }
}

const changed = (a: string | null, b: string | null) => a !== b;

export class CustomersService {
  readonly repo: CustomersRepository;

  constructor(
    db: Database,
    private readonly leads: LeadsRepository,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    private readonly hooks: AutomationEmitter,
    private readonly referrals: ReferralsService,
    private readonly customFields: CustomFieldsService,
    private readonly sysActivity: SystemActivityService,
  ) {
    this.repo = new CustomersRepository(db);
  }

  async list(f: CustomerListFilter): Promise<{ items: Customer[]; total: number }> {
    if (!validAttention(f.attention)) throw AppError.validation("invalid attention");
    return internal("failed to list customers", () => this.repo.list(f));
  }

  async get(id: string): Promise<Customer> {
    const c = await internal("failed to load customer", () => this.repo.get(id));
    if (!c) throw AppError.notFound("customer not found");
    return c;
  }

  async get360(id: string): Promise<Profile360> {
    const customer = await this.get(id);
    const deals = await internal("failed to load deals", () => this.repo.listDeals(id));
    const activities = await internal("failed to load activities", () => this.repo.listActivities(id, 50));
    const documents = await internal("failed to load documents", () => this.repo.listDocuments(id));
    const referral = await this.referrals.getForCustomer(id);
    return { customer, deals, activities, documents, referral };
  }

  async create(claims: Claims, in_: CreateCustomerInput, meta: RequestMeta): Promise<CustomerWriteResult> {
    const actorId = claims.userId;
    if (in_.fullName.trim() === "") throw AppError.validation("full name is required");
    if (in_.source.trim() === "") throw AppError.validation("customer source is required");
    const input = { ...in_, priority: in_.priority || "medium" };
    if (isReferralSource(input.source)) {
      if (!input.referral) throw AppError.validation("referral details are required when source is Referral");
      validateReferral(input.referral);
    }
    const name = input.fullName.trim();
    const dups = await internal("failed to check duplicates", () =>
      this.leads.findDuplicates("", normalizeEmail(input.email), normalizePhone(input.phone), name, duplicateScopeFor(claims)),
    );
    if (dups.length > 0 && !input.forceCreate) return { duplicates: dups };

    const c = await internal("failed to create customer", async () => {
      const row = await this.repo.create(input);
      if (!row) throw new Error("created customer not found");
      return row;
    });
    if (isReferralSource(input.source) && input.referral) {
      await this.referrals.attachToCustomer(actorId, c.id, input.referral, meta);
    }
    await this.audit.record(actorId, "customer.created", "customer", c.id, { fullName: c.fullName }, meta);
    await this.timeline.record({
      eventType: TimelineEvent.CustomerCreated,
      title: "Customer created",
      body: c.fullName,
      actorUserId: actorId,
      source: "crm",
      customerId: c.id,
    });
    if (input.customFields && Object.keys(input.customFields).length > 0) {
      await this.customFields.setValues(actorId, "customer", c.id, input.customFields).catch(() => undefined);
    }
    await this.sysActivity.record({
      eventType: "customer.created",
      title: "Customer created",
      actorUserId: actorId,
      entityType: "customer",
      entityId: c.id,
      entityLabel: c.fullName,
    });
    return { customer: c };
  }

  async update(claims: Claims, id: string, in_: UpdateCustomerInput, meta: RequestMeta): Promise<CustomerWriteResult> {
    const actorId = claims.userId;
    const cur = await this.get(id);
    const email = in_.email !== undefined ? normalizeEmail(in_.email) : cur.email;
    const phone = in_.phone !== undefined ? normalizePhone(in_.phone) : cur.phone;
    const name = in_.fullName !== undefined ? in_.fullName.trim() : cur.fullName;
    const dups = await internal("failed to check duplicates", () =>
      this.leads.findDuplicates("", email, phone, name, duplicateScopeFor(claims)),
    );
    const others = dups.filter((d) => !(d.entity === "customer" && d.id === id));
    if (others.length > 0 && !in_.forceUpdate) return { duplicates: others };

    let next: Date | null | undefined;
    if (in_.nextFollowUpAt !== undefined) {
      try {
        next = parseOptionalTime(in_.nextFollowUpAt);
      } catch (err) {
        if (err instanceof InvalidTimeError) throw AppError.validation("invalid nextFollowUpAt");
        throw err;
      }
    }

    const c = await internal("failed to update customer", async () => {
      const row = await this.repo.update(id, cur, in_, next);
      if (!row) throw new Error("updated customer not found");
      return row;
    });
    await this.audit.record(actorId, "customer.updated", "customer", id, { fullName: c.fullName }, meta);
    if (changed(cur.ownerUserId, c.ownerUserId)) {
      await this.audit.record(actorId, "customer.assignment_changed", "customer", id, { ownerUserId: c.ownerUserId }, meta);
      await this.timeline.record({
        eventType: TimelineEvent.AssignmentChange,
        title: "Assignment change",
        body: "Customer owner updated",
        actorUserId: actorId,
        source: "crm",
        customerId: id,
        metadata: { ownerUserId: c.ownerUserId },
      });
    }
    if (changed(cur.stageId, c.stageId)) {
      await this.audit.record(actorId, "customer.stage_changed", "customer", id, { stageId: c.stageId }, meta);
      await this.timeline.record({
        eventType: TimelineEvent.StageChange,
        title: "Stage change",
        body: "Customer stage updated",
        actorUserId: actorId,
        source: "crm",
        customerId: id,
        metadata: { stageId: c.stageId },
      });
    }
    await this.hooks.emit(AutomationEvent.CustomerUpdated, "customer", id, {
      fullName: c.fullName,
      ownerUserId: c.ownerUserId,
      teamId: c.teamId,
    });
    if (in_.customFields && Object.keys(in_.customFields).length > 0) {
      await this.customFields.setValues(actorId, "customer", id, in_.customFields).catch(() => undefined);
    }
    return { customer: c };
  }

  async convertFromLead(actorId: string, leadId: string, meta: RequestMeta): Promise<Customer> {
    const lead = await internal("failed to load lead", () => this.leads.get(leadId));
    if (!lead) throw AppError.notFound("lead not found");
    if (lead.convertedCustomerId !== null) return this.get(lead.convertedCustomerId);
    if (lead.isArchived) throw AppError.validation("cannot convert an archived lead");

    const c = await internal("failed to create customer from lead", async () => {
      const row = await this.repo.createFromLead(lead);
      if (!row) throw new Error("created customer not found");
      return row;
    });
    await internal("failed to mark lead converted", () => this.leads.markConverted(leadId, c.id));
    await this.referrals.markLeadConverted(actorId, leadId, c.id, meta).catch(() => undefined);
    await this.audit.record(actorId, "lead.converted", "lead", leadId, { customerId: c.id }, meta);
    await this.audit.record(actorId, "customer.created", "customer", c.id, { fromLeadId: leadId }, meta);
    await this.timeline.record({
      eventType: TimelineEvent.CustomerCreated,
      title: "Customer created",
      body: `${c.fullName} (converted from lead)`,
      actorUserId: actorId,
      source: "crm",
      customerId: c.id,
      leadId,
      metadata: { fromLeadId: leadId },
    });
    return c;
  }
}
