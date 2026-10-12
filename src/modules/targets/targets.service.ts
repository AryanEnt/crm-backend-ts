import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goFixed } from "../../lib/go-fmt.js";
import { parseDateOnly } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { isUuid } from "../../lib/uuid.js";
import { num, optionalNumber, optionalString, str } from "../../lib/validate.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import { effectiveScope, widestScope } from "../datascope/datascope.js";
import { P } from "../permissions/permissions.js";

export const Metric = {
  Leads: "leads",
  QualifiedLeads: "qualified_leads",
  Submissions: "submissions",
  PositiveOutcomes: "positive_outcomes",
  Conversions: "conversions",
  PipelineValue: "pipeline_value",
  Activities: "activities",
  WonRevenue: "won_revenue",
  LeadsWon: "leads_won",
  WonLeadValue: "won_lead_value",
  ProposalEntries: "proposal_entries",
  OpenLeadValue: "open_lead_value",
} as const;

const VALID_METRICS: string[] = Object.values(Metric);

/** Lead metrics first; deal-based metrics stay valid for existing targets and are marked legacy. */
export const METRICS_CATALOG = [
  { code: Metric.Leads, label: "Leads created" },
  { code: Metric.LeadsWon, label: "Leads won" },
  { code: Metric.WonLeadValue, label: "Won value" },
  { code: Metric.ProposalEntries, label: "Leads reaching Proposal" },
  { code: Metric.OpenLeadValue, label: "Open lead value" },
  { code: Metric.Activities, label: "Activities" },
  { code: Metric.QualifiedLeads, label: "Qualified leads", legacy: true },
  { code: Metric.Submissions, label: "Submissions (deals)", legacy: true },
  { code: Metric.PositiveOutcomes, label: "Deals won", legacy: true },
  { code: Metric.WonRevenue, label: "Won revenue (deals)", legacy: true },
  { code: Metric.Conversions, label: "Lead conversions", legacy: true },
  { code: Metric.PipelineValue, label: "Pipeline value (open deals)", legacy: true },
];

/**
 * When deal d was won: its latest move into a won stage. updated_at changes on every edit,
 * so it is only the fallback for deals marked won without a stage move.
 */
const dealWonAt = sql`COALESCE((
  SELECT MAX(t.exited_at) FROM deal_stage_transitions t
  JOIN pipeline_stages ps ON ps.id = t.to_stage_id
  WHERE t.deal_id = d.id AND ps.is_won
), d.updated_at)`;

/** Matches deal d to a team ('' means any team). Deals saved without a team count toward their owner's team. */
function dealInTeam(team: string) {
  return sql`(${team}='' OR d.team_id::text=${team} OR (d.team_id IS NULL AND EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id::text=${team} AND tm.user_id=d.owner_user_id
  )))`;
}

/** dealInTeam for lead l. */
function leadInTeam(team: string) {
  return sql`(${team}='' OR l.team_id::text=${team} OR (l.team_id IS NULL AND EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id::text=${team} AND tm.user_id=l.owner_user_id
  )))`;
}

const ScopeType = { Organization: "organization", Team: "team", User: "user" } as const;

export interface Target {
  id: string;
  name: string;
  metric: string;
  periodType: string;
  /** YYYY-MM-DD */
  periodStart: string;
  periodEnd: string;
  scopeType: string;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  targetValue: number;
  notes: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Progress {
  target: Target;
  actual: number;
  remaining: number;
  /** null when the target value is zero */
  progressPct: number | null;
  progressLabel: string;
  daysRemaining: number;
  periodElapsedPct: number | null;
  asOf: Date;
}

export const createSchema = z.strictObject({
  name: str(),
  metric: str(),
  periodType: str(),
  periodStart: str(),
  periodEnd: str(),
  scopeType: str(),
  teamId: optionalString(),
  userId: optionalString(),
  pipelineId: optionalString(),
  targetValue: num(),
  notes: str(),
});
export type CreateInput = z.output<typeof createSchema>;

export const updateSchema = z.strictObject({
  name: optionalString(),
  metric: optionalString(),
  periodType: optionalString(),
  periodStart: optionalString(),
  periodEnd: optionalString(),
  scopeType: optionalString(),
  teamId: optionalString(),
  userId: optionalString(),
  pipelineId: optionalString(),
  targetValue: optionalNumber(),
  notes: optionalString(),
});
export type UpdateInput = z.output<typeof updateSchema>;

export interface TargetListFilter {
  periodType: string;
  metric: string;
  scopeType: string;
  teamId: string;
  userId: string;
  pipelineId: string;
  from: string;
  to: string;
  limit: number;
  offset: number;
}

/** Targets a caller may see; anything else reads as not found. */
interface ReadScope {
  unscoped: boolean;
  teamIds: string[];
  userIds: string[];
}

const targetSelect = sql`
  SELECT t.id::text AS id, t.name, t.metric, t.period_type AS "periodType",
    t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd", t.scope_type AS "scopeType",
    t.team_id::text AS "teamId", tm.name AS "teamName", t.user_id::text AS "userId", u.full_name AS "userName",
    t.pipeline_id::text AS "pipelineId", p.name AS "pipelineName", t.target_value::float8 AS "targetValue", t.notes,
    t.created_by::text AS "createdBy", t.created_at AS "createdAt", t.updated_at AS "updatedAt"
  FROM targets t
  LEFT JOIN teams tm ON tm.id = t.team_id
  LEFT JOIN users u ON u.id = t.user_id
  LEFT JOIN pipelines p ON p.id = t.pipeline_id`;

/** Go emptyToNil: blank (after trimming) is NULL; anything else is stored untrimmed. */
const emptyToNil = (v: string | null | undefined): string | null => (v == null || v.trim() === "" ? null : v);

const isTeammate = (claims: Claims, userId: string) => userId === claims.userId || claims.teamMemberUserIds.includes(userId);

/**
 * Checks the caller may own a target with this scope and returns the team to store.
 * Team Leads (team-scoped targets:manage) are pinned to their team: a team target always
 * gets their team, and individual targets must name a teammate.
 */
export function authorizeWrite(
  claims: Claims,
  scopeType: string,
  teamId: string | null | undefined,
  userId: string | null | undefined,
): string | null | undefined {
  const scope = effectiveScope(claims, P.TargetsManage);
  if (scope === "organization") return teamId;
  if (scope !== "team") throw AppError.forbidden("you cannot manage targets");
  if (claims.teamIds.length === 0) throw AppError.forbidden("you are not assigned to a team");

  switch (scopeType) {
    case ScopeType.Team: {
      const requested = teamId?.trim() ?? "";
      if (requested === "") {
        if (claims.teamIds.length > 1) throw AppError.validation("teamId is required for team targets");
        return claims.teamIds[0]!;
      }
      if (!claims.teamIds.includes(requested)) throw AppError.forbidden("you can only set targets for your own team");
      return requested;
    }
    case ScopeType.User:
      if (userId != null && userId.trim() !== "" && !isTeammate(claims, userId.trim())) {
        throw AppError.forbidden("you can only set targets for members of your team");
      }
      return null;
    default:
      throw AppError.forbidden("organization targets can only be set by an administrator with organization scope");
  }
}

/** Checks the caller may change or delete t. */
export function authorizeExisting(claims: Claims, t: Target): void {
  const scope = effectiveScope(claims, P.TargetsManage);
  if (scope === "organization") return;
  if (scope !== "team") throw AppError.forbidden("you cannot manage targets");
  if (t.scopeType === ScopeType.Team && t.teamId !== null && claims.teamIds.includes(t.teamId)) return;
  if (t.scopeType === ScopeType.User && t.userId !== null && isTeammate(claims, t.userId)) return;
  throw AppError.forbidden("this target belongs to another team");
}

/**
 * Organization scope sees every target; team scope its teams' targets and teammates'
 * individual targets; own scope its teams' targets and its own. Organization targets
 * need organization scope.
 */
export function resolveRead(claims: Claims): ReadScope {
  switch (widestScope(claims, P.TargetsView, P.TargetsManage)) {
    case "organization":
      return { unscoped: true, teamIds: [], userIds: [] };
    case "team":
      return { unscoped: false, teamIds: claims.teamIds, userIds: [claims.userId, ...claims.teamMemberUserIds] };
    default:
      return { unscoped: false, teamIds: claims.teamIds, userIds: [claims.userId] };
  }
}

function allows(s: ReadScope, t: Target): boolean {
  if (s.unscoped) return true;
  if (t.scopeType === ScopeType.Team) return t.teamId !== null && s.teamIds.includes(t.teamId);
  if (t.scopeType === ScopeType.User) return t.userId !== null && s.userIds.includes(t.userId);
  return false;
}

export function validateInput(
  metric: string,
  periodType: string,
  scopeType: string,
  periodStart: string,
  periodEnd: string,
  teamId: string | null | undefined,
  userId: string | null | undefined,
  value: number,
): void {
  if (!VALID_METRICS.includes(metric)) throw AppError.validation("invalid metric");
  if (periodType !== "monthly" && periodType !== "quarterly") {
    throw AppError.validation("periodType must be monthly or quarterly");
  }
  if (scopeType !== ScopeType.Organization && scopeType !== ScopeType.Team && scopeType !== ScopeType.User) {
    throw AppError.validation("invalid scopeType");
  }
  if (!parseDateOnly(periodStart)) throw AppError.validation("invalid periodStart");
  if (!parseDateOnly(periodEnd)) throw AppError.validation("invalid periodEnd");
  if (periodEnd < periodStart) throw AppError.validation("periodEnd must be on or after periodStart");
  if (value < 0) throw AppError.validation("targetValue cannot be negative");
  if (scopeType === ScopeType.Team && (teamId == null || teamId.trim() === "")) {
    throw AppError.validation("teamId is required for team targets");
  }
  if (scopeType === ScopeType.User && (userId == null || userId.trim() === "")) {
    throw AppError.validation("userId is required for individual targets");
  }
}

/** Go math.Round(v*100)/100 (half away from zero). */
const round2 = (v: number) => (v < 0 ? -Math.round(-v * 100) : Math.round(v * 100)) / 100;

const DAY_MS = 86_400_000;
/** Go's endInclusive is one nanosecond short of the next midnight. */
const NS_MS = 1e-6;

const DEAL_METRICS = new Set<string>([Metric.Submissions, Metric.PositiveOutcomes, Metric.WonRevenue, Metric.PipelineValue]);

/** Pipeline kind a metric counts in: deal metrics read sales pipelines, activities either, the rest leads. */
export function pipelineKindFor(metric: string): "sales" | "leads" | null {
  if (metric === Metric.Activities) return null;
  return DEAL_METRICS.has(metric) ? "sales" : "leads";
}

export class TargetsRepository {
  constructor(private readonly db: Database) {}

  async pipelineKind(id: string): Promise<string | undefined> {
    const { rows } = await sql<{ kind: string }>`SELECT kind FROM pipelines WHERE id::text = ${id}`.execute(this.db);
    return rows[0]?.kind;
  }

  async get(id: string): Promise<Target | undefined> {
    const { rows } = await sql<Target>`${targetSelect} WHERE t.id = ${id}`.execute(this.db);
    return rows[0];
  }

  async list(f: TargetListFilter, scope: ReadScope): Promise<{ items: Target[]; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 50 : f.limit;
    const where = [sql`1=1`];
    if (f.periodType !== "") where.push(sql`t.period_type = ${f.periodType}`);
    if (f.metric !== "") where.push(sql`t.metric = ${f.metric}`);
    if (f.scopeType !== "") where.push(sql`t.scope_type = ${f.scopeType}`);
    if (f.teamId !== "") where.push(sql`t.team_id::text = ${f.teamId}`);
    if (f.userId !== "") where.push(sql`t.user_id::text = ${f.userId}`);
    if (f.pipelineId !== "") where.push(sql`t.pipeline_id::text = ${f.pipelineId}`);
    if (!scope.unscoped) {
      where.push(sql`((t.scope_type = 'team' AND t.team_id::text = ANY(${scope.teamIds}::text[]))
        OR (t.scope_type = 'user' AND t.user_id::text = ANY(${scope.userIds}::text[])))`);
    }
    if (f.from !== "") where.push(sql`t.period_end >= ${f.from}::date`);
    if (f.to !== "") where.push(sql`t.period_start <= ${f.to}::date`);
    const w = sql.join(where, sql` AND `);
    const { rows: count } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM targets t WHERE ${w}`.execute(this.db);
    const { rows } = await sql<Target>`
      ${targetSelect}
      WHERE ${w}
      ORDER BY t.period_start DESC, t.created_at DESC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return { items: rows, total: Number(count[0]!.n) };
  }

  async create(actorId: string, in_: CreateInput): Promise<Target | undefined> {
    const id = randomUUID();
    await sql`
      INSERT INTO targets (
        id, name, metric, period_type, period_start, period_end,
        scope_type, team_id, user_id, pipeline_id, target_value, notes, created_by
      ) VALUES (
        ${id}, ${in_.name.trim()}, ${in_.metric}, ${in_.periodType}, ${in_.periodStart}::date, ${in_.periodEnd}::date,
        ${in_.scopeType}, ${emptyToNil(in_.teamId)}, ${emptyToNil(in_.userId)}, ${emptyToNil(in_.pipelineId)},
        ${in_.targetValue}, ${in_.notes}, ${emptyToNil(actorId)}
      )`.execute(this.db);
    return this.get(id);
  }

  async update(id: string, cur: Target, in_: UpdateInput): Promise<Target | undefined> {
    const pick = <T>(v: T | undefined, fallback: T) => (v !== undefined ? v : fallback);
    const nullable = (v: string | undefined, fallback: string | null) => (v !== undefined ? emptyToNil(v) : fallback);
    await sql`
      UPDATE targets SET
        name = ${in_.name !== undefined ? in_.name.trim() : cur.name},
        metric = ${pick(in_.metric, cur.metric)},
        period_type = ${pick(in_.periodType, cur.periodType)},
        period_start = ${pick(in_.periodStart, cur.periodStart)}::date,
        period_end = ${pick(in_.periodEnd, cur.periodEnd)}::date,
        scope_type = ${pick(in_.scopeType, cur.scopeType)},
        team_id = ${nullable(in_.teamId, cur.teamId)},
        user_id = ${nullable(in_.userId, cur.userId)},
        pipeline_id = ${nullable(in_.pipelineId, cur.pipelineId)},
        target_value = ${pick(in_.targetValue, cur.targetValue)},
        notes = ${pick(in_.notes, cur.notes)}
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM targets WHERE id = ${id}`.execute(this.db);
  }

  /** The live actual for a target's metric, scope and period. */
  async computeActual(t: Target): Promise<number> {
    const from = t.periodStart;
    const to = t.periodEnd;
    const team = t.teamId ?? "";
    const user = t.userId ?? "";
    const pipe = t.pipelineId ?? "";
    let q;
    switch (t.metric) {
      case Metric.Leads:
        q = sql`
          SELECT COUNT(*)::float8 AS v FROM leads l
          WHERE l.is_archived=FALSE
            AND l.created_at::date >= ${from}::date AND l.created_at::date <= ${to}::date
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR l.pipeline_id::text=${pipe})`;
        break;
      case Metric.QualifiedLeads:
        q = sql`
          SELECT COUNT(*)::float8 AS v FROM leads l
          WHERE l.is_archived=FALSE
            AND l.status IN ('qualified','converted')
            AND l.created_at::date >= ${from}::date AND l.created_at::date <= ${to}::date
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR l.pipeline_id::text=${pipe})`;
        break;
      case Metric.Conversions:
        q = sql`
          SELECT COUNT(*)::float8 AS v FROM leads l
          WHERE l.is_archived=FALSE AND l.status='converted'
            AND COALESCE(l.converted_at::date, l.updated_at::date) >= ${from}::date
            AND COALESCE(l.converted_at::date, l.updated_at::date) <= ${to}::date
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR l.pipeline_id::text=${pipe})`;
        break;
      case Metric.PositiveOutcomes:
      case Metric.WonRevenue: {
        const measure = t.metric === Metric.WonRevenue ? sql`COALESCE(SUM(d.value),0)` : sql`COUNT(*)`;
        q = sql`
          SELECT ${measure}::float8 AS v FROM deals d
          WHERE d.status='won'
            AND (${dealWonAt})::date >= ${from}::date AND (${dealWonAt})::date <= ${to}::date
            AND ${dealInTeam(team)}
            AND (${user}='' OR d.owner_user_id::text=${user})
            AND (${pipe}='' OR d.pipeline_id::text=${pipe})`;
        break;
      }
      case Metric.Submissions:
        q = sql`
          SELECT COUNT(DISTINCT d.id)::float8 AS v FROM deals d
          WHERE d.created_at::date >= ${from}::date AND d.created_at::date <= ${to}::date
            AND ${dealInTeam(team)}
            AND (${user}='' OR d.owner_user_id::text=${user})
            AND (${pipe}='' OR d.pipeline_id::text=${pipe})
            AND EXISTS (
              SELECT 1 FROM deal_stage_transitions t
              JOIN pipeline_stages ps ON ps.id = t.to_stage_id
              WHERE t.deal_id = d.id
                AND (lower(ps.name) LIKE '%negotiat%' OR lower(ps.name) LIKE '%submit%' OR lower(ps.name) LIKE '%proposal%')
            )`;
        break;
      case Metric.PipelineValue:
        // A snapshot of open pipeline value for the scope, not a value over time.
        q = sql`
          SELECT COALESCE(SUM(d.value),0)::float8 AS v FROM deals d
          WHERE d.status='open'
            AND ${dealInTeam(team)}
            AND (${user}='' OR d.owner_user_id::text=${user})
            AND (${pipe}='' OR d.pipeline_id::text=${pipe})`;
        break;
      case Metric.LeadsWon:
      case Metric.WonLeadValue: {
        const measure = t.metric === Metric.WonLeadValue ? sql`COALESCE(SUM(l.potential_value),0)` : sql`COUNT(*)`;
        q = sql`
          SELECT ${measure}::float8 AS v FROM leads l
          WHERE l.is_archived=FALSE AND l.status='won' AND l.won_at IS NOT NULL
            AND l.won_at::date >= ${from}::date AND l.won_at::date <= ${to}::date
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR l.pipeline_id::text=${pipe})`;
        break;
      }
      case Metric.ProposalEntries:
        q = sql`
          SELECT COUNT(DISTINCT t.lead_id)::float8 AS v
          FROM lead_stage_transitions t
          JOIN pipeline_stages ps ON ps.id = t.to_stage_id
          JOIN leads l ON l.id = t.lead_id
          WHERE lower(ps.name) LIKE '%proposal%'
            AND t.entered_at::date >= ${from}::date AND t.entered_at::date <= ${to}::date
            AND l.is_archived=FALSE
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR t.to_pipeline_id::text=${pipe})`;
        break;
      case Metric.OpenLeadValue:
        // A snapshot of open lead value for the scope, not a value over time.
        q = sql`
          SELECT COALESCE(SUM(l.potential_value),0)::float8 AS v FROM leads l
          WHERE l.is_archived=FALSE AND l.status IN ('open','inbox','qualified')
            AND ${leadInTeam(team)}
            AND (${user}='' OR l.owner_user_id::text=${user})
            AND (${pipe}='' OR l.pipeline_id::text=${pipe})`;
        break;
      case Metric.Activities:
        q = sql`
          SELECT COUNT(*)::float8 AS v FROM activities a
          WHERE a.created_at::date >= ${from}::date AND a.created_at::date <= ${to}::date
            AND (${team}='' OR EXISTS (
                SELECT 1 FROM deals d WHERE d.id=a.deal_id AND d.team_id::text=${team}
              ) OR EXISTS (
                SELECT 1 FROM leads l WHERE l.id=a.lead_id AND l.team_id::text=${team}
              ) OR EXISTS (
                SELECT 1 FROM customers c WHERE c.id=a.customer_id AND c.team_id::text=${team}
              ))
            AND (${user}='' OR COALESCE(a.owner_user_id, a.actor_user_id)::text=${user})
            AND (${pipe}='' OR EXISTS (
                SELECT 1 FROM deals d WHERE d.id=a.deal_id AND d.pipeline_id::text=${pipe}
              ) OR EXISTS (
                SELECT 1 FROM leads l WHERE l.id=a.lead_id AND l.pipeline_id::text=${pipe}
              ))`;
        break;
      default:
        return 0;
    }
    const { rows } = await sql<{ v: number }>`${q}`.execute(this.db);
    return rows[0]!.v;
  }
}

export class TargetsService {
  readonly repo: TargetsRepository;

  constructor(
    db: Database,
    private readonly audit: AuditService,
  ) {
    this.repo = new TargetsRepository(db);
  }

  async list(claims: Claims, f: TargetListFilter): Promise<{ items: Target[]; total: number }> {
    const scope = resolveRead(claims);
    return internal("failed to list targets", () => this.repo.list(f, scope));
  }

  async get(claims: Claims, id: string): Promise<Target> {
    const scope = resolveRead(claims);
    if (!isUuid(id)) throw AppError.notFound("target not found");
    const t = await internal("failed to load target", () => this.repo.get(id));
    if (!t || !allows(scope, t)) throw AppError.notFound("target not found");
    return t;
  }

  async create(claims: Claims, in_: CreateInput, meta: RequestMeta): Promise<Target> {
    const actorId = claims.userId;
    const input = { ...in_ };
    const teamId = authorizeWrite(claims, input.scopeType, input.teamId, input.userId);
    if (input.scopeType === ScopeType.Team) input.teamId = teamId ?? undefined;
    validateInput(
      input.metric,
      input.periodType,
      input.scopeType,
      input.periodStart,
      input.periodEnd,
      input.teamId,
      input.userId,
      input.targetValue,
    );
    await this.checkPipeline(input.metric, emptyToNil(input.pipelineId));
    if (input.name.trim() === "") input.name = `${input.periodType} ${input.metric} target`.trim();
    if (input.scopeType === ScopeType.Organization) {
      input.teamId = undefined;
      input.userId = undefined;
    } else if (input.scopeType === ScopeType.Team) {
      input.userId = undefined;
    }
    const t = await internal("failed to create target", () => this.repo.create(actorId, input));
    if (!t) throw AppError.internal("failed to create target");
    await this.audit.record(
      actorId,
      "target.created",
      "target",
      t.id,
      { metric: t.metric, periodType: t.periodType, value: t.targetValue },
      meta,
    );
    return t;
  }

  async update(claims: Claims, id: string, in_: UpdateInput, meta: RequestMeta): Promise<Target> {
    const actorId = claims.userId;
    const cur = await this.get(claims, id);
    authorizeExisting(claims, cur);
    const input = { ...in_ };
    const metric = input.metric ?? cur.metric;
    const periodType = input.periodType ?? cur.periodType;
    const scopeType = input.scopeType ?? cur.scopeType;
    const periodStart = input.periodStart ?? cur.periodStart;
    const periodEnd = input.periodEnd ?? cur.periodEnd;
    let teamId = input.teamId !== undefined ? emptyToNil(input.teamId) : cur.teamId;
    const userId = input.userId !== undefined ? emptyToNil(input.userId) : cur.userId;
    const value = input.targetValue ?? cur.targetValue;

    const pinned = authorizeWrite(claims, scopeType, teamId, userId);
    if (scopeType === ScopeType.Team) {
      teamId = pinned ?? null;
      // A nil pin leaves the stored team as it is, as Go's nil pointer does.
      input.teamId = pinned ?? undefined;
    }
    validateInput(metric, periodType, scopeType, periodStart, periodEnd, teamId, userId, value);
    await this.checkPipeline(metric, input.pipelineId !== undefined ? emptyToNil(input.pipelineId) : cur.pipelineId);
    if (scopeType === ScopeType.Organization) {
      input.teamId = "";
      input.userId = "";
      input.scopeType = scopeType;
    } else if (scopeType === ScopeType.Team) {
      input.userId = "";
      input.scopeType = scopeType;
    }
    const t = await internal("failed to update target", () => this.repo.update(id, cur, input));
    if (!t) throw AppError.internal("failed to update target");
    await this.audit.record(actorId, "target.updated", "target", id, { metric: t.metric, value: t.targetValue }, meta);
    return t;
  }

  /** A lead target filtered to a deals pipeline would always read zero, and the reverse. */
  private async checkPipeline(metric: string, pipelineId: string | null): Promise<void> {
    if (pipelineId === null) return;
    const kind = await internal("failed to load pipeline", () => this.repo.pipelineKind(pipelineId));
    if (kind === undefined) throw AppError.validation("pipeline not found");
    const want = pipelineKindFor(metric);
    if (want === "leads" && kind !== "leads") throw AppError.validation("lead targets can only count a lead pipeline");
    if (want === "sales" && kind !== "sales") throw AppError.validation("deal targets can only count a sales pipeline");
  }

  async delete(claims: Claims, id: string, meta: RequestMeta): Promise<void> {
    const cur = await this.get(claims, id);
    authorizeExisting(claims, cur);
    await internal("failed to delete target", () => this.repo.delete(id));
    await this.audit.record(claims.userId, "target.deleted", "target", id, null, meta);
  }

  async progress(claims: Claims, id: string): Promise<Progress> {
    return this.buildProgress(await this.get(claims, id));
  }

  async listProgress(claims: Claims, f: TargetListFilter): Promise<{ items: Progress[]; total: number }> {
    const { items, total } = await this.list(claims, f);
    const out: Progress[] = [];
    for (const t of items) out.push(await this.buildProgress(t));
    return { items: out, total };
  }

  async buildProgress(t: Target, now = new Date()): Promise<Progress> {
    const actual = await internal("failed to compute target actual", () => this.repo.computeActual(t));
    const p: Progress = {
      target: t,
      actual: round2(actual),
      remaining: round2(Math.max(0, t.targetValue - actual)),
      progressPct: null,
      progressLabel: "No target set",
      daysRemaining: 0,
      periodElapsedPct: null,
      asOf: now,
    };
    if (t.targetValue > 0) {
      const pct = round2(Math.min(100, (actual / t.targetValue) * 100));
      p.progressPct = pct;
      p.progressLabel = `${goFixed(pct, 1)}%`;
    }

    const end = parseDateOnly(t.periodEnd);
    const start = parseDateOnly(t.periodStart);
    if (end) {
      const endInclusive = end.getTime() + DAY_MS - NS_MS;
      p.daysRemaining = Math.max(0, Math.ceil((endInclusive - now.getTime()) / DAY_MS));
      if (start && endInclusive > start.getTime()) {
        const total = endInclusive - start.getTime();
        const elapsed = now.getTime() - start.getTime();
        if (total > 0) p.periodElapsedPct = round2(Math.max(0, Math.min(100, (elapsed / total) * 100)));
      }
    }
    return p;
  }
}
