import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { GoTime } from "../../lib/go-time.js";
import { internal } from "../../lib/request-meta.js";
import {
  div,
  metricRows,
  pct,
  round2,
  textArray,
  ts,
  Where,
  type AnalyticsFilter,
  type Frag,
  type MetricPoint,
} from "./analytics.filter.js";
import { organization, type OrganizationAnalytics } from "./organization.js";

export interface FunnelStage {
  stageId: string;
  stageName: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  entered: number;
  left: number;
  currentlyInStage: number;
  conversionRate: number;
  dropOffRate: number;
  avgTimeInStageSeconds: number | null;
  totalPipelineValue: number;
  averageDealValue: number;
  enteredValue: number;
}

export interface FunnelTotals {
  entered: number;
  won: number;
  lost: number;
  open: number;
  totalPipelineValue: number;
  averageDealValue: number;
  overallConversionRate: number;
}

export interface FunnelResult {
  pipelineId: string;
  pipelineName: string;
  pipelineKind: string;
  from: GoTime;
  to: GoTime;
  stages: FunnelStage[];
  totals: FunnelTotals;
}

export interface LeadAnalytics {
  leadVolume: number;
  qualifiedLeads: number;
  convertedLeads: number;
  conversionRate: number;
  averageResponseTimeSeconds: number | null;
  bySource: MetricPoint[];
  volumeByDay: MetricPoint[];
  question: string;
}

export interface PipelineAnalytics {
  deals: number;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  pipelineValue: number;
  averageDealValue: number;
  averageStageDurationSeconds: number | null;
  openValueByStage: MetricPoint[];
  question: string;
}

export interface ActivityAnalytics {
  activities: number;
  completed: number;
  overdue: number;
  byType: MetricPoint[];
  byDay: MetricPoint[];
  averagePerDeal: number;
  question: string;
}

export interface ConversionAnalytics {
  leadToCustomerRate: number;
  dealWinRate: number;
  leadsCreated: number;
  leadsConverted: number;
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  positiveOutcomes: number;
  submissions: number;
  conversionFunnel: MetricPoint[];
  question: string;
}

export interface TeamRow {
  entityId: string;
  entityName: string;
  entityType: string;
  leadVolume: number;
  deals: number;
  wonDeals: number;
  activities: number;
  pipelineValue: number;
  conversionRate: number;
  averageStageDurationSeconds: number | null;
}

export interface TeamAnalytics {
  groupBy: string;
  sortBy: string;
  rows: TeamRow[];
  question: string;
}

export interface SourceRow {
  source: string;
  leads: number;
  customers: number;
  deals: number;
  wonDeals: number;
  pipelineValue: number;
  conversionRate: number;
}

export interface SourceAnalytics {
  sources: SourceRow[];
  question: string;
}

export interface Summary {
  leadVolume: number;
  qualifiedLeads: number;
  deals: number;
  submissions: number;
  positiveOutcomes: number;
  conversions: number;
  conversionRate: number;
  averageResponseTimeSeconds: number | null;
  averageStageDurationSeconds: number | null;
  activities: number;
  pipelineValue: number;
  from: GoTime;
  to: GoTime;
}

interface StageRow {
  id: string;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
}

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  private async one<T>(q: Frag): Promise<T> {
    const { rows } = await sql<T>`${q}`.execute(this.db);
    return rows[0]!;
  }

  async pipelineMeta(id: string): Promise<{ name: string; kind: string } | undefined> {
    const { rows } = await sql<{ name: string; kind: string }>`SELECT name, kind FROM pipelines WHERE id = ${id}`.execute(this.db);
    return rows[0];
  }

  async defaultSalesPipeline(): Promise<{ id: string; name: string; kind: string } | undefined> {
    const { rows } = await sql<{ id: string; name: string; kind: string }>`
      SELECT id::text AS id, name, kind FROM pipelines
      WHERE kind = 'sales' AND is_active = TRUE
      ORDER BY is_default DESC, name ASC
      LIMIT 1`.execute(this.db);
    return rows[0];
  }

  private async listStages(pipelineId: string): Promise<StageRow[]> {
    const { rows } = await sql<StageRow>`
      SELECT id::text AS id, name, position, is_won AS "isWon", is_lost AS "isLost"
      FROM pipeline_stages
      WHERE pipeline_id = ${pipelineId} AND is_active = TRUE
      ORDER BY position ASC`.execute(this.db);
    return rows;
  }

  async funnel(f: AnalyticsFilter, pipelineId: string, pipelineName: string, pipelineKind: string): Promise<FunnelResult> {
    const stages = await this.listStages(pipelineId);
    const result: FunnelResult = {
      pipelineId,
      pipelineName,
      pipelineKind,
      from: f.from,
      to: f.to,
      stages: [],
      totals: { entered: 0, won: 0, lost: 0, open: 0, totalPipelineValue: 0, averageDealValue: 0, overallConversionRate: 0 },
    };
    return pipelineKind === "leads" ? this.funnelLeads(f, result, stages) : this.funnelDeals(f, result, stages);
  }

  private newStage(st: StageRow): FunnelStage {
    return {
      stageId: st.id,
      stageName: st.name,
      position: st.position,
      isWon: st.isWon,
      isLost: st.isLost,
      entered: 0,
      left: 0,
      currentlyInStage: 0,
      conversionRate: 0,
      dropOffRate: 0,
      avgTimeInStageSeconds: null,
      totalPipelineValue: 0,
      averageDealValue: 0,
      enteredValue: 0,
    };
  }

  private async funnelDeals(f: AnalyticsFilter, result: FunnelResult, stages: StageRow[]): Promise<FunnelResult> {
    const joins = sql`FROM deal_stage_transitions t JOIN deals d ON d.id = t.deal_id LEFT JOIN customers c ON c.id = d.customer_id`;
    for (const st of stages) {
      const fs = this.newStage(st);

      const enter = new Where()
        .add(sql`t.to_stage_id::text = ${st.id}`)
        .add(sql`t.to_pipeline_id::text = ${result.pipelineId}`)
        .inRange("t.exited_at", f)
        .dealDims(f);
      const e = await this.one<{ n: number; v: number }>(
        sql`SELECT COUNT(DISTINCT t.deal_id) AS n, COALESCE(SUM(d.value),0) AS v ${joins} WHERE ${enter.sql}`,
      );
      fs.entered = Number(e.n);
      fs.enteredValue = Number(e.v);

      const left = new Where()
        .add(sql`t.from_stage_id::text = ${st.id}`)
        .add(sql`COALESCE(t.from_pipeline_id::text, t.to_pipeline_id::text) = ${result.pipelineId}`)
        .inRange("t.exited_at", f)
        .dealDims(f);
      const l = await this.one<{ n: number; avg: number | null }>(
        sql`SELECT COUNT(DISTINCT t.deal_id) AS n, AVG(t.duration_seconds)::float8 AS avg ${joins} WHERE ${left.sql}`,
      );
      fs.left = Number(l.n);
      fs.avgTimeInStageSeconds = l.avg;

      const cur = new Where()
        .add(sql`d.stage_id::text = ${st.id}`)
        .add(sql`d.pipeline_id::text = ${result.pipelineId}`)
        .eq("d.status", "open")
        .dealDims(f);
      const c = await this.one<{ n: number; v: number }>(
        sql`SELECT COUNT(*) AS n, COALESCE(SUM(d.value),0) AS v FROM deals d LEFT JOIN customers c ON c.id = d.customer_id WHERE ${cur.sql}`,
      );
      fs.currentlyInStage = Number(c.n);
      fs.totalPipelineValue = Number(c.v);
      if (fs.currentlyInStage > 0) fs.averageDealValue = fs.totalPipelineValue / fs.currentlyInStage;

      fs.conversionRate = round2(pct(fs.left, fs.entered));
      fs.dropOffRate = fs.entered === 0 ? 0 : round2(100 - fs.conversionRate);
      if (st.isWon || st.isLost) {
        // Terminal stages have no "left" conversion or drop-off.
        fs.conversionRate = 0;
        fs.dropOffRate = 0;
      }
      result.stages.push(fs);
    }

    const tot = new Where()
      .add(sql`d.pipeline_id::text = ${result.pipelineId}`)
      .inRange("d.created_at", f)
      .dealDims(f);
    const t = await this.one<{ total: number; won: number; lost: number; open: number; value: number; avg: number }>(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE d.status='won') AS won,
        COUNT(*) FILTER (WHERE d.status='lost') AS lost,
        COUNT(*) FILTER (WHERE d.status='open') AS open,
        COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS value,
        COALESCE(AVG(d.value),0) AS avg
      FROM deals d LEFT JOIN customers c ON c.id = d.customer_id
      WHERE ${tot.sql}`);
    const totals = result.totals;
    totals.entered = Number(t.total);
    totals.won = Number(t.won);
    totals.lost = Number(t.lost);
    totals.open = Number(t.open);
    totals.totalPipelineValue = Number(t.value);
    totals.averageDealValue = Number(t.avg);
    totals.overallConversionRate = round2(pct(totals.won, totals.won + totals.lost));
    if (result.stages.length > 0) totals.entered = result.stages[0]!.entered;
    return result;
  }

  private async funnelLeads(f: AnalyticsFilter, result: FunnelResult, stages: StageRow[]): Promise<FunnelResult> {
    // No lead stage history: the current snapshot stands in for "entered".
    for (const st of stages) {
      const fs = this.newStage(st);
      const w = new Where()
        .commonLead("l", f)
        .add(sql`l.stage_id::text = ${st.id}`)
        .add(sql`l.pipeline_id::text = ${result.pipelineId}`);
      const r = await this.one<{ n: number; v: number }>(
        sql`SELECT COUNT(*) AS n, COALESCE(SUM(l.potential_value),0) AS v FROM leads l WHERE ${w.sql}`,
      );
      fs.entered = Number(r.n);
      fs.currentlyInStage = fs.entered;
      fs.totalPipelineValue = Number(r.v);
      fs.enteredValue = fs.totalPipelineValue;
      if (fs.entered > 0) fs.averageDealValue = fs.totalPipelineValue / fs.entered;
      result.stages.push(fs);
    }
    const s = result.stages;
    for (let i = 0; i < s.length; i++) {
      const cur = s[i]!;
      if (i + 1 < s.length && !cur.isLost && !cur.isWon) {
        const next = s[i + 1]!.entered;
        cur.left = next;
        cur.conversionRate = round2(pct(next, cur.entered));
        cur.dropOffRate = cur.entered === 0 ? 0 : round2(100 - cur.conversionRate);
      }
    }
    const totals = result.totals;
    if (s.length > 0) totals.entered = s[0]!.entered;
    let openVal = 0;
    for (const st of s) {
      if (!st.isWon && !st.isLost) {
        totals.open += st.currentlyInStage;
        openVal += st.totalPipelineValue;
      }
      if (st.isWon) totals.won += st.entered;
      if (st.isLost) totals.lost += st.entered;
    }
    totals.totalPipelineValue = openVal;
    totals.averageDealValue = div(openVal, Math.max(totals.open, 1));
    totals.overallConversionRate = round2(pct(totals.won, totals.won + totals.lost));
    return result;
  }

  async leadAnalytics(f: AnalyticsFilter): Promise<LeadAnalytics> {
    const w = new Where().commonLead("l", f).sql;
    const c = await this.one<{ volume: number; qualified: number; converted: number }>(sql`
      SELECT
        COUNT(*) AS volume,
        COUNT(*) FILTER (WHERE l.status IN ('qualified','converted')) AS qualified,
        COUNT(*) FILTER (WHERE l.status = 'converted') AS converted
      FROM leads l WHERE ${w}`);
    const volume = Number(c.volume);
    const converted = Number(c.converted);

    // Response time: first activity on the lead (or the customer it became) after creation.
    const avg = await this.one<{ avg: number | null }>(sql`
      SELECT AVG(EXTRACT(EPOCH FROM (a.first_at - l.created_at)))::float8 AS avg
      FROM leads l
      JOIN LATERAL (
        SELECT MIN(created_at) AS first_at FROM activities
        WHERE lead_id = l.id OR customer_id IN (
          SELECT id FROM customers WHERE converted_from_lead_id = l.id
        )
      ) a ON a.first_at IS NOT NULL
      WHERE ${w}`);

    const bySource = await metricRows(this.db, sql`
      SELECT COALESCE(NULLIF(l.source,''),'(none)') AS key, COUNT(*) AS value
      FROM leads l WHERE ${w}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
    const byDay = await metricRows(this.db, sql`
      SELECT to_char(date_trunc('day', l.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key, COUNT(*) AS value
      FROM leads l WHERE ${w}
      GROUP BY 1 ORDER BY 1 ASC`);

    return {
      leadVolume: volume,
      qualifiedLeads: Number(c.qualified),
      convertedLeads: converted,
      conversionRate: round2(pct(converted, volume)),
      averageResponseTimeSeconds: avg.avg,
      bySource,
      volumeByDay: byDay,
      question: "How many leads entered the CRM in this period, and how many progressed to qualified/converted?",
    };
  }

  async pipelineAnalytics(f: AnalyticsFilter): Promise<PipelineAnalytics> {
    const w = new Where().inRange("d.created_at", f).dealDims(f, { pipeline: true });
    const c = await this.one<{ deals: number; open: number; won: number; lost: number; value: number; avg: number }>(sql`
      SELECT
        COUNT(*) AS deals,
        COUNT(*) FILTER (WHERE d.status='open') AS open,
        COUNT(*) FILTER (WHERE d.status='won') AS won,
        COUNT(*) FILTER (WHERE d.status='lost') AS lost,
        COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS value,
        COALESCE(AVG(d.value),0) AS avg
      FROM deals d LEFT JOIN customers c ON c.id = d.customer_id
      WHERE ${w.sql}`);

    const tw = new Where()
      .inRange("t.exited_at", f)
      .add(sql`t.from_stage_id IS NOT NULL AND t.duration_seconds > 0`)
      .eqText("t.from_pipeline_id", f.pipelineId);
    let join = sql``;
    if (f.teamId !== "" || f.ownerUserId !== "" || f.source !== "" || f.anzscoId !== "") {
      join = sql` JOIN deals d ON d.id = t.deal_id LEFT JOIN customers c ON c.id = d.customer_id `;
      tw.dealDims(f);
    }
    const avg = await this.one<{ avg: number | null }>(
      sql`SELECT AVG(t.duration_seconds)::float8 AS avg FROM deal_stage_transitions t${join} WHERE ${tw.sql}`,
    );

    const sw = new Where().eqText("d.pipeline_id", f.pipelineId).eq("d.status", "open").dealDims(f);
    const byStage = await metricRows(
      this.db,
      sql`
        SELECT COALESCE(ps.id::text,'(none)') AS key, COALESCE(ps.name,'Unstaged') AS label, COALESCE(SUM(d.value),0) AS value
        FROM deals d
        LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
        LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ${sw.sql}
        GROUP BY ps.id, ps.name, ps.position
        ORDER BY COALESCE(ps.position, 999), ps.name`,
    );

    return {
      deals: Number(c.deals),
      openDeals: Number(c.open),
      wonDeals: Number(c.won),
      lostDeals: Number(c.lost),
      pipelineValue: Number(c.value),
      averageDealValue: Number(c.avg),
      averageStageDurationSeconds: avg.avg,
      openValueByStage: byStage,
      question: "What is the current open pipeline value and how is it distributed across stages?",
    };
  }

  async activityAnalytics(f: AnalyticsFilter): Promise<ActivityAnalytics> {
    const w = new Where().inRange("a.created_at", f);
    if (f.ownerUserId !== "") w.add(sql`COALESCE(a.owner_user_id, a.actor_user_id)::text = ${f.ownerUserId}`);
    if (f.teamId !== "") {
      w.add(sql`(
        EXISTS (SELECT 1 FROM deals d WHERE d.id = a.deal_id AND d.team_id::text = ${f.teamId})
        OR EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.team_id::text = ${f.teamId})
        OR EXISTS (SELECT 1 FROM customers c WHERE c.id = a.customer_id AND c.team_id::text = ${f.teamId})
      )`);
    }
    if (f.pipelineId !== "") {
      w.add(sql`(
        EXISTS (SELECT 1 FROM deals d WHERE d.id = a.deal_id AND d.pipeline_id::text = ${f.pipelineId})
        OR EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.pipeline_id::text = ${f.pipelineId})
      )`);
    }
    const where = w.sql;
    const c = await this.one<{ total: number; completed: number; overdue: number }>(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE a.status='completed') AS completed,
        COUNT(*) FILTER (WHERE a.status='overdue' OR (a.status IN ('upcoming','due','planned') AND a.due_at < NOW())) AS overdue
      FROM activities a WHERE ${where}`);
    const total = Number(c.total);

    const dw = new Where()
      .inRange("d.created_at", f)
      .eqText("d.pipeline_id", f.pipelineId)
      .eqText("d.team_id", f.teamId)
      .eqText("d.owner_user_id", f.ownerUserId);
    // Go ignores a failure here and divides by one.
    let dealCount = 0;
    try {
      dealCount = Number((await this.one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM deals d WHERE ${dw.sql}`)).n);
    } catch {
      dealCount = 0;
    }

    const byType = await metricRows(this.db, sql`
      SELECT a.kind AS key, COUNT(*) AS value FROM activities a WHERE ${where}
      GROUP BY a.kind ORDER BY 2 DESC LIMIT 20`);
    const byDay = await metricRows(this.db, sql`
      SELECT to_char(date_trunc('day', a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key, COUNT(*) AS value
      FROM activities a WHERE ${where}
      GROUP BY 1 ORDER BY 1 ASC`);

    return {
      activities: total,
      completed: Number(c.completed),
      overdue: Number(c.overdue),
      byType,
      byDay,
      averagePerDeal: round2(div(total, Math.max(dealCount, 1))),
      question: "Which activity types are teams executing, and is follow-up volume healthy?",
    };
  }

  async conversionAnalytics(f: AnalyticsFilter): Promise<ConversionAnalytics> {
    const lw = new Where().commonLead("l", f);
    const l = await this.one<{ created: number; converted: number }>(sql`
      SELECT COUNT(*) AS created, COUNT(*) FILTER (WHERE l.status='converted') AS converted
      FROM leads l WHERE ${lw.sql}`);
    const leadsCreated = Number(l.created);
    const leadsConverted = Number(l.converted);

    const dw = new Where().inRange("d.created_at", f).dealDims(f, { pipeline: true });
    const d = await this.one<{ created: number; won: number; lost: number; positive: number; submissions: number }>(sql`
      SELECT
        COUNT(*) AS created,
        COUNT(*) FILTER (WHERE d.status='won') AS won,
        COUNT(*) FILTER (WHERE d.status='lost') AS lost,
        COUNT(*) FILTER (WHERE d.status='won') AS positive,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM deal_stage_transitions t
            JOIN pipeline_stages ps ON ps.id = t.to_stage_id
            WHERE t.deal_id = d.id
              AND (lower(ps.name) LIKE '%negotiat%' OR lower(ps.name) LIKE '%submit%' OR lower(ps.name) LIKE '%proposal%')
          )
        ) AS submissions
      FROM deals d
      LEFT JOIN customers c ON c.id = d.customer_id
      WHERE ${dw.sql}`);
    const dealsCreated = Number(d.created);
    const dealsWon = Number(d.won);
    const dealsLost = Number(d.lost);
    const submissions = Number(d.submissions);

    return {
      leadToCustomerRate: round2(pct(leadsConverted, leadsCreated)),
      dealWinRate: round2(pct(dealsWon, dealsWon + dealsLost)),
      leadsCreated,
      leadsConverted,
      dealsCreated,
      dealsWon,
      dealsLost,
      positiveOutcomes: Number(d.positive),
      submissions,
      conversionFunnel: [
        { key: "leads", label: "Leads created", value: leadsCreated },
        { key: "converted", label: "Converted to customers", value: leadsConverted },
        { key: "deals", label: "Deals created", value: dealsCreated },
        { key: "submissions", label: "Reached proposal/negotiation", value: submissions },
        { key: "won", label: "Won deals", value: dealsWon },
      ],
      question: "Where do opportunities convert or stall from lead to won deal?",
    };
  }

  async teamAnalytics(f: AnalyticsFilter): Promise<TeamAnalytics> {
    const out: TeamAnalytics = {
      groupBy: f.groupBy,
      sortBy: f.sortBy,
      rows: [],
      question: "How do teams and owners compare on volume, pipeline value, and conversion for this period?",
    };
    let orderCol = TEAM_SORT_COLUMNS[f.sortBy];
    if (!orderCol) {
      orderCol = "pipeline_value";
      out.sortBy = "pipelineValue";
    }
    const dir = sql.raw(f.sortDir === "asc" ? "ASC" : "DESC");
    const { from, to, pipelineId: pipe, teamId: team, ownerUserId: owner, source, anzscoId: anz } = f;
    const $from = ts(from);
    const $to = ts(to);

    let q: Frag;
    let type: string;
    switch (f.groupBy) {
      case "team":
        type = "team";
        q = sql`
          WITH base AS (
            SELECT
              COALESCE(t.id::text, 'none') AS entity_id,
              COALESCE(t.name, 'Unassigned team') AS entity_name,
              (SELECT COUNT(*) FROM leads l WHERE COALESCE(l.team_id::text,'none') = COALESCE(t.id::text,'none')
                AND l.created_at >= ${$from} AND l.created_at <= ${$to} AND l.is_archived=FALSE
                AND (${pipe} = '' OR l.pipeline_id::text = ${pipe})
                AND (${source} = '' OR l.source = ${source})
                AND (${anz} = '' OR l.anzsco_id::text = ${anz})
                AND (${owner} = '' OR l.owner_user_id::text = ${owner})
              ) AS lead_volume,
              COUNT(d.*) AS deals,
              COUNT(*) FILTER (WHERE d.status='won') AS won_deals,
              COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS pipeline_value,
              (SELECT COUNT(*) FROM activities a
                WHERE a.created_at >= ${$from} AND a.created_at <= ${$to}
                  AND (
                  EXISTS (SELECT 1 FROM deals dx WHERE dx.id=a.deal_id AND COALESCE(dx.team_id::text,'none')=COALESCE(t.id::text,'none'))
                  OR EXISTS (SELECT 1 FROM leads lx WHERE lx.id=a.lead_id AND COALESCE(lx.team_id::text,'none')=COALESCE(t.id::text,'none'))
                  )
              ) AS activities,
              (SELECT AVG(tr.duration_seconds)::float8 FROM deal_stage_transitions tr
                JOIN deals dx ON dx.id = tr.deal_id
                WHERE COALESCE(dx.team_id::text,'none') = COALESCE(t.id::text,'none')
                  AND tr.from_stage_id IS NOT NULL AND tr.duration_seconds > 0
                  AND tr.exited_at >= ${$from} AND tr.exited_at <= ${$to}
                  AND (${pipe} = '' OR dx.pipeline_id::text = ${pipe})
              ) AS avg_stage
            FROM deals d
            FULL OUTER JOIN teams t ON t.id = d.team_id
            WHERE (d.id IS NULL OR (
              d.created_at >= ${$from} AND d.created_at <= ${$to}
              AND (${pipe} = '' OR d.pipeline_id::text = ${pipe})
              AND (${source} = '' OR d.source = ${source})
              AND (${owner} = '' OR d.owner_user_id::text = ${owner})
              AND (${anz} = '' OR EXISTS (SELECT 1 FROM customers c WHERE c.id=d.customer_id AND c.anzsco_id::text=${anz}))
            ))
            AND (${textArray(f.scopeTeamIds)} IS NULL OR t.id::text = ANY(${textArray(f.scopeTeamIds)}))
            GROUP BY t.id, t.name
          )
          SELECT entity_id, entity_name, lead_volume, deals, won_deals, activities, pipeline_value,
            CASE WHEN (won_deals + (SELECT COUNT(*) FROM deals dx WHERE dx.status='lost' AND COALESCE(dx.team_id::text,'none')=entity_id
              AND dx.created_at >= ${$from} AND dx.created_at <= ${$to})) > 0
            THEN won_deals::float8 * 100 / NULLIF((won_deals + (SELECT COUNT(*) FROM deals dx WHERE dx.status='lost'
              AND COALESCE(dx.team_id::text,'none')=entity_id AND dx.created_at >= ${$from} AND dx.created_at <= ${$to})),0)
            ELSE 0 END AS conversion_rate,
            avg_stage
          FROM base
          ORDER BY ${sql.raw(orderCol)} ${dir} NULLS LAST
          LIMIT 50`;
        break;

      case "period": {
        type = "period";
        const trunc = sql.raw(f.period === "day" ? "day" : f.period === "week" ? "week" : "month");
        q = sql`
          SELECT to_char(date_trunc('${trunc}', d.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS entity_id,
            to_char(date_trunc('${trunc}', d.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS entity_name,
            0 AS lead_volume, COUNT(*) AS deals, COUNT(*) FILTER (WHERE d.status='won') AS won_deals,
            0 AS activities, COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS pipeline_value,
            CASE WHEN COUNT(*) FILTER (WHERE d.status IN ('won','lost')) > 0
              THEN COUNT(*) FILTER (WHERE d.status='won')::float8 * 100
                / COUNT(*) FILTER (WHERE d.status IN ('won','lost'))
              ELSE 0 END AS conversion_rate,
            NULL::float8 AS avg_stage
          FROM deals d
          LEFT JOIN customers c ON c.id = d.customer_id
          WHERE d.created_at >= ${$from} AND d.created_at <= ${$to}
            AND (${pipe} = '' OR d.pipeline_id::text = ${pipe})
            AND (${team} = '' OR d.team_id::text = ${team})
            AND (${owner} = '' OR d.owner_user_id::text = ${owner})
            AND (${source} = '' OR d.source = ${source})
            AND (${anz} = '' OR c.anzsco_id::text = ${anz})
          GROUP BY 1, 2
          ORDER BY 1 ASC`;
        break;
      }

      case "pipeline": {
        type = "pipeline";
        // Go rewrites ORDER BY with strings.Replace on the first match of the sort column. For
        // "deals" that is "JOIN deals dx" in the avg_stage subquery, so the query fails (500).
        if (f.sortBy === "deals") throw new Error("invalid pipeline breakdown query for sortBy=deals");
        // Only wonDeals survives the rewrite; every other sort is by open value.
        const order =
          f.sortBy === "wonDeals"
            ? sql`COUNT(*) FILTER (WHERE d.status='won')`
            : sql`COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0)`;
        q = sql`
          SELECT COALESCE(p.id::text,'none') AS entity_id, COALESCE(p.name,'No pipeline') AS entity_name,
            0 AS lead_volume, COUNT(d.*) AS deals, COUNT(*) FILTER (WHERE d.status='won') AS won_deals,
            0 AS activities, COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS pipeline_value,
            CASE WHEN COUNT(*) FILTER (WHERE d.status IN ('won','lost')) > 0
              THEN COUNT(*) FILTER (WHERE d.status='won')::float8 * 100
                / COUNT(*) FILTER (WHERE d.status IN ('won','lost'))
              ELSE 0 END AS conversion_rate,
            (SELECT AVG(tr.duration_seconds)::float8 FROM deal_stage_transitions tr
              JOIN deals dx ON dx.id=tr.deal_id
              WHERE dx.pipeline_id = p.id AND tr.from_stage_id IS NOT NULL
                AND tr.exited_at >= ${$from} AND tr.exited_at <= ${$to} AND tr.duration_seconds > 0
                AND (${team} = '' OR dx.team_id::text = ${team})
                AND (${owner} = '' OR dx.owner_user_id::text = ${owner})) AS avg_stage
          FROM deals d
          LEFT JOIN pipelines p ON p.id = d.pipeline_id
          LEFT JOIN customers c ON c.id = d.customer_id
          WHERE d.created_at >= ${$from} AND d.created_at <= ${$to}
            AND (${team} = '' OR d.team_id::text = ${team})
            AND (${owner} = '' OR d.owner_user_id::text = ${owner})
            AND (${source} = '' OR d.source = ${source})
            AND (${anz} = '' OR c.anzsco_id::text = ${anz})
          GROUP BY p.id, p.name
          ORDER BY ${order} ${dir} NULLS LAST
          LIMIT 50`;
        break;
      }

      default:
        type = "user";
        q = sql`
          SELECT COALESCE(u.id::text,'none') AS entity_id, COALESCE(u.full_name,'Unassigned') AS entity_name,
            (SELECT COUNT(*) FROM leads l WHERE COALESCE(l.owner_user_id::text,'none') = COALESCE(u.id::text,'none')
              AND l.created_at >= ${$from} AND l.created_at <= ${$to} AND l.is_archived=FALSE
              AND (${pipe}='' OR l.pipeline_id::text=${pipe}) AND (${team}='' OR l.team_id::text=${team})
              AND (${source}='' OR l.source=${source}) AND (${anz}='' OR l.anzsco_id::text=${anz})) AS lead_volume,
            COUNT(d.*) AS deals,
            COUNT(*) FILTER (WHERE d.status='won') AS won_deals,
            (SELECT COUNT(*) FROM activities a
              WHERE a.created_at >= ${$from} AND a.created_at <= ${$to}
                AND COALESCE(a.owner_user_id, a.actor_user_id) = u.id) AS activities,
            COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS pipeline_value,
            CASE WHEN COUNT(*) FILTER (WHERE d.status IN ('won','lost')) > 0
              THEN COUNT(*) FILTER (WHERE d.status='won')::float8 * 100
                / COUNT(*) FILTER (WHERE d.status IN ('won','lost'))
              ELSE 0 END AS conversion_rate,
            (SELECT AVG(tr.duration_seconds)::float8 FROM deal_stage_transitions tr
              JOIN deals dx ON dx.id=tr.deal_id
              WHERE dx.owner_user_id = u.id AND tr.from_stage_id IS NOT NULL
                AND tr.duration_seconds > 0 AND tr.exited_at >= ${$from} AND tr.exited_at <= ${$to}) AS avg_stage
          FROM deals d
          FULL OUTER JOIN users u ON u.id = d.owner_user_id
          LEFT JOIN customers c ON c.id = d.customer_id
          WHERE (d.id IS NULL OR (
            d.created_at >= ${$from} AND d.created_at <= ${$to}
            AND (${pipe}='' OR d.pipeline_id::text=${pipe})
            AND (${team}='' OR d.team_id::text=${team})
            AND (${source}='' OR d.source=${source})
            AND (${anz}='' OR c.anzsco_id::text=${anz})
          ))
          AND (u.id IS NULL OR u.is_active = TRUE)
          AND (${textArray(f.scopeUserIds)} IS NULL OR u.id::text = ANY(${textArray(f.scopeUserIds)}))
          GROUP BY u.id, u.full_name
          HAVING COUNT(d.*) > 0 OR (
            SELECT COUNT(*) FROM leads l WHERE l.owner_user_id = u.id
            AND l.created_at >= ${$from} AND l.created_at <= ${$to} AND l.is_archived=FALSE
          ) > 0
          ORDER BY ${sql.raw(USER_ORDER[orderCol] ?? "7")} ${dir} NULLS LAST
          LIMIT 50`;
    }

    const { rows } = await sql<{
      entity_id: string;
      entity_name: string;
      lead_volume: number;
      deals: number;
      won_deals: number;
      activities: number;
      pipeline_value: number;
      conversion_rate: number;
      avg_stage: number | null;
    }>`${q}`.execute(this.db);
    out.rows = rows.map((r) => ({
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityType: type,
      leadVolume: Number(r.lead_volume),
      deals: Number(r.deals),
      wonDeals: Number(r.won_deals),
      activities: Number(r.activities),
      pipelineValue: Number(r.pipeline_value),
      conversionRate: round2(Number(r.conversion_rate)),
      averageStageDurationSeconds: r.avg_stage,
    }));
    return out;
  }

  async sourceAnalytics(f: AnalyticsFilter): Promise<SourceAnalytics> {
    const { from, to, pipelineId: pipe, teamId: team, ownerUserId: owner, anzscoId: anz } = f;
    const $from = ts(from);
    const $to = ts(to);
    const { rows } = await sql<{
      source: string;
      leads: number;
      customers: number;
      deals: number;
      won: number;
      value: number;
      rate: number;
    }>`
      WITH lead_src AS (
        SELECT COALESCE(NULLIF(source,''),'(none)') AS source, COUNT(*) AS leads,
          COUNT(*) FILTER (WHERE status='converted') AS converted
        FROM leads
        WHERE created_at >= ${$from} AND created_at <= ${$to} AND is_archived=FALSE
          AND (${pipe}='' OR pipeline_id::text=${pipe})
          AND (${team}='' OR team_id::text=${team})
          AND (${owner}='' OR owner_user_id::text=${owner})
          AND (${anz}='' OR anzsco_id::text=${anz})
        GROUP BY 1
      ),
      deal_src AS (
        SELECT COALESCE(NULLIF(d.source,''),'(none)') AS source,
          COUNT(*) AS deals,
          COUNT(*) FILTER (WHERE d.status='won') AS won,
          COALESCE(SUM(d.value) FILTER (WHERE d.status='open'),0) AS pipeline_value
        FROM deals d
        LEFT JOIN customers c ON c.id = d.customer_id
        WHERE d.created_at >= ${$from} AND d.created_at <= ${$to}
          AND (${pipe}='' OR d.pipeline_id::text=${pipe})
          AND (${team}='' OR d.team_id::text=${team})
          AND (${owner}='' OR d.owner_user_id::text=${owner})
          AND (${anz}='' OR c.anzsco_id::text=${anz})
        GROUP BY 1
      ),
      cust_src AS (
        SELECT COALESCE(NULLIF(source,''),'(none)') AS source, COUNT(*) AS customers
        FROM customers
        WHERE created_at >= ${$from} AND created_at <= ${$to} AND is_archived=FALSE
          AND (${team}='' OR team_id::text=${team})
          AND (${owner}='' OR owner_user_id::text=${owner})
          AND (${anz}='' OR anzsco_id::text=${anz})
        GROUP BY 1
      )
      SELECT COALESCE(l.source, d.source, c.source) AS source,
        COALESCE(l.leads,0) AS leads, COALESCE(c.customers,0) AS customers, COALESCE(d.deals,0) AS deals,
        COALESCE(d.won,0) AS won, COALESCE(d.pipeline_value,0) AS value,
        CASE WHEN COALESCE(l.leads,0) > 0 THEN COALESCE(l.converted,0)::float8 * 100 / l.leads ELSE 0 END AS rate
      FROM lead_src l
      FULL OUTER JOIN deal_src d ON d.source = l.source
      FULL OUTER JOIN cust_src c ON c.source = COALESCE(l.source, d.source)
      ORDER BY COALESCE(d.pipeline_value,0) DESC, COALESCE(l.leads,0) DESC
      LIMIT 40`.execute(this.db);
    return {
      sources: rows.map((r) => ({
        source: r.source,
        leads: Number(r.leads),
        customers: Number(r.customers),
        deals: Number(r.deals),
        wonDeals: Number(r.won),
        pipelineValue: Number(r.value),
        conversionRate: round2(Number(r.rate)),
      })),
      question: "Which lead/deal sources produce volume and conversions?",
    };
  }

  async summary(f: AnalyticsFilter): Promise<Summary> {
    const leads = await this.leadAnalytics(f);
    const pipe = await this.pipelineAnalytics(f);
    const acts = await this.activityAnalytics(f);
    const conv = await this.conversionAnalytics(f);
    return {
      leadVolume: leads.leadVolume,
      qualifiedLeads: leads.qualifiedLeads,
      deals: pipe.deals,
      submissions: conv.submissions,
      positiveOutcomes: conv.positiveOutcomes,
      conversions: leads.convertedLeads,
      conversionRate: leads.conversionRate,
      averageResponseTimeSeconds: leads.averageResponseTimeSeconds,
      averageStageDurationSeconds: pipe.averageStageDurationSeconds,
      activities: acts.activities,
      pipelineValue: pipe.pipelineValue,
      from: f.from,
      to: f.to,
    };
  }

  organization(f: AnalyticsFilter): Promise<OrganizationAnalytics> {
    return organization(this.db, f);
  }

  /**
   * Lead population by residence country (`leads.country`).
   * Stage buckets follow the active Lead Pipeline names (Lead ≈ New).
   * Conversion rate = won / (won + lost), matching Sales Funnel win rate.
   */
  async countryPopulation(f: AnalyticsFilter, opts: { includePrevious?: boolean } = {}): Promise<CountryPopulationAnalytics> {
    const where = new Where().commonLead("l", f);
    const { rows } = await sql<{
      country: string;
      total: number;
      newCount: number;
      contacted: number;
      qualified: number;
      unqualified: number;
      won: number;
      lost: number;
    }>`
      SELECT
        COALESCE(NULLIF(TRIM(l.country), ''), '(Unknown)') AS country,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(ps.name, '')) IN ('lead', 'new', 'created', 'cold lead')
        )::int AS "newCount",
        COUNT(*) FILTER (WHERE LOWER(COALESCE(ps.name, '')) = 'contacted')::int AS contacted,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(ps.name, '')) = 'qualified')::int AS qualified,
        COUNT(*) FILTER (
          WHERE ps.is_lost = TRUE OR LOWER(COALESCE(ps.name, '')) IN ('lost', 'unqualified')
        )::int AS unqualified,
        COUNT(*) FILTER (
          WHERE ps.is_won = TRUE OR LOWER(COALESCE(ps.name, '')) = 'won'
        )::int AS won,
        COUNT(*) FILTER (
          WHERE ps.is_lost = TRUE OR LOWER(COALESCE(ps.name, '')) IN ('lost', 'unqualified')
        )::int AS lost
      FROM leads l
      LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
      WHERE ${where.sql}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1 ASC`.execute(this.db);

    const countriesRaw = rows.map((r) => ({
      country: r.country,
      totalLeads: Number(r.total),
      newLeads: Number(r.newCount),
      contactedLeads: Number(r.contacted),
      qualifiedLeads: Number(r.qualified),
      unqualifiedLeads: Number(r.unqualified),
      wonLeads: Number(r.won),
      lostLeads: Number(r.lost),
    }));
    const totalLeads = countriesRaw.reduce((s, c) => s + c.totalLeads, 0);
    const newLeads = countriesRaw.reduce((s, c) => s + c.newLeads, 0);
    const qualifiedLeads = countriesRaw.reduce((s, c) => s + c.qualifiedLeads, 0);
    const wonLeads = countriesRaw.reduce((s, c) => s + c.wonLeads, 0);
    const lostLeads = countriesRaw.reduce((s, c) => s + c.lostLeads, 0);
    const closed = wonLeads + lostLeads;

    const countries: CountryPopulationRow[] = countriesRaw.map((c) => {
      const closedCountry = c.wonLeads + c.lostLeads;
      return {
        ...c,
        sharePct: round2(pct(c.totalLeads, totalLeads)),
        conversionRate: round2(pct(c.wonLeads, closedCountry)),
      };
    });

    const kpis: CountryPopulationKpis = {
      totalLeads,
      newLeads,
      qualifiedLeads,
      conversionRate: round2(pct(wonLeads, closed)),
      wonLeads,
      lostLeads,
    };

    let previousKpis: CountryPopulationKpis | null = null;
    if (opts.includePrevious !== false) {
      const durationMs = f.to.ms - f.from.ms;
      if (durationMs > 0) {
        const prevTo = new Date(f.from.ms - 1);
        const prevFrom = new Date(prevTo.getTime() - durationMs);
        const prev = await this.countryPopulation(
          { ...f, from: GoTime.fromDate(prevFrom), to: GoTime.fromDate(prevTo) },
          { includePrevious: false },
        );
        previousKpis = prev.kpis;
      }
    }

    return {
      countries,
      kpis,
      previousKpis,
      from: f.from,
      to: f.to,
      question: "How are leads distributed across countries, and which markets convert?",
      countryField: "country",
      countryFieldLabel: "Lead country (residence / location)",
    };
  }
}

export interface CountryPopulationRow {
  country: string;
  totalLeads: number;
  newLeads: number;
  contactedLeads: number;
  qualifiedLeads: number;
  unqualifiedLeads: number;
  wonLeads: number;
  lostLeads: number;
  sharePct: number;
  conversionRate: number;
}

export interface CountryPopulationKpis {
  totalLeads: number;
  newLeads: number;
  qualifiedLeads: number;
  conversionRate: number;
  wonLeads: number;
  lostLeads: number;
}

export interface CountryPopulationAnalytics {
  countries: CountryPopulationRow[];
  kpis: CountryPopulationKpis;
  previousKpis: CountryPopulationKpis | null;
  from: GoTime;
  to: GoTime;
  question: string;
  countryField: string;
  countryFieldLabel: string;
}

const TEAM_SORT_COLUMNS: Record<string, string> = {
  leadVolume: "lead_volume",
  deals: "deals",
  wonDeals: "won_deals",
  activities: "activities",
  pipelineValue: "pipeline_value",
  conversionRate: "conversion_rate",
  averageStageDurationSeconds: "avg_stage",
};

/** The user breakdown sorts by select-list position. */
const USER_ORDER: Record<string, string> = {
  lead_volume: "3",
  deals: "4",
  won_deals: "5",
  activities: "6",
  conversion_rate: "8",
  avg_stage: "9",
};

const VALID_GROUP_BY = new Set(["team", "user", "period", "pipeline"]);

export class AnalyticsService {
  readonly repo: AnalyticsRepository;

  constructor(db: Database) {
    this.repo = new AnalyticsRepository(db);
  }

  async funnel(f: AnalyticsFilter): Promise<FunnelResult> {
    let pipelineId = f.pipelineId;
    let meta: { name: string; kind: string } | undefined;
    if (pipelineId === "") {
      const def = await this.repo.defaultSalesPipeline().catch(() => undefined);
      if (!def) throw AppError.validation("pipelineId is required (no default sales pipeline found)");
      pipelineId = def.id;
      meta = def;
    } else {
      meta = await this.repo.pipelineMeta(pipelineId).catch(() => undefined);
      if (!meta) throw AppError.notFound("pipeline not found");
    }
    return internal("failed to compute funnel", () => this.repo.funnel(f, pipelineId, meta.name, meta.kind));
  }

  summary(f: AnalyticsFilter): Promise<Summary> {
    return internal("failed to load summary", () => this.repo.summary(f));
  }

  leads(f: AnalyticsFilter): Promise<LeadAnalytics> {
    return internal("failed to load lead analytics", () => this.repo.leadAnalytics(f));
  }

  pipeline(f: AnalyticsFilter): Promise<PipelineAnalytics> {
    return internal("failed to load pipeline analytics", () => this.repo.pipelineAnalytics(f));
  }

  activities(f: AnalyticsFilter): Promise<ActivityAnalytics> {
    return internal("failed to load activity analytics", () => this.repo.activityAnalytics(f));
  }

  conversions(f: AnalyticsFilter): Promise<ConversionAnalytics> {
    return internal("failed to load conversion analytics", () => this.repo.conversionAnalytics(f));
  }

  teams(f: AnalyticsFilter): Promise<TeamAnalytics> {
    // Validated case-insensitively, then matched exactly: "TEAM" falls through to the user breakdown.
    const groupBy = VALID_GROUP_BY.has(f.groupBy.toLowerCase()) ? f.groupBy : "user";
    return internal("failed to load team analytics", () => this.repo.teamAnalytics({ ...f, groupBy }));
  }

  sources(f: AnalyticsFilter): Promise<SourceAnalytics> {
    return internal("failed to load source analytics", () => this.repo.sourceAnalytics(f));
  }

  organization(f: AnalyticsFilter): Promise<OrganizationAnalytics> {
    return internal("failed to load organization analytics", () => this.repo.organization(f));
  }

  countries(f: AnalyticsFilter): Promise<CountryPopulationAnalytics> {
    return internal("failed to load country population analytics", () => this.repo.countryPopulation(f));
  }
}
