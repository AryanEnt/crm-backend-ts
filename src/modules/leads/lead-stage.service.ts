import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import type { FollowUpRequest, NextActivityInput } from "../activities/activities.service.js";
import type { Claims } from "../auth/types.js";
import { AutomationEvent } from "../automation/emitter.js";
import { and, appendScope, effectiveScope, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import type { Pipeline, PipelinesRepository, Stage } from "../pipelines/pipelines.service.js";
import { TimelineEvent, TimelineService } from "../timeline/timeline.service.js";

/** The lead fields stage requirements and move rules look at. */
export interface MovableLead {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  ownerUserId: string | null;
  teamId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  stageName: string | null;
  source: string;
  priority: string;
  notes: string;
  employer: string;
  potentialValue: number | null;
  expectedCloseAt: string | null;
  status: string;
  isArchived: boolean;
  stageEnteredAt: Date | null;
  createdAt: Date;
}

export interface MoveLeadInput {
  stageId: string;
  /** Only needed to move the lead into a different pipeline on purpose. */
  pipelineId?: string | undefined;
  force?: boolean | undefined;
  /** Required to move a Won or Lost lead anywhere else. */
  reopen?: boolean | undefined;
  lostReason?: string | undefined;
  nextActivity?: NextActivityInput | undefined;
}

export interface MoveOutcome {
  leadId: string;
  changed: boolean;
  status: string;
  needsNextActivity: boolean;
  nextActivityId?: string;
}

export interface FollowUpScheduler {
  scheduleFollowUp(actorId: string, in_: FollowUpRequest, meta: RequestMeta): Promise<string>;
}

/** Who is moving the lead; automation runs without a request or user scope. */
export type MoveActor = { kind: "user"; claims: Claims } | { kind: "automation"; actorUserId: string | null };

export interface BoardCard {
  id: string;
  fullName: string;
  employer: string;
  phone: string | null;
  email: string | null;
  potentialValue: number | null;
  currency: string;
  stageId: string | null;
  status: string;
  ownerUserId: string | null;
  ownerName: string | null;
  priority: string;
  tags: string[];
  lastActivityAt: Date | null;
  nextActivityAt: Date | null;
  nextActivityTitle: string | null;
  nextActivityType: string | null;
  expectedCloseAt: string | null;
  stageEnteredAt: Date;
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string;
}

export interface BoardStage {
  id: string;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  probability: number;
  visualAccent: string;
  requiredFields: string[];
  requiredActivities: string[];
  requiredDocuments: string[];
  count: number;
  totalValue: number;
  hasMore: boolean;
  leads: BoardCard[];
}

export interface LeadBoard {
  pipeline: Pick<Pipeline, "id" | "name" | "kind" | "isDefault">;
  stages: BoardStage[];
}

export interface BoardFilter {
  pipelineId: string;
  search: string;
  ownerUserId: string;
  /** Narrows org-wide viewers to one team; scoped viewers are already limited by `scope`. */
  teamId?: string;
  priority: string;
  source: string;
  tag: string;
  /** overdue | today | week | none | scheduled */
  activity: string;
  minValue?: number | null;
  maxValue?: number | null;
  scope: Visibility;
  /** Cards per stage. */
  limit: number;
}

export const BOARD_DEFAULT_LIMIT = 25;
export const BOARD_MAX_LIMIT = 100;
const VALID_ACTIVITY_FILTERS = new Set(["", "overdue", "today", "week", "none", "scheduled"]);

/** Potential-value bounds shared by the lead list and the board; a bound excludes leads with no value. */
export function leadValuePredicates(minValue?: number | null, maxValue?: number | null): Predicate[] {
  const out: Predicate[] = [];
  if (minValue != null) out.push(sql`l.potential_value >= ${minValue}`);
  if (maxValue != null) out.push(sql`l.potential_value <= ${maxValue}`);
  return out;
}
const CLOSED_STATUSES = new Set(["won", "lost"]);

/** Next-activity filter shared by the board and the list; throws on an unknown value. */
export function leadActivityPredicate(activity: string): Predicate | null {
  if (!VALID_ACTIVITY_FILTERS.has(activity)) throw AppError.validation("invalid activity filter");
  switch (activity) {
    case "overdue":
      return sql`l.next_activity_at < NOW()`;
    case "today":
      return sql`l.next_activity_at >= date_trunc('day', NOW()) AND l.next_activity_at < date_trunc('day', NOW()) + INTERVAL '1 day'`;
    case "week":
      return sql`l.next_activity_at >= date_trunc('day', NOW()) AND l.next_activity_at < date_trunc('day', NOW()) + INTERVAL '7 days'`;
    case "none":
      return sql`l.next_activity_at IS NULL`;
    case "scheduled":
      return sql`l.next_activity_at >= NOW()`;
    default:
      return null;
  }
}

const clampLimit = (n: number) => (n <= 0 ? BOARD_DEFAULT_LIMIT : Math.min(n, BOARD_MAX_LIMIT));

/** Stage required-field keys the lead leaves empty; unknown keys are lead custom fields. */
export function missingLeadFields(lead: MovableLead, fields: string[], customValues: Map<string, boolean>): string[] {
  const missing: string[] = [];
  for (const f of fields) {
    const key = f.trim();
    if (key === "") continue;
    let ok: boolean;
    switch (key.toLowerCase()) {
      case "value":
      case "potentialvalue":
      case "potential_value":
        ok = lead.potentialValue !== null;
        break;
      case "expectedcloseat":
      case "expected_close_at":
        ok = lead.expectedCloseAt !== null && lead.expectedCloseAt !== "";
        break;
      case "source":
        ok = lead.source.trim() !== "";
        break;
      case "priority":
        ok = lead.priority.trim() !== "";
        break;
      case "notes":
        ok = lead.notes.trim() !== "";
        break;
      case "email":
        ok = (lead.email ?? "") !== "";
        break;
      case "phone":
        ok = (lead.phone ?? "") !== "";
        break;
      case "employer":
      case "company":
        ok = lead.employer.trim() !== "";
        break;
      case "owner":
      case "owneruserid":
      case "owner_user_id":
        ok = (lead.ownerUserId ?? "") !== "";
        break;
      default:
        ok = customValues.get(key) === true;
    }
    if (!ok) missing.push(key);
  }
  return missing;
}

/** leads:edit data scope for a single lead, on top of the route's record check. */
export function assertLeadEditable(claims: Claims, lead: MovableLead): void {
  const scope = effectiveScope(claims, P.LeadsEdit);
  if (scope === "organization") return;
  if (scope === "team") {
    if (lead.teamId !== null && claims.teamIds.includes(lead.teamId)) return;
    if (lead.ownerUserId !== null && (claims.teamMemberUserIds.includes(lead.ownerUserId) || lead.ownerUserId === claims.userId)) {
      return;
    }
    throw AppError.forbidden("lead is outside your team scope");
  }
  if (lead.ownerUserId !== null && lead.ownerUserId === claims.userId) return;
  throw AppError.forbidden("can only move your own leads");
}

/** The status a lead takes when it lands in stage. */
export function statusForStage(stage: Pick<Stage, "isWon" | "isLost">, lead: Pick<MovableLead, "status" | "isArchived">): string {
  if (stage.isWon) return "won";
  if (stage.isLost) return "lost";
  return lead.isArchived ? lead.status : "open";
}

interface MovePlan {
  lead: MovableLead;
  toPipelineId: string;
  toStage: Stage;
  status: string;
  lostReason: string;
  forced: boolean;
  reopened: boolean;
}

const MOVABLE_SELECT = sql`
  SELECT l.id::text AS "id", l.full_name AS "fullName", l.email, l.phone, l.owner_user_id::text AS "ownerUserId",
    l.team_id::text AS "teamId", l.pipeline_id::text AS "pipelineId", l.stage_id::text AS "stageId", ps.name AS "stageName",
    l.source, l.priority, l.notes, l.employer, l.potential_value AS "potentialValue",
    CASE WHEN l.expected_close_at IS NULL THEN NULL ELSE to_char(l.expected_close_at, 'YYYY-MM-DD') END AS "expectedCloseAt",
    l.status, l.is_archived AS "isArchived", l.stage_entered_at AS "stageEnteredAt", l.created_at AS "createdAt"
  FROM leads l
  LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id`;

/**
 * The single implementation of lead stage changes. Every path that changes leads.stage_id
 * (board move, PATCH, bulk stage, automation) goes through move().
 */
export class LeadStageService {
  constructor(
    private readonly db: Database,
    readonly pipelines: PipelinesRepository,
    private readonly followUps: FollowUpScheduler | null,
    private readonly wakeAutomation?: () => void,
  ) {}

  async loadMovable(id: string): Promise<MovableLead> {
    const r = await internal("failed to load lead", () => sql<MovableLead>`${MOVABLE_SELECT} WHERE l.id = ${id}`.execute(this.db));
    const lead = r.rows[0];
    if (!lead) throw AppError.notFound("lead not found");
    return lead;
  }

  /** Default lead pipeline and its first open stage, for new leads created without one. */
  async defaultPlacement(): Promise<{ pipelineId: string; stage: Stage } | null> {
    const r = await internal("failed to load default pipeline", () =>
      sql<{ id: string }>`
        SELECT id::text AS "id" FROM pipelines
        WHERE kind = 'leads' AND is_active
        ORDER BY is_default DESC, created_at
        LIMIT 1`.execute(this.db),
    );
    const pipelineId = r.rows[0]?.id;
    if (!pipelineId) return null;
    const stage = await this.firstOpenStage(pipelineId);
    return stage ? { pipelineId, stage } : null;
  }

  async firstOpenStage(pipelineId: string): Promise<Stage | null> {
    const p = await internal("failed to load pipeline", () => this.pipelines.get(pipelineId));
    return p?.stages.find((s) => s.isActive && !s.isWon && !s.isLost) ?? null;
  }

  /** Stage a new lead may be created in: active, in the pipeline, and not an outcome stage. */
  async validateInitialStage(pipelineId: string, stageId: string): Promise<Stage> {
    const st = await internal("failed to load stage", () => this.pipelines.getStage(stageId));
    if (!st || !st.isActive || st.pipelineId !== pipelineId) throw AppError.validation("stage does not belong to pipeline or is inactive");
    if (st.isWon || st.isLost) throw AppError.validation("new leads start in an open stage");
    return st;
  }

  /** Records the first stage entry of a freshly created lead (best effort, like the deal create). */
  async recordInitialStage(leadId: string, pipelineId: string, stage: Stage, actorUserId: string | null): Promise<void> {
    await sql`
      INSERT INTO lead_stage_transitions (id, lead_id, to_pipeline_id, to_stage_id, actor_user_id, metadata)
      VALUES (${randomUUID()}, ${leadId}, ${pipelineId}, ${stage.id}, ${actorUserId}, ${JSON.stringify({ kind: "created" })}::jsonb)`
      .execute(this.db)
      .catch(() => undefined);
  }

  /**
   * Validates a move without writing anything. `preview` lets PATCH check requirements against
   * the field values it is about to save in the same request.
   */
  async plan(actor: MoveActor, leadId: string, in_: MoveLeadInput, preview?: MovableLead): Promise<MovePlan | null> {
    const lead = preview ?? (await this.loadMovable(leadId));
    if (actor.kind === "user") assertLeadEditable(actor.claims, lead);
    const stageId = in_.stageId.trim();
    if (stageId === "") throw AppError.validation("stageId is required");

    const toStage = await internal("failed to load target stage", () => this.pipelines.getStage(stageId));
    if (!toStage || !toStage.isActive) throw AppError.validation("target stage is invalid or inactive");
    const requestedPipeline = in_.pipelineId?.trim() ?? "";
    if (requestedPipeline !== "" && requestedPipeline !== toStage.pipelineId) {
      throw AppError.validation("stage does not belong to the specified pipeline");
    }
    const toPipelineId = toStage.pipelineId;
    // Changing pipelines is only allowed when the caller names the new pipeline explicitly.
    if (lead.pipelineId && lead.pipelineId !== toPipelineId && requestedPipeline === "") {
      throw AppError.validation("stage does not belong to the lead's pipeline");
    }

    if (lead.stageId === toStage.id) return null;

    const closed = CLOSED_STATUSES.has(lead.status);
    if (closed && !in_.reopen) {
      throw AppError.validation(`Lead is closed as ${lead.status === "won" ? "Won" : "Lost"}; reopen it to move`, {
        reason: "lead_closed",
        status: lead.status,
      });
    }

    const force = in_.force === true;
    if (!force) {
      const [customValues, missingActivities, missingDocuments] = await Promise.all([
        this.customFieldPresence(lead.id, toStage.requiredFields),
        this.missingActivities(lead.id, toStage.requiredActivities),
        this.missingDocuments(lead.id, toStage.requiredDocuments),
      ]);
      const missingFields = missingLeadFields(lead, toStage.requiredFields, customValues);
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
    const lostReason = (in_.lostReason ?? "").trim();
    if (toStage.isLost && lostReason === "") throw AppError.validation("lost reason is required");

    return {
      lead,
      toPipelineId,
      toStage,
      status: statusForStage(toStage, lead),
      lostReason: toStage.isLost ? lostReason : "",
      forced: force,
      reopened: closed,
    };
  }

  /** Applies a planned move; every write that must stay consistent shares one transaction. */
  async apply(actorUserId: string | null, plan: MovePlan, meta: RequestMeta, source: "crm" | "automation"): Promise<void> {
    const { lead, toPipelineId, toStage, status, lostReason } = plan;
    const now = new Date();
    const enteredPrev = lead.stageEnteredAt ?? lead.createdAt;
    const duration = Math.max(0, Math.trunc((now.getTime() - enteredPrev.getTime()) / 1000));
    const details = {
      fromStageId: lead.stageId,
      fromStageName: lead.stageName,
      toStageId: toStage.id,
      toStageName: toStage.name,
      pipelineId: toPipelineId,
      status,
      forced: plan.forced,
      reopened: plan.reopened,
      lostReason,
    };

    await internal("failed to move lead", () =>
      this.db.transaction().execute(async (tx) => {
        await sql`
          UPDATE leads SET
            pipeline_id = ${toPipelineId}, stage_id = ${toStage.id}, probability = ${toStage.probability},
            status = ${status}, stage_entered_at = ${now},
            won_at = CASE WHEN ${toStage.isWon}::bool THEN ${now}::timestamptz ELSE NULL END,
            lost_at = CASE WHEN ${toStage.isLost}::bool THEN ${now}::timestamptz ELSE NULL END,
            lost_reason = ${lostReason},
            last_activity_at = ${now}
          WHERE id = ${lead.id}`.execute(tx);
        await sql`
          INSERT INTO lead_stage_transitions (
            id, lead_id, from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
            actor_user_id, from_stage_entered_at, entered_at, duration_seconds, metadata
          ) VALUES (
            ${randomUUID()}, ${lead.id}, ${lead.pipelineId}, ${lead.stageId}, ${toPipelineId}, ${toStage.id},
            ${actorUserId}, ${lead.stageId ? enteredPrev : null}, ${now}, ${lead.stageId ? duration : null},
            ${JSON.stringify({ forced: plan.forced, reopened: plan.reopened, lostReason, source })}::jsonb
          )`.execute(tx);
        await new TimelineService(tx).write({
          eventType: TimelineEvent.StageChange,
          title: "Stage change",
          body: lead.stageName ? `${lead.stageName} → ${toStage.name}` : toStage.name,
          actorUserId,
          source,
          leadId: lead.id,
          metadata: details,
        });
        await tx
          .insertInto("audit_logs")
          .values({
            id: randomUUID(),
            actor_user_id: actorUserId,
            action: "lead.stage_changed",
            resource_type: "lead",
            resource_id: lead.id,
            metadata: JSON.stringify(details),
            ip_address: meta.ip,
            user_agent: meta.userAgent,
          })
          .execute();
        await tx
          .insertInto("automation_events")
          .values({
            id: randomUUID(),
            event_type: AutomationEvent.LeadStageChanged,
            resource_type: "lead",
            resource_id: lead.id,
            payload: JSON.stringify({
              fromStageId: lead.stageId,
              toStageId: toStage.id,
              stageId: toStage.id,
              pipelineId: toPipelineId,
              status,
              ...(source === "automation" ? { _suppressAutomation: true } : {}),
            }),
          })
          .execute();
      }),
    );
    this.wakeAutomation?.();
  }

  async move(actor: MoveActor, leadId: string, in_: MoveLeadInput, meta: RequestMeta): Promise<MoveOutcome> {
    const plan = await this.plan(actor, leadId, in_);
    const actorUserId = actor.kind === "user" ? actor.claims.userId : actor.actorUserId;
    if (plan) await this.apply(actorUserId, plan, meta, actor.kind === "user" ? "crm" : "automation");
    return this.finish(actorUserId, leadId, plan !== null, in_, meta);
  }

  /** Schedules the optional next activity and reports whether the lead still needs one. */
  async finish(actorUserId: string | null, leadId: string, changed: boolean, in_: MoveLeadInput, meta: RequestMeta): Promise<MoveOutcome> {
    let nextActivityId: string | undefined;
    let state = await this.nextState(leadId);
    if (state.status === "open" && actorUserId && this.followUps && in_.nextActivity && in_.nextActivity.dueAt.trim() !== "") {
      nextActivityId = await this.followUps
        .scheduleFollowUp(actorUserId, { next: in_.nextActivity, leadId }, meta)
        .catch(() => undefined);
      if (nextActivityId !== undefined) state = await this.nextState(leadId);
    }
    const needs = state.status === "open" && (state.nextActivityAt === null || state.nextActivityAt.getTime() <= Date.now());
    return {
      leadId,
      changed,
      status: state.status,
      needsNextActivity: needs,
      ...(nextActivityId !== undefined ? { nextActivityId } : {}),
    };
  }

  private async nextState(leadId: string): Promise<{ status: string; nextActivityAt: Date | null }> {
    const r = await internal("failed to load lead", () =>
      sql<{ status: string; nextActivityAt: Date | null }>`
        SELECT status, next_activity_at AS "nextActivityAt" FROM leads WHERE id = ${leadId}`.execute(this.db),
    );
    const row = r.rows[0];
    if (!row) throw AppError.notFound("lead not found");
    return row;
  }

  private async customFieldPresence(leadId: string, fields: string[]): Promise<Map<string, boolean>> {
    const keys = fields.map((f) => f.trim()).filter((f) => f !== "");
    const out = new Map<string, boolean>();
    if (keys.length === 0) return out;
    const r = await internal("failed to check required fields", () =>
      sql<{ key: string }>`
        SELECT f.internal_key AS "key"
        FROM custom_field_values v
        JOIN custom_fields f ON f.id = v.custom_field_id
        WHERE v.entity = 'lead' AND v.record_id = ${leadId} AND f.internal_key = ANY(${keys}::text[])
          AND (COALESCE(v.value_text, '') <> '' OR (v.value_json IS NOT NULL AND v.value_json <> 'null'::jsonb AND v.value_json <> '""'::jsonb))`.execute(
        this.db,
      ),
    );
    for (const row of r.rows) out.set(row.key, true);
    return out;
  }

  private async missingActivities(leadId: string, kinds: string[]): Promise<string[]> {
    if (kinds.length === 0) return [];
    const r = await internal("failed to check required activities", () =>
      sql<{ kind: string }>`
        SELECT DISTINCT k.kind FROM unnest(${kinds}::text[]) AS k(kind)
        WHERE EXISTS (
          SELECT 1 FROM activities a
          LEFT JOIN activity_types t ON t.id = a.activity_type_id
          WHERE a.lead_id = ${leadId} AND a.status = 'completed' AND (a.kind = k.kind OR t.code = k.kind)
        )`.execute(this.db),
    );
    const done = new Set(r.rows.map((x) => x.kind));
    return kinds.filter((k) => !done.has(k));
  }

  private async missingDocuments(leadId: string, categories: string[]): Promise<string[]> {
    if (categories.length === 0) return [];
    const r = await internal("failed to check required documents", () =>
      sql<{ cat: string }>`
        SELECT DISTINCT c.cat FROM unnest(${categories}::text[]) AS c(cat)
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.lead_id = ${leadId}
            AND (lower(d.category) = lower(c.cat) OR lower(d.doc_type) = lower(c.cat))
            AND d.status IN ('uploaded', 'verified')
        )`.execute(this.db),
    );
    const done = new Set(r.rows.map((x) => x.cat));
    return categories.filter((c) => !done.has(c));
  }

  // ---------------------------------------------------------------- board

  private boardWhere(f: Omit<BoardFilter, "limit">): Predicate[] {
    if (!VALID_ACTIVITY_FILTERS.has(f.activity)) throw AppError.validation("invalid activity filter");
    const where: Predicate[] = [sql`l.pipeline_id::text = ${f.pipelineId}`, sql`l.is_archived = FALSE`];
    if (f.search !== "") {
      const like = `%${f.search}%`;
      where.push(
        sql`(l.full_name ILIKE ${like} OR COALESCE(l.email,'') ILIKE ${like} OR COALESCE(l.phone,'') ILIKE ${like} OR l.employer ILIKE ${like})`,
      );
    }
    if (f.ownerUserId !== "") where.push(sql`l.owner_user_id::text = ${f.ownerUserId}`);
    if (f.teamId) where.push(sql`l.team_id::text = ${f.teamId}`);
    if (f.priority !== "") where.push(sql`l.priority = ${f.priority}`);
    if (f.source !== "") where.push(sql`l.source = ${f.source}`);
    if (f.tag !== "") where.push(sql`${f.tag} = ANY(l.tags)`);
    const activity = leadActivityPredicate(f.activity);
    if (activity) where.push(activity);
    where.push(...leadValuePredicates(f.minValue, f.maxValue));
    return appendScope(where, f.scope, Records.Leads.columns);
  }

  private async cards(where: Predicate[], perStage: number, offset: number): Promise<BoardCard[]> {
    const r = await sql<BoardCard & { rn: number }>`
      SELECT * FROM (
        SELECT l.id::text AS "id", l.full_name AS "fullName", l.employer, l.phone, l.email,
          l.potential_value AS "potentialValue", l.currency, l.stage_id::text AS "stageId", l.status,
          l.owner_user_id::text AS "ownerUserId", ou.full_name AS "ownerName", l.priority, COALESCE(l.tags, '{}') AS "tags",
          l.last_activity_at AS "lastActivityAt", l.next_activity_at AS "nextActivityAt",
          na.title AS "nextActivityTitle", na.type_code AS "nextActivityType",
          CASE WHEN l.expected_close_at IS NULL THEN NULL ELSE to_char(l.expected_close_at, 'YYYY-MM-DD') END AS "expectedCloseAt",
          COALESCE(l.stage_entered_at, l.created_at) AS "stageEnteredAt",
          l.won_at AS "wonAt", l.lost_at AS "lostAt", l.lost_reason AS "lostReason",
          ROW_NUMBER() OVER (
            PARTITION BY l.stage_id ORDER BY COALESCE(l.stage_entered_at, l.created_at) DESC, l.id
          ) AS rn
        FROM leads l
        LEFT JOIN users ou ON ou.id = l.owner_user_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(a.title, ''), NULLIF(a.subject, ''), t.name, 'Follow up') AS title, t.code AS type_code
          FROM activities a
          LEFT JOIN activity_types t ON t.id = a.activity_type_id
          WHERE a.lead_id = l.id AND a.status IN ('upcoming', 'due', 'overdue')
          ORDER BY a.due_at ASC NULLS LAST
          LIMIT 1
        ) na ON TRUE
        WHERE ${and(where)}
      ) ranked
      WHERE rn > ${offset} AND rn <= ${offset + perStage}
      ORDER BY rn`.execute(this.db);
    return r.rows.map(({ rn: _rn, ...card }) => card);
  }

  async board(f: BoardFilter): Promise<LeadBoard> {
    const pipeline = await internal("failed to load pipeline", () => this.pipelines.get(f.pipelineId));
    if (!pipeline) throw AppError.notFound("pipeline not found");
    if (pipeline.kind !== "leads") throw AppError.validation("pipeline is not a lead pipeline");
    const limit = clampLimit(f.limit);
    const where = this.boardWhere(f);

    const [totals, cards] = await Promise.all([
      internal("failed to load board", () =>
        sql<{ stageId: string | null; count: number; totalValue: number }>`
          SELECT l.stage_id::text AS "stageId", COUNT(*)::int AS "count", COALESCE(SUM(l.potential_value), 0) AS "totalValue"
          FROM leads l WHERE ${and(where)} GROUP BY l.stage_id`.execute(this.db),
      ),
      internal("failed to load board", () => this.cards(where, limit, 0)),
    ]);
    const totalsByStage = new Map(totals.rows.map((t) => [t.stageId ?? "", t]));
    const cardsByStage = new Map<string, BoardCard[]>();
    for (const c of cards) {
      const key = c.stageId ?? "";
      cardsByStage.set(key, [...(cardsByStage.get(key) ?? []), c]);
    }
    const stages = pipeline.stages
      .filter((s) => s.isActive)
      .map((s): BoardStage => {
        const t = totalsByStage.get(s.id);
        const leads = cardsByStage.get(s.id) ?? [];
        const count = t?.count ?? 0;
        return {
          id: s.id,
          name: s.name,
          position: s.position,
          isWon: s.isWon,
          isLost: s.isLost,
          probability: s.probability,
          visualAccent: s.visualAccent,
          requiredFields: s.requiredFields,
          requiredActivities: s.requiredActivities,
          requiredDocuments: s.requiredDocuments,
          count,
          totalValue: Number(t?.totalValue ?? 0),
          hasMore: count > leads.length,
          leads,
        };
      });
    return {
      pipeline: { id: pipeline.id, name: pipeline.name, kind: pipeline.kind, isDefault: pipeline.isDefault },
      stages,
    };
  }

  /** One more page of a single board column. */
  async boardStage(f: BoardFilter, stageId: string, offset: number): Promise<{ leads: BoardCard[]; hasMore: boolean }> {
    const limit = clampLimit(f.limit);
    const where = [...this.boardWhere(f), sql`l.stage_id::text = ${stageId}`];
    const leads = await internal("failed to load board", () => this.cards(where, limit + 1, Math.max(0, offset)));
    return { leads: leads.slice(0, limit), hasMore: leads.length > limit };
  }
}
