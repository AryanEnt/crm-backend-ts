import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goSortKeys } from "../../lib/go-json.js";
import {
  ConversionLikelihoodStrategy,
  DISCLAIMER,
  ExpectedOutcomeStrategy,
  explanationJson,
  FollowUpRiskStrategy,
  INSUFFICIENT_HISTORICAL_DATA,
  LeadScoreStrategy,
  MIN_HISTORICAL_SAMPLE,
  PipelineRiskStrategy,
  resultJson,
  rfc3339Now,
  signalJson,
  StalledOpportunityStrategy,
  STRATEGIES,
  WorkloadForecastStrategy,
  type Explanation,
  type FeatureSet,
  type PredictionResult,
  type Signal,
} from "./predictions.strategies.js";

const round2 = (v: number) => (v < 0 ? -Math.round(-v * 100) : Math.round(v * 100)) / 100;
const rate = (num: number, den: number) => (den <= 0 ? 0 : round2((num / den) * 100));
const daysSince = (t: Date, now: number) => (now - t.getTime()) / 86_400_000;
const blank = (v: string | null | undefined) => (v ?? "").trim() === "";

/** Thrown when the entity row itself is missing (Go pgx.ErrNoRows). */
class NoRowsError extends Error {}

/** Loads CRM facts into feature sets. */
export class FeatureBuilder {
  constructor(private readonly db: Database) {}

  /** A best-effort aggregate: Go ignores failures here and keeps zero values. */
  private async counts<T extends Record<string, number>>(q: RawBuilder<unknown>, zero: T): Promise<T> {
    try {
      const { rows } = await sql<T>`${q}`.execute(this.db);
      const row = rows[0];
      if (!row) return zero;
      const out = { ...zero };
      for (const k of Object.keys(zero) as (keyof T)[]) out[k] = Number(row[k]) as T[keyof T];
      return out;
    } catch {
      return zero;
    }
  }

  async lead(leadId: string, now = Date.now()): Promise<FeatureSet> {
    const { rows } = await sql<{
      fullName: string;
      email: string;
      phone: string;
      source: string;
      priority: string;
      status: string;
      occupation: string | null;
      jobTitle: string | null;
      employer: string | null;
      skills: string[];
      stageId: string | null;
      stageName: string | null;
      pipelineId: string | null;
      anzscoId: string | null;
      anzscoCode: string | null;
      lastActivityAt: Date | null;
      nextActivityAt: Date | null;
      createdAt: Date;
      ageDays: number;
    }>`
      SELECT l.full_name AS "fullName", COALESCE(l.email,'') AS email, COALESCE(l.phone,'') AS phone,
        l.source, l.priority, l.status, l.occupation, l.job_title AS "jobTitle", l.employer,
        COALESCE(l.skills,'{}') AS skills,
        l.stage_id::text AS "stageId", ps.name AS "stageName", l.pipeline_id::text AS "pipelineId",
        l.anzsco_id::text AS "anzscoId", ao.code AS "anzscoCode",
        l.last_activity_at AS "lastActivityAt", l.next_activity_at AS "nextActivityAt", l.created_at AS "createdAt",
        EXTRACT(DAY FROM NOW() - l.created_at)::int AS "ageDays"
      FROM leads l
      LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
      LEFT JOIN anzsco_occupations ao ON ao.id = l.anzsco_id
      WHERE l.id = ${leadId}`.execute(this.db);
    const l = rows[0];
    if (!l) throw new NoRowsError();

    const acts = await this.counts(
      sql`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS a7,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS a30,
          COUNT(*) FILTER (WHERE status='completed') AS completed,
          COUNT(*) FILTER (WHERE status='overdue' OR (status IN ('upcoming','due') AND due_at IS NOT NULL AND due_at < NOW())) AS overdue
        FROM activities WHERE lead_id = ${leadId}`,
      { a7: 0, a30: 0, completed: 0, overdue: 0 },
    );
    const docs = await this.counts(
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('uploaded','verified')) AS uploaded,
          COUNT(*) FILTER (WHERE status='verified') AS verified,
          COUNT(*) FILTER (WHERE status IN ('requested','missing')) AS requested,
          COUNT(*) FILTER (WHERE status='rejected') AS rejected
        FROM documents WHERE lead_id = ${leadId} OR customer_id IN (
          SELECT converted_customer_id FROM leads WHERE id = ${leadId} AND converted_customer_id IS NOT NULL
        )`,
      { uploaded: 0, verified: 0, requested: 0, rejected: 0 },
    );
    // Historical conversion by source; strategies decide whether the sample is sufficient.
    const src = await this.counts(
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('converted','unqualified','archived') OR converted_at IS NOT NULL) AS closed,
          COUNT(*) FILTER (WHERE status='converted') AS converted
        FROM leads
        WHERE lower(source) = lower(${l.source}) AND created_at >= NOW() - INTERVAL '365 days'`,
      { closed: 0, converted: 0 },
    );

    const hasAnzsco = l.anzscoId !== null && l.anzscoId !== "";
    const filled = [
      !blank(l.email),
      !blank(l.phone),
      !blank(l.occupation),
      !blank(l.jobTitle),
      hasAnzsco,
      !blank(l.employer),
      l.skills.length > 0,
    ];
    const completeness = (filled.filter(Boolean).length / filled.length) * 100;
    const daysSinceActivity = daysSince(l.lastActivityAt ?? l.createdAt, now);

    return {
      entityType: "lead",
      entityId: leadId,
      features: goSortKeys({
        fullName: l.fullName,
        source: l.source,
        priority: l.priority,
        status: l.status,
        stageId: l.stageId,
        stageName: l.stageName ?? "",
        pipelineId: l.pipelineId,
        hasEmail: !blank(l.email),
        hasPhone: !blank(l.phone),
        hasAnzsco,
        anzscoCode: l.anzscoCode ?? "",
        profileCompletenessPct: round2(completeness),
        ageDays: l.ageDays,
        daysSinceActivity: round2(daysSinceActivity),
        activityCount7d: acts.a7,
        activityCount30d: acts.a30,
        completedActivities: acts.completed,
        overdueFollowups: acts.overdue,
        hasNextActivity: l.nextActivityAt !== null,
        nextActivityAt: l.nextActivityAt ? rfc3339Now(l.nextActivityAt) : null,
        docsUploaded: docs.uploaded,
        docsVerified: docs.verified,
        docsRequested: docs.requested,
        docsRejected: docs.rejected,
        sourceClosedSample: src.closed,
        sourceConverted: src.converted,
        sourceConversionRate: rate(src.converted, src.closed),
      }),
    };
  }

  async deal(dealId: string, now = Date.now()): Promise<FeatureSet> {
    const { rows } = await sql<{
      title: string;
      status: string;
      source: string;
      value: number | null;
      stageId: string | null;
      stageName: string | null;
      pipelineId: string | null;
      probability: number;
      createdAt: Date;
      expectedCloseAt: string | null;
      daysInStage: number;
      ageDays: number;
      slaHours: number | null;
      lastActivityAt: Date | null;
      nextActivityAt: Date | null;
    }>`
      SELECT d.title, d.status, d.source, d.value, d.stage_id::text AS "stageId", ps.name AS "stageName",
        d.pipeline_id::text AS "pipelineId", COALESCE(ps.probability,0) AS probability,
        d.created_at AS "createdAt", d.expected_close_at AS "expectedCloseAt",
        EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS "daysInStage",
        EXTRACT(DAY FROM NOW() - d.created_at)::int AS "ageDays",
        ps.sla_hours AS "slaHours", d.last_activity_at AS "lastActivityAt", d.next_activity_at AS "nextActivityAt"
      FROM deals d
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      WHERE d.id = ${dealId}`.execute(this.db);
    const d = rows[0];
    if (!d) throw new NoRowsError();

    const acts = await this.counts(
      sql`
        SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS a7,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS a30,
          COUNT(*) FILTER (WHERE status='overdue' OR (status IN ('upcoming','due') AND due_at IS NOT NULL AND due_at < NOW())) AS overdue
        FROM activities WHERE deal_id = ${dealId}`,
      { a7: 0, a30: 0, overdue: 0 },
    );
    const docs = await this.counts(
      sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('uploaded','verified')) AS uploaded,
          COUNT(*) FILTER (WHERE status='verified') AS verified
        FROM documents WHERE deal_id = ${dealId}`,
      { uploaded: 0, verified: 0 },
    );
    const hist =
      d.pipelineId !== null
        ? await this.counts(
            sql`
              SELECT COUNT(*) FILTER (WHERE status IN ('won','lost')) AS closed,
                COUNT(*) FILTER (WHERE status='won') AS won
              FROM deals WHERE pipeline_id = ${d.pipelineId} AND updated_at >= NOW() - INTERVAL '365 days'`,
            { closed: 0, won: 0 },
          )
        : { closed: 0, won: 0 };

    return {
      entityType: "deal",
      entityId: dealId,
      features: goSortKeys({
        title: d.title,
        status: d.status,
        source: d.source,
        value: d.value,
        stageId: d.stageId,
        stageName: d.stageName ?? "",
        pipelineId: d.pipelineId,
        stageProbability: Number(d.probability),
        daysInStage: d.daysInStage,
        ageDays: d.ageDays,
        slaHours: d.slaHours ?? 0,
        activityCount7d: acts.a7,
        activityCount30d: acts.a30,
        overdueFollowups: acts.overdue,
        daysSinceActivity: round2(daysSince(d.lastActivityAt ?? d.createdAt, now)),
        hasNextActivity: d.nextActivityAt !== null,
        docsUploaded: docs.uploaded,
        docsVerified: docs.verified,
        // A DATE scanned into time.Time: midnight UTC.
        expectedCloseAt: d.expectedCloseAt ? `${d.expectedCloseAt}T00:00:00Z` : null,
        pipelineClosedSample: hist.closed,
        pipelineWonSample: hist.won,
        pipelineWinRate: rate(hist.won, hist.closed),
      }),
    };
  }

  async ownerWorkload(ownerUserId: string): Promise<FeatureSet> {
    const { rows } = await sql<{ leads: number; deals: number; overdue: number; due7: number; completed7: number }>`
      SELECT
        (SELECT COUNT(*) FROM leads WHERE owner_user_id = ${ownerUserId} AND is_archived=FALSE AND status='open') AS leads,
        (SELECT COUNT(*) FROM deals WHERE owner_user_id = ${ownerUserId} AND status='open') AS deals,
        (SELECT COUNT(*) FROM activities WHERE COALESCE(owner_user_id, actor_user_id) = ${ownerUserId}
          AND (status='overdue' OR (status IN ('upcoming','due') AND due_at IS NOT NULL AND due_at < NOW()))) AS overdue,
        (SELECT COUNT(*) FROM activities WHERE COALESCE(owner_user_id, actor_user_id) = ${ownerUserId}
          AND due_at >= NOW() AND due_at < NOW() + INTERVAL '7 days'
          AND status IN ('upcoming','due')) AS due7,
        (SELECT COUNT(*) FROM activities WHERE COALESCE(owner_user_id, actor_user_id) = ${ownerUserId}
          AND status='completed' AND completed_at >= NOW() - INTERVAL '7 days') AS completed7`.execute(this.db);
    const r = rows[0]!;
    const [openLeads, openDeals, overdue, due7, completed7] = [r.leads, r.deals, r.overdue, r.due7, r.completed7].map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const name = await sql<{ name: string }>`SELECT full_name AS name FROM users WHERE id = ${ownerUserId}`
      .execute(this.db)
      .then((q) => q.rows[0]?.name ?? "")
      .catch(() => "");
    return {
      entityType: "user",
      entityId: ownerUserId,
      features: goSortKeys({
        ownerUserId,
        ownerName: name,
        openLeads,
        openDeals,
        overdueActivities: overdue,
        dueNext7Days: due7,
        completedLast7Days: completed7,
        workloadIndex: openLeads + openDeals * 2 + overdue * 3 + due7,
      }),
    };
  }

  async pipelineRisk(pipelineId: string): Promise<FeatureSet> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pipelines WHERE id = ${pipelineId}`.execute(this.db);
    if (!rows[0]) throw new NoRowsError();
    const open = await this.counts(
      sql`
        SELECT COUNT(*) AS n, COALESCE(SUM(value),0) AS value,
          COUNT(*) FILTER (WHERE EXTRACT(DAY FROM NOW() - stage_entered_at) >= 14) AS stalled,
          COUNT(*) FILTER (WHERE ps.sla_hours IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - stage_entered_at))/3600 > ps.sla_hours) AS over_sla,
          COUNT(*) FILTER (WHERE last_activity_at IS NULL OR last_activity_at < NOW() - INTERVAL '14 days') AS quiet
        FROM deals d
        LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
        WHERE d.pipeline_id = ${pipelineId} AND d.status='open'`,
      { n: 0, value: 0, stalled: 0, over_sla: 0, quiet: 0 },
    );
    const hist = await this.counts(
      sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('won','lost')) AS closed,
          COUNT(*) FILTER (WHERE status='won') AS won
        FROM deals WHERE pipeline_id = ${pipelineId} AND updated_at >= NOW() - INTERVAL '365 days'`,
      { closed: 0, won: 0 },
    );
    return {
      entityType: "pipeline",
      entityId: pipelineId,
      features: goSortKeys({
        pipelineId,
        pipelineName: rows[0].name,
        openDealCount: open.n,
        openPipelineValue: open.value,
        stalledDeals14d: open.stalled,
        overSLADeals: open.over_sla,
        noActivity14d: open.quiet,
        closedSample: hist.closed,
        wonSample: hist.won,
        winRate: rate(hist.won, hist.closed),
      }),
    };
  }
}

const signalsJson = (list: Signal[] | null) => JSON.stringify(list?.map(signalJson) ?? null);
const actorOrNull = (id: string) => (id.trim() === "" ? null : id);

export class PredictionsRepository {
  constructor(private readonly db: Database) {}

  async leadExists(id: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM leads WHERE id = ${id}) AS ok`.execute(this.db);
    return rows[0]!.ok;
  }

  async dealExists(id: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM deals WHERE id = ${id}) AS ok`.execute(this.db);
    return rows[0]!.ok;
  }

  async saveLeadScore(actorId: string, r: PredictionResult): Promise<void> {
    await sql`
      INSERT INTO lead_score_snapshots (
        id, lead_id, score, strategy_code, strategy_version, features,
        positive_signals, negative_signals, explanation, insufficient_hist, computed_by
      ) VALUES (
        ${randomUUID()}, ${r.entityId}, ${r.score ?? 0}, ${r.strategyCode}, ${r.strategyVersion}, ${JSON.stringify(r.features)}::jsonb,
        ${signalsJson(r.explanation.positiveSignals)}::jsonb, ${signalsJson(r.explanation.negativeSignals)}::jsonb,
        ${JSON.stringify(explanationJson(r.explanation))}::jsonb, ${r.insufficientHistoricalData}, ${actorOrNull(actorId)}
      )`.execute(this.db);
  }

  async savePrediction(actorId: string, r: PredictionResult): Promise<void> {
    await sql`
      INSERT INTO prediction_results (
        id, entity_type, entity_id, insight_type, strategy_code, strategy_version,
        available, message, score, label, features, positive_signals, negative_signals,
        explanation, payload, computed_by
      ) VALUES (
        ${randomUUID()}, ${r.entityType}, ${r.entityId}, ${r.insightType}, ${r.strategyCode}, ${r.strategyVersion},
        ${r.available}, ${r.message}, ${r.score}, ${r.label}, ${JSON.stringify(r.features)}::jsonb,
        ${signalsJson(r.explanation.positiveSignals)}::jsonb, ${signalsJson(r.explanation.negativeSignals)}::jsonb,
        ${JSON.stringify(explanationJson(r.explanation))}::jsonb, ${JSON.stringify(goSortKeys(r.payload))}::jsonb,
        ${actorOrNull(actorId)}
      )`.execute(this.db);
  }

  async leadScoreHistory(leadId: string, limit: number): Promise<Record<string, unknown>[]> {
    const n = limit <= 0 || limit > 50 ? 20 : limit;
    const { rows } = await sql<{
      id: string;
      score: number;
      code: string;
      version: string;
      pos: unknown;
      neg: unknown;
      expl: unknown;
      insufficient: boolean;
      at: Date;
    }>`
      SELECT id::text AS id, score::float8 AS score, strategy_code AS code, strategy_version AS version,
        positive_signals AS pos, negative_signals AS neg, explanation AS expl, insufficient_hist AS insufficient,
        computed_at AS at
      FROM lead_score_snapshots
      WHERE lead_id = ${leadId}
      ORDER BY computed_at DESC
      LIMIT ${n}`.execute(this.db);
    // A Go map: top-level keys sorted; the nested structs keep their field order.
    return rows.map((r) => ({
      computedAt: rfc3339Now(r.at),
      disclaimer: DISCLAIMER,
      explanation: explanationJson(decodeExplanation(r.expl)),
      id: r.id,
      insufficientHistoricalData: r.insufficient,
      negativeSignals: decodeSignals(r.neg)?.map(signalJson) ?? null,
      positiveSignals: decodeSignals(r.pos)?.map(signalJson) ?? null,
      score: r.score,
      strategyCode: r.code,
      strategyVersion: r.version,
    }));
  }
}

/** Go json.Unmarshal into []Signal: null stays nil, unknown fields drop, missing fields are zero. */
function decodeSignals(v: unknown): Signal[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const out: Signal = {
      code: typeof s.code === "string" ? s.code : "",
      label: typeof s.label === "string" ? s.label : "",
      impact: typeof s.impact === "number" ? s.impact : 0,
      polarity: typeof s.polarity === "string" ? s.polarity : "",
    };
    if (typeof s.detail === "string") out.detail = s.detail;
    return out;
  });
}

function decodeExplanation(v: unknown): Explanation {
  const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    summary: typeof e.summary === "string" ? e.summary : "",
    positiveSignals: decodeSignals(e.positiveSignals),
    negativeSignals: decodeSignals(e.negativeSignals),
    neutralNotes: Array.isArray(e.neutralNotes) ? e.neutralNotes.map((n) => (typeof n === "string" ? n : "")) : null,
  };
}

async function check<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw AppError.internal(message, err);
  }
}

/** FeatureBuilder → ScoringStrategy → persist. */
export class PredictionsService {
  readonly features: FeatureBuilder;
  readonly repo: PredictionsRepository;

  constructor(db: Database) {
    this.features = new FeatureBuilder(db);
    this.repo = new PredictionsRepository(db);
  }

  private async requireLead(leadId: string): Promise<void> {
    if (!(await check("failed to check lead", () => this.repo.leadExists(leadId)))) throw AppError.notFound("lead not found");
  }

  private async save(actorId: string, results: PredictionResult[]): Promise<void> {
    for (const r of results) await check("failed to store prediction audit", () => this.repo.savePrediction(actorId, r));
  }

  async scoreLead(actorId: string, leadId: string): Promise<Record<string, unknown>> {
    await this.requireLead(leadId);
    const fs = await this.features.lead(leadId).catch((err: unknown) => {
      if (err instanceof NoRowsError) throw AppError.notFound("lead not found");
      throw AppError.internal("failed to build lead features", err);
    });
    const res = LeadScoreStrategy.score(fs);
    await check("failed to store lead score", () => this.repo.saveLeadScore(actorId, res));
    await this.save(actorId, [res]);
    return resultJson(res);
  }

  async leadScoreHistory(leadId: string, limit: number): Promise<Record<string, unknown>[]> {
    await this.requireLead(leadId);
    return this.repo.leadScoreHistory(leadId, limit);
  }

  async leadInsights(actorId: string, leadId: string): Promise<Record<string, unknown>> {
    await this.requireLead(leadId);
    const fs = await check("failed to build lead features", () => this.features.lead(leadId));
    const score = LeadScoreStrategy.score(fs);
    const conv = ConversionLikelihoodStrategy.score(fs);
    const follow = FollowUpRiskStrategy.score(fs);
    await this.save(actorId, [score, conv, follow]);
    await check("failed to store lead score", () => this.repo.saveLeadScore(actorId, score));
    return { disclaimer: DISCLAIMER, insights: [resultJson(conv), resultJson(follow)], leadScore: resultJson(score) };
  }

  async dealInsights(actorId: string, dealId: string): Promise<Record<string, unknown>> {
    if (!(await check("failed to check deal", () => this.repo.dealExists(dealId)))) throw AppError.notFound("deal not found");
    const fs = await this.features.deal(dealId).catch((err: unknown) => {
      if (err instanceof NoRowsError) throw AppError.notFound("deal not found");
      throw AppError.internal("failed to build deal features", err);
    });
    const results = [
      StalledOpportunityStrategy.score(fs),
      FollowUpRiskStrategy.score(fs),
      ExpectedOutcomeStrategy.score(fs),
      ConversionLikelihoodStrategy.score(fs),
    ];
    await this.save(actorId, results);
    return { disclaimer: DISCLAIMER, insights: results.map(resultJson) };
  }

  async workload(actorId: string, ownerUserId: string): Promise<Record<string, unknown>> {
    if (ownerUserId.trim() === "") throw AppError.validation("ownerUserId is required");
    const fs = await check("failed to build workload features", () => this.features.ownerWorkload(ownerUserId));
    const res = WorkloadForecastStrategy.score(fs);
    await this.save(actorId, [res]);
    return resultJson(res);
  }

  async pipelineRisk(actorId: string, pipelineId: string): Promise<Record<string, unknown>> {
    if (pipelineId.trim() === "") throw AppError.validation("pipelineId is required");
    const fs = await this.features.pipelineRisk(pipelineId).catch((err: unknown) => {
      if (err instanceof NoRowsError) throw AppError.notFound("pipeline not found");
      throw AppError.internal("failed to build pipeline features", err);
    });
    const res = PipelineRiskStrategy.score(fs);
    await this.save(actorId, [res]);
    return resultJson(res);
  }

  catalog(): Record<string, unknown> {
    return {
      architecture: "PredictionService → FeatureBuilder → ScoringStrategy → PredictionResult → Explanation",
      disclaimer: DISCLAIMER,
      insufficientHistoricalData: INSUFFICIENT_HISTORICAL_DATA,
      minHistoricalSample: MIN_HISTORICAL_SAMPLE,
      strategies: STRATEGIES.map((s) => ({ code: s.code, insightType: s.insightType, version: s.version })),
    };
  }
}
