import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goMapOrNull } from "../../lib/go-json.js";
import { parseDateOnly } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import type { FollowUpRequest, NextActivityInput } from "../activities/activities.service.js";
import { AttentionSql, computeAttention, validAttention } from "../attention/attention.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import { AutomationEvent, type AutomationEmitter } from "../automation/emitter.js";
import type { DocumentItem } from "../customers/customers.service.js";
import { and, appendScope, effectiveScope, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import type { Pipeline, PipelinesService, Stage } from "../pipelines/pipelines.service.js";
import type { SystemActivityService } from "../system-activity/system-activity.service.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";

export interface Deal {
  id: string;
  title: string;
  customerId: string;
  customerName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  stageAccent: string | null;
  value: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: string | null;
  source: string;
  priority: string;
  status: string;
  lostReason: string;
  notes: string;
  fieldValues: Record<string, unknown> | null;
  lastActivityAt: Date | null;
  nextActivityAt: Date | null;
  stageEnteredAt: Date;
  ageDays: number;
  daysInStage: number;
  attention: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StageTransition {
  id: string;
  dealId: string;
  fromPipelineId: string | null;
  fromStageId: string | null;
  fromStageName: string | null;
  toPipelineId: string;
  toStageId: string;
  toStageName: string;
  actorUserId: string | null;
  actorName: string | null;
  enteredAt: Date | null;
  exitedAt: Date;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface DealActivityItem {
  id: string;
  kind: string;
  subject: string;
  body: string;
  status: string;
  dueAt: Date | null;
  actorName: string | null;
  createdAt: Date;
}

export interface DealDetail {
  deal: Deal;
  customer: Record<string, unknown>;
  transitions: StageTransition[];
  activities: DealActivityItem[];
  documents: DocumentItem[];
  pipeline: Pipeline | null;
}

export interface Board {
  pipeline: Pipeline;
  columns: { stage: Stage; deals: Deal[] }[];
}

export interface CreateDealInput {
  customerId: string;
  title: string;
  ownerUserId?: string | undefined;
  teamId?: string | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  value?: number | undefined;
  currency: string;
  probability?: number | undefined;
  expectedCloseAt?: string | undefined;
  source: string;
  priority: string;
  notes: string;
  fieldValues?: Record<string, unknown> | undefined;
}

export interface UpdateDealInput {
  title?: string | undefined;
  ownerUserId?: string | undefined;
  teamId?: string | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  value?: number | undefined;
  currency?: string | undefined;
  probability?: number | undefined;
  expectedCloseAt?: string | undefined;
  clearCloseDate: boolean;
  source?: string | undefined;
  priority?: string | undefined;
  notes?: string | undefined;
  fieldValues?: Record<string, unknown> | undefined;
  status?: string | undefined;
}

export interface MoveDealInput {
  stageId: string;
  pipelineId: string;
  force: boolean;
  lostReason: string;
  nextActivity?: NextActivityInput | undefined;
}

export interface DealListFilter {
  pipelineId: string;
  search: string;
  teamId: string;
  status: string;
  attention: string;
  limit: number;
  offset: number;
  scope: Visibility;
}

/** Deal fields followed by the follow-up hint; nextActivityId is omitempty. */
export type MoveResult = Deal & { needsNextActivity: boolean; nextActivityId?: string };

export interface FollowUpScheduler {
  scheduleFollowUp(actorId: string, in_: FollowUpRequest, meta: RequestMeta): Promise<string>;
}

type DealRow = Omit<Deal, "attention" | "fieldValues"> & { fieldValues: unknown; slaHours: number | null };

const DEAL_KEYS: (keyof Deal)[] = [
  "id", "title", "customerId", "customerName", "ownerUserId", "ownerName", "teamId", "teamName", "pipelineId",
  "pipelineName", "stageId", "stageName", "stageAccent", "value", "currency", "probability", "expectedCloseAt",
  "source", "priority", "status", "lostReason", "notes", "fieldValues", "lastActivityAt", "nextActivityAt",
  "stageEnteredAt", "ageDays", "daysInStage", "attention", "createdAt", "updatedAt",
];

const dealSelect = sql`
  SELECT d.id::text AS "id", d.title, d.customer_id::text AS "customerId", c.full_name AS "customerName",
    d.owner_user_id::text AS "ownerUserId", ou.full_name AS "ownerName", d.team_id::text AS "teamId", t.name AS "teamName",
    d.pipeline_id::text AS "pipelineId", p.name AS "pipelineName", d.stage_id::text AS "stageId", ps.name AS "stageName",
    ps.visual_accent AS "stageAccent",
    d.value, d.currency, d.probability,
    CASE WHEN d.expected_close_at IS NULL THEN NULL ELSE to_char(d.expected_close_at, 'YYYY-MM-DD') END AS "expectedCloseAt",
    d.source, d.priority, d.status, d.lost_reason AS "lostReason", d.notes, d.field_values AS "fieldValues",
    d.last_activity_at AS "lastActivityAt", d.next_activity_at AS "nextActivityAt", d.stage_entered_at AS "stageEnteredAt",
    EXTRACT(DAY FROM NOW() - d.created_at)::int AS "ageDays",
    EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS "daysInStage",
    ps.sla_hours AS "slaHours", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM deals d
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN users ou ON ou.id = d.owner_user_id
  LEFT JOIN teams t ON t.id = d.team_id
  LEFT JOIN pipelines p ON p.id = d.pipeline_id
  LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id`;

function toDeal(r: DealRow): Deal {
  const d: Deal = {
    ...r,
    fieldValues: goMapOrNull(r.fieldValues),
    attention: computeAttention({
      closed: r.status !== "open",
      next: r.nextActivityAt,
      last: r.lastActivityAt,
      anchor: r.stageEnteredAt,
      createdAt: r.createdAt,
      slaHours: r.slaHours,
    }),
  };
  return Object.fromEntries(DEAL_KEYS.map((k) => [k, d[k]])) as unknown as Deal;
}

const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v : null);

/** Go's time.Parse("2006-01-02") on the trimmed value; the canonical string is what gets stored. */
function parseCloseDate(v: string): string {
  const s = v.trim();
  if (!parseDateOnly(s)) throw AppError.validation("invalid expectedCloseAt");
  return s;
}

export class DealsRepository {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Deal | null> {
    const r = await sql<DealRow>`${dealSelect} WHERE d.id=${id}`.execute(this.db);
    return r.rows[0] ? toDeal(r.rows[0]) : null;
  }

  async list(f: DealListFilter): Promise<{ items: Deal[]; total: number }> {
    const limit = f.limit <= 0 ? 50 : f.limit;
    let where: Predicate[] = [];
    if (f.pipelineId !== "") where.push(sql`d.pipeline_id::text = ${f.pipelineId}`);
    if (f.teamId !== "") where.push(sql`d.team_id::text = ${f.teamId}`);
    if (f.status !== "" && f.status !== "all") where.push(sql`d.status = ${f.status}`);
    else if (f.status !== "all") where.push(sql`d.status = 'open'`);
    if (f.attention !== "") where.push(sql`(${sql.raw(AttentionSql.deal)}) = ${f.attention}`);
    if (f.search !== "") {
      const like = `%${f.search.toLowerCase()}%`;
      where.push(sql`(lower(d.title) LIKE ${like} OR lower(c.full_name) LIKE ${like})`);
    }
    where = appendScope(where, f.scope, Records.Deals.columns);
    const count = await sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM deals d JOIN customers c ON c.id = d.customer_id
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id WHERE ${and(where)}`.execute(this.db);
    const rows = await sql<DealRow>`
      ${dealSelect} WHERE ${and(where)}
      ORDER BY d.updated_at DESC LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return { items: rows.rows.map(toDeal), total: count.rows[0]?.total ?? 0 };
  }

  async board(pipelineId: string, scope: Visibility): Promise<Deal[]> {
    const where = appendScope(
      [sql`d.pipeline_id::text = ${pipelineId}`, sql`d.status IN ('open', 'won', 'lost')`],
      scope,
      Records.Deals.columns,
    );
    const r = await sql<DealRow>`
      ${dealSelect} WHERE ${and(where)}
      ORDER BY d.stage_entered_at ASC, d.created_at ASC`.execute(this.db);
    return r.rows.map(toDeal);
  }

  async create(in_: CreateDealInput, closeDate: string | null, fieldJson: string): Promise<Deal | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO deals (
        id, customer_id, title, owner_user_id, team_id, pipeline_id, stage_id,
        value, currency, probability, expected_close_at, source, priority, notes,
        field_values, stage_entered_at
      ) VALUES (
        ${id}, ${in_.customerId}, ${in_.title.trim()}, ${blankToNull(in_.ownerUserId)}, ${blankToNull(in_.teamId)},
        ${blankToNull(in_.pipelineId)}, ${blankToNull(in_.stageId)},
        ${in_.value ?? null}, ${in_.currency || "AUD"}, ${in_.probability ?? null}, ${closeDate}::date,
        ${in_.source}, ${in_.priority || "medium"}, ${in_.notes}, ${fieldJson}::jsonb, NOW()
      )`.execute(this.db);
    if (in_.stageId) {
      await sql`
        INSERT INTO deal_stage_transitions (
          id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
          entered_at, exited_at, duration_seconds, metadata
        ) VALUES (${randomUUID()}, ${id}, NULL, NULL, ${in_.pipelineId || null}, ${in_.stageId},
          NULL, NOW(), 0, '{"kind":"created"}'::jsonb)`
        .execute(this.db)
        .catch(() => undefined);
    }
    return this.get(id);
  }

  async update(id: string, cur: Deal, in_: UpdateDealInput, closeDate: string | null | undefined, fieldJson: string | null): Promise<Deal | null> {
    const pickRef = (v: string | undefined, fallback: string | null) => (v !== undefined ? blankToNull(v) : fallback);
    await sql`
      UPDATE deals SET
        title=${in_.title !== undefined ? in_.title.trim() : cur.title},
        owner_user_id=${pickRef(in_.ownerUserId, cur.ownerUserId)}, team_id=${pickRef(in_.teamId, cur.teamId)},
        pipeline_id=${pickRef(in_.pipelineId, cur.pipelineId)}, stage_id=${pickRef(in_.stageId, cur.stageId)},
        value=${in_.value ?? cur.value}, currency=${in_.currency || cur.currency},
        probability=${in_.probability ?? cur.probability},
        expected_close_at=${closeDate === undefined ? cur.expectedCloseAt : closeDate}::date,
        source=${in_.source ?? cur.source}, priority=${in_.priority || cur.priority}, notes=${in_.notes ?? cur.notes},
        status=${in_.status || cur.status}, field_values=${fieldJson ?? JSON.stringify(cur.fieldValues)}::jsonb
      WHERE id=${id}`.execute(this.db);
    return this.get(id);
  }

  async moveTransactional(
    actorId: string,
    deal: Deal,
    toPipelineId: string,
    toStageId: string,
    toStage: Stage,
    probability: number,
    lostReasonIn: string,
  ): Promise<Deal | null> {
    const now = new Date();
    const entered = deal.stageEnteredAt;
    const duration = Math.trunc((now.getTime() - entered.getTime()) / 1000);
    let status = deal.status;
    let lostReason = deal.lostReason;
    if (toStage.isWon) {
      status = "won";
      lostReason = "";
    } else if (toStage.isLost) {
      status = "lost";
      const reason = lostReasonIn.trim();
      if (reason !== "") lostReason = reason;
    } else if (status === "won" || status === "lost") {
      status = "open";
      lostReason = "";
    }
    const meta = JSON.stringify({ fromStageId: deal.stageId, lostReason, toStageId, toStageName: toStage.name });

    await this.db.transaction().execute(async (tx) => {
      await sql`
        UPDATE deals SET
          pipeline_id=${toPipelineId}, stage_id=${toStageId}, probability=${probability}, status=${status},
          stage_entered_at=${now}, lost_reason=${lostReason}
        WHERE id=${deal.id}`.execute(tx);
      await sql`
        INSERT INTO deal_stage_transitions (
          id, deal_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
          actor_user_id, entered_at, exited_at, duration_seconds, metadata
        ) VALUES (${randomUUID()}, ${deal.id}, ${deal.pipelineId || null}, ${deal.stageId || null},
          ${toPipelineId}, ${toStageId}, ${actorId}, ${entered}, ${now}, ${duration}, ${meta}::jsonb)`.execute(tx);
      await sql`
        INSERT INTO activities (id, kind, subject, body, status, completed_at, actor_user_id, deal_id, customer_id, metadata)
        VALUES (${randomUUID()}, 'stage_change', 'Stage changed', ${`Moved from ${deal.stageName ?? ""} to ${toStage.name}`},
          'completed', NOW(), ${actorId}, ${deal.id}, ${deal.customerId}, ${meta}::jsonb)`.execute(tx);
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id=${deal.id}`.execute(tx);
    });
    return this.get(deal.id);
  }

  async listTransitions(dealId: string): Promise<StageTransition[]> {
    const r = await sql<Omit<StageTransition, "metadata"> & { metadata: unknown }>`
      SELECT t.id::text AS "id", t.deal_id::text AS "dealId",
        t.from_pipeline_id::text AS "fromPipelineId", t.from_stage_id::text AS "fromStageId", fs.name AS "fromStageName",
        t.to_pipeline_id::text AS "toPipelineId", t.to_stage_id::text AS "toStageId", ts.name AS "toStageName",
        t.actor_user_id::text AS "actorUserId", u.full_name AS "actorName",
        t.entered_at AS "enteredAt", t.exited_at AS "exitedAt", t.duration_seconds AS "durationSeconds",
        t.metadata, t.created_at AS "createdAt"
      FROM deal_stage_transitions t
      LEFT JOIN pipeline_stages fs ON fs.id = t.from_stage_id
      LEFT JOIN pipeline_stages ts ON ts.id = t.to_stage_id
      LEFT JOIN users u ON u.id = t.actor_user_id
      WHERE t.deal_id = ${dealId}
      ORDER BY t.created_at DESC`.execute(this.db);
    return r.rows.map((t) => ({ ...t, metadata: goMapOrNull(t.metadata) }));
  }

  async listActivities(dealId: string): Promise<DealActivityItem[]> {
    const r = await sql<DealActivityItem>`
      SELECT a.id::text AS "id", a.kind, a.subject, a.body, a.status, a.due_at AS "dueAt", u.full_name AS "actorName",
        a.created_at AS "createdAt"
      FROM activities a
      LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.deal_id = ${dealId}
      ORDER BY a.created_at DESC
      LIMIT 100`.execute(this.db);
    return r.rows;
  }

  async listDocuments(dealId: string): Promise<DocumentItem[]> {
    const r = await sql<DocumentItem>`
      SELECT d.id::text AS "id", d.name, d.doc_type AS "type", d.category, d.status, d.mime_type AS "mimeType",
        d.size_bytes AS "sizeBytes", ub.full_name AS "uploadedByName", vb.full_name AS "verifiedByName",
        d.requested_at AS "requestedDate", d.uploaded_at AS "uploadedDate", d.expires_at AS "expiryDate", d.created_at AS "createdAt"
      FROM documents d
      LEFT JOIN users ub ON ub.id = d.uploaded_by
      LEFT JOIN users vb ON vb.id = d.verified_by
      WHERE d.deal_id = ${dealId}
      ORDER BY COALESCE(d.uploaded_at, d.requested_at, d.created_at) DESC`.execute(this.db);
    return r.rows;
  }

  /** Keys in Go's sorted map order. */
  async customerSnapshot(customerId: string): Promise<Record<string, unknown>> {
    const r = await sql<{ id: string; fullName: string; email: string | null; phone: string | null }>`
      SELECT id::text AS "id", full_name AS "fullName", email, phone FROM customers WHERE id=${customerId}`.execute(this.db);
    const c = r.rows[0];
    if (!c) throw new Error("customer not found");
    return { email: c.email, fullName: c.fullName, id: c.id, phone: c.phone };
  }

  async missingRequiredActivities(dealId: string, kinds: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const kind of kinds) {
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS(SELECT 1 FROM activities WHERE deal_id=${dealId} AND kind=${kind} AND status='completed') AS ok`.execute(this.db);
      if (r.rows[0]?.ok !== true) missing.push(kind);
    }
    return missing;
  }

  async missingRequiredDocuments(dealId: string, categories: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const cat of categories) {
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM documents
          WHERE deal_id=${dealId}
            AND (lower(category)=lower(${cat}) OR lower(doc_type)=lower(${cat}))
            AND status IN ('uploaded','verified')
        ) AS ok`.execute(this.db);
      if (r.rows[0]?.ok !== true) missing.push(cat);
    }
    return missing;
  }

  async addDocument(dealId: string, customerId: string, name: string, category: string, actorId: string): Promise<void> {
    await sql`
      INSERT INTO documents (id, name, category, uploaded_by, deal_id, customer_id)
      VALUES (${randomUUID()}, ${name}, ${category}, ${actorId}, ${dealId}, ${customerId})`.execute(this.db);
  }
}

/** Stage required-field keys that the deal leaves empty. */
export function missingRequiredFields(deal: Deal, fields: string[]): string[] {
  const missing: string[] = [];
  for (const f of fields) {
    const key = f.trim();
    if (key === "") continue;
    let ok: boolean;
    switch (key.toLowerCase()) {
      case "value":
        ok = deal.value !== null;
        break;
      case "expectedcloseat":
      case "expected_close_at":
        ok = deal.expectedCloseAt !== null && deal.expectedCloseAt !== "";
        break;
      case "source":
        ok = deal.source.trim() !== "";
        break;
      case "priority":
        ok = deal.priority.trim() !== "";
        break;
      case "notes":
        ok = deal.notes.trim() !== "";
        break;
      case "owner":
      case "owneruserid":
      case "owner_user_id":
        ok = deal.ownerUserId !== null && deal.ownerUserId !== "";
        break;
      default: {
        const fv = deal.fieldValues;
        const v = fv && Object.hasOwn(fv, key) ? fv[key] : undefined;
        ok = v !== undefined && v !== null && v !== "";
      }
    }
    if (!ok) missing.push(key);
  }
  return missing;
}

/** deals:edit data scope for a single move (on top of the route's record check). */
function assertMoveAllowed(claims: Claims, deal: Deal): void {
  const scope = effectiveScope(claims, P.DealsEdit);
  if (scope === "organization") return;
  if (scope === "team") {
    if (deal.teamId !== null && claims.teamIds.includes(deal.teamId)) return;
    if (deal.ownerUserId !== null) {
      if (claims.teamMemberUserIds.includes(deal.ownerUserId) || deal.ownerUserId === claims.userId) return;
    }
    throw AppError.forbidden("deal is outside your team scope");
  }
  if (deal.ownerUserId !== null && deal.ownerUserId === claims.userId) return;
  throw AppError.forbidden("can only move your own deals");
}

export class DealsService {
  readonly repo: DealsRepository;

  constructor(
    db: Database,
    private readonly pipelines: PipelinesService,
    private readonly audit: AuditService,
    private readonly hooks: AutomationEmitter,
    private readonly timeline: TimelineService,
    private readonly sysActivity: SystemActivityService,
    private readonly followUps: FollowUpScheduler,
  ) {
    this.repo = new DealsRepository(db);
  }

  async list(f: DealListFilter): Promise<{ items: Deal[]; total: number }> {
    if (!validAttention(f.attention)) throw AppError.validation("invalid attention");
    return internal("failed to list deals", () => this.repo.list(f));
  }

  async get(id: string): Promise<Deal> {
    const d = await internal("failed to load deal", () => this.repo.get(id));
    if (!d) throw AppError.notFound("deal not found");
    return d;
  }

  async getDetail(id: string): Promise<DealDetail> {
    const deal = await this.get(id);
    const customer = await internal("failed to load customer", () => this.repo.customerSnapshot(deal.customerId));
    const transitions = await internal("failed to load transitions", () => this.repo.listTransitions(id));
    const activities = await internal("failed to load activities", () => this.repo.listActivities(id));
    const documents = await internal("failed to load documents", () => this.repo.listDocuments(id));
    const pipeline = deal.pipelineId !== null ? await this.pipelines.get(deal.pipelineId) : null;
    return { deal, customer, transitions, activities, documents, pipeline };
  }

  async board(pipelineId: string, scope: Visibility): Promise<Board> {
    const pipeline = await this.pipelines.get(pipelineId);
    const deals = await internal("failed to load board", () => this.repo.board(pipelineId, scope));
    const byStage = new Map<string, Deal[]>();
    for (const d of deals) {
      const key = d.stageId ?? "";
      byStage.set(key, [...(byStage.get(key) ?? []), d]);
    }
    const columns = pipeline.stages.filter((s) => s.isActive).map((stage) => ({ stage, deals: byStage.get(stage.id) ?? [] }));
    return { pipeline, columns };
  }

  async create(actorId: string, in_: CreateDealInput, meta: RequestMeta): Promise<Deal> {
    if (in_.customerId.trim() === "" || in_.title.trim() === "") {
      throw AppError.validation("customerId and title are required");
    }
    const input = { ...in_ };
    if (input.pipelineId && input.stageId) {
      const { pipelineId, stageId } = input;
      const ok = await internal("failed to validate stage", () => this.pipelines.repo.stageBelongsToPipeline(stageId, pipelineId));
      if (!ok) throw AppError.validation("stage does not belong to pipeline or is inactive");
      const st = await internal("failed to load stage", () => this.pipelines.repo.getStage(stageId));
      if (input.probability === undefined && st) input.probability = st.probability;
    }
    let closeDate: string | null = null;
    if (input.expectedCloseAt !== undefined && input.expectedCloseAt.trim() !== "") {
      closeDate = parseCloseDate(input.expectedCloseAt);
    }
    const fieldJson = JSON.stringify(input.fieldValues ?? {});
    const d = await internal("failed to create deal", async () => {
      const row = await this.repo.create(input, closeDate, fieldJson);
      if (!row) throw new Error("created deal not found");
      return row;
    });
    await this.audit.record(
      actorId,
      "deal.created",
      "deal",
      d.id,
      { customerId: d.customerId, title: d.title, pipelineId: d.pipelineId, stageId: d.stageId },
      meta,
    );
    await this.hooks.emit(AutomationEvent.DealCreated, "deal", d.id, { customerId: d.customerId, title: d.title });
    await this.timeline.record({
      eventType: TimelineEvent.DealCreated,
      title: "Deal created",
      body: d.title,
      actorUserId: actorId,
      source: "crm",
      customerId: d.customerId,
      dealId: d.id,
    });
    await this.timeline.record({
      eventType: TimelineEvent.Automation,
      title: "Automation event",
      body: "deal.created",
      actorUserId: actorId,
      source: "automation",
      customerId: d.customerId,
      dealId: d.id,
      metadata: { event: AutomationEvent.DealCreated },
    });
    await this.sysActivity.record({
      eventType: "deal.created",
      title: "Deal created",
      actorUserId: actorId,
      entityType: "deal",
      entityId: d.id,
      entityLabel: d.title,
      metadata: { customerId: d.customerId },
    });
    return d;
  }

  async update(actorId: string, id: string, in_: UpdateDealInput, meta: RequestMeta): Promise<Deal> {
    const cur = await this.get(id);
    if (in_.pipelineId && in_.stageId) {
      const { pipelineId, stageId } = in_;
      const ok = await internal("failed to validate stage", () => this.pipelines.repo.stageBelongsToPipeline(stageId, pipelineId));
      if (!ok) throw AppError.validation("stage does not belong to pipeline or is inactive");
    }
    let closeDate: string | null | undefined;
    if (in_.clearCloseDate) closeDate = null;
    else if (in_.expectedCloseAt !== undefined) {
      closeDate = in_.expectedCloseAt.trim() === "" ? null : parseCloseDate(in_.expectedCloseAt);
    }
    const fieldJson = in_.fieldValues !== undefined ? JSON.stringify(in_.fieldValues) : null;
    const d = await internal("failed to update deal", async () => {
      const row = await this.repo.update(id, cur, in_, closeDate, fieldJson);
      if (!row) throw new Error("updated deal not found");
      return row;
    });
    await this.audit.record(actorId, "deal.updated", "deal", id, { title: d.title }, meta);
    await this.hooks.emit(AutomationEvent.DealUpdated, "deal", id, { title: d.title });
    return d;
  }

  async move(claims: Claims, id: string, in_: MoveDealInput, meta: RequestMeta): Promise<MoveResult> {
    const actorId = claims.userId;
    const deal = await this.get(id);
    assertMoveAllowed(claims, deal);
    if (in_.stageId.trim() === "") throw AppError.validation("stageId is required");
    const toStage = await internal("failed to load target stage", () => this.pipelines.repo.getStage(in_.stageId));
    if (!toStage || !toStage.isActive) throw AppError.validation("target stage is invalid or inactive");
    const pipelineId = in_.pipelineId || toStage.pipelineId;
    if (pipelineId !== toStage.pipelineId) throw AppError.validation("stage does not belong to the specified pipeline");
    if (deal.pipelineId && deal.pipelineId !== pipelineId) {
      throw AppError.validation("cannot move deal across pipelines via board move");
    }
    const ok = await internal("failed to validate stage", () => this.pipelines.repo.stageBelongsToPipeline(in_.stageId, pipelineId));
    if (!ok) throw AppError.validation("target stage is invalid or inactive");

    if (deal.stageId === in_.stageId) return { ...deal, needsNextActivity: false };

    if (!in_.force) {
      const missingFields = missingRequiredFields(deal, toStage.requiredFields);
      const missingActivities = await internal("failed to check required activities", () =>
        this.repo.missingRequiredActivities(deal.id, toStage.requiredActivities),
      );
      const missingDocuments = await internal("failed to check required documents", () =>
        this.repo.missingRequiredDocuments(deal.id, toStage.requiredDocuments),
      );
      if (missingFields.length > 0 || missingActivities.length > 0 || missingDocuments.length > 0) {
        throw AppError.validation("Stage requirements not met", {
          missingActivities,
          missingDocuments,
          missingFields,
          stageId: toStage.id,
          stageName: toStage.name,
        });
      }
    }
    if (toStage.isLost && in_.lostReason.trim() === "") throw AppError.validation("lost reason is required");

    const d = await internal("failed to move deal", async () => {
      const row = await this.repo.moveTransactional(actorId, deal, pipelineId, in_.stageId, toStage, toStage.probability, in_.lostReason);
      if (!row) throw new Error("moved deal not found");
      return row;
    });
    await this.audit.record(
      actorId,
      "deal.stage_changed",
      "deal",
      id,
      {
        fromStageId: deal.stageId,
        toStageId: in_.stageId,
        toStageName: toStage.name,
        forced: in_.force,
        lostReason: in_.lostReason,
        status: d.status,
      },
      meta,
    );
    await this.hooks.emit(AutomationEvent.DealStageChanged, "deal", id, {
      fromStageId: deal.stageId,
      toStageId: in_.stageId,
      pipelineId,
      status: d.status,
    });
    await this.timeline.record({
      eventType: TimelineEvent.StageChange,
      title: "Stage change",
      body: toStage.name,
      actorUserId: actorId,
      source: "crm",
      customerId: deal.customerId,
      dealId: id,
      metadata: {
        fromStageId: deal.stageId,
        toStageId: in_.stageId,
        toStageName: toStage.name,
        forced: in_.force,
        lostReason: in_.lostReason,
        status: d.status,
      },
    });
    await this.timeline.record({
      eventType: TimelineEvent.Automation,
      title: "Automation event",
      body: "deal.stage_changed",
      actorUserId: actorId,
      source: "automation",
      customerId: deal.customerId,
      dealId: id,
      metadata: { event: AutomationEvent.DealStageChanged, toStageId: in_.stageId },
    });
    return this.finishMove(actorId, d, in_, meta);
  }

  private async finishMove(actorId: string, deal: Deal, in_: MoveDealInput, meta: RequestMeta): Promise<MoveResult> {
    let d = deal;
    let nextActivityId: string | undefined;
    if (d.status === "open" && in_.nextActivity && in_.nextActivity.dueAt.trim() !== "") {
      nextActivityId = await this.followUps
        .scheduleFollowUp(actorId, { next: in_.nextActivity, customerId: d.customerId, dealId: d.id }, meta)
        .catch(() => undefined);
      if (nextActivityId !== undefined) {
        const fresh = await this.repo.get(d.id).catch(() => null);
        if (fresh) d = fresh;
      }
    }
    const needs = d.status === "open" && (d.nextActivityAt === null || d.nextActivityAt.getTime() <= Date.now());
    return { ...d, needsNextActivity: needs, ...(nextActivityId !== undefined ? { nextActivityId } : {}) };
  }

  /** Helper for the future upload flow: records a document against the deal and its customer. */
  async addDocument(actorId: string, dealId: string, name: string, category: string): Promise<void> {
    const d = await this.get(dealId);
    await this.repo.addDocument(dealId, d.customerId, name, category, actorId);
  }
}
