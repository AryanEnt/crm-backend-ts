import { sql, type RawBuilder } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import type { GoTime } from "../../lib/go-time.js";
import { internal } from "../../lib/request-meta.js";
import { AttentionSql } from "../attention/attention.js";
import { and, appendScope, type Predicate, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import type { PipelinesRepository } from "../pipelines/pipelines.service.js";

type Frag = RawBuilder<unknown>;

const OPEN = sql`l.status IN ('open','inbox','qualified')`;
const PROBABILITY = sql`COALESCE(l.probability, ps.probability, 0)`;
const STALE_DAYS = 7;
const RECENT_WON_DAYS = 14;
const RECENT_CREATED_DAYS = 7;
const HISTORY_DAYS = 180;
/** Fewer closed leads than this makes the historical win rate unreliable. */
const MIN_CLOSED_SAMPLE = 10;
const DAY_LIST_LIMIT = 6;

export interface InsightScope {
  vis: Visibility;
  /** Restricts to one owner on top of visibility ('' = everyone visible). */
  ownerUserId: string;
  /** Optional narrowing by team id and exact lead source ('' = any). */
  teamId?: string;
  source?: string;
}

export interface CurrencyTotals {
  currency: string;
  openCount: number;
  openValue: number;
  weightedValue: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
}

export interface StageStrip {
  id: string;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  probability: number;
  visualAccent: string;
  count: number;
  value: number;
}

export interface FunnelStep {
  stageId: string;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  reached: number;
  /** Share of leads that reached the first stage, 0-100. */
  rate: number;
}

export interface LeadOverview {
  pipeline: { id: string; name: string } | null;
  range: { from: GoTime; to: GoTime };
  /** Currency of the value fields: the one most open leads use. */
  currency: string;
  mixedCurrency: boolean;
  openLeads: number;
  openValue: number;
  weightedValue: number;
  wonLeads: number;
  wonValue: number;
  lostLeads: number;
  lostValue: number;
  /** won / (won + lost) in the range, 0-100; null with no closed leads. */
  winRate: number | null;
  needingAttention: number;
  noNextActivity: number;
  overdue: number;
  stale: number;
  byCurrency: CurrencyTotals[];
  stages: StageStrip[];
  funnel: FunnelStep[];
}

export interface DayLead {
  id: string;
  fullName: string;
  employer: string;
  stageName: string | null;
  stageAccent: string | null;
  potentialValue: number | null;
  currency: string;
  ownerName: string | null;
  nextActivityAt: Date | null;
  nextActivityTitle: string | null;
  lastActivityAt: Date | null;
  wonAt: Date | null;
  createdAt: Date;
}

export const DAY_BUCKETS = ["overdue", "today", "noNextAction", "stale", "recentlyWon", "recentlyCreated"] as const;
export type DayBucket = (typeof DAY_BUCKETS)[number];

export type MyDay = { counts: Record<DayBucket, number> } & Record<DayBucket, DayLead[]>;

export interface ForecastBucket {
  /** overdue | YYYY-MM | later | no_date */
  key: string;
  count: number;
  value: number;
  weighted: number;
  /** Leads in the bucket with no value. */
  noValue: number;
}

export interface LeadForecast {
  currency: string;
  mixedCurrency: boolean;
  months: number;
  buckets: ForecastBucket[];
  totals: { count: number; value: number; weighted: number; historicalAdjusted: number | null };
  historicalWinRate: number | null;
  closedSample: number;
  limitations: string[];
}

export interface OwnerRow {
  ownerUserId: string | null;
  ownerName: string | null;
  openLeads: number;
  openValue: number;
  wonLeads: number;
  wonValue: number;
  lostLeads: number;
  /** won / (won + lost) in the range, 0-100; null with no closed leads. */
  winRate: number | null;
  /** Activities logged on the owner's leads in the range. */
  activities: number;
}

export interface LeadOwnerBreakdown {
  range: { from: GoTime; to: GoTime };
  currency: string;
  mixedCurrency: boolean;
  rows: OwnerRow[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The currency most open leads use; ties go to the larger open value. */
function primaryCurrency(rows: { currency: string; openCount: number; openValue: number }[]): string {
  const best = [...rows].sort((a, b) => b.openCount - a.openCount || b.openValue - a.openValue)[0];
  return best?.currency ?? "AUD";
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Lead KPIs, the dashboard queue and the forecast, computed from leads only. */
export class LeadInsightsService {
  constructor(
    private readonly db: Database,
    private readonly pipelines: PipelinesRepository,
  ) {}

  private base(s: InsightScope, pipelineId: string): Predicate[] {
    const where: Predicate[] = [sql`l.is_archived = FALSE`];
    if (pipelineId !== "") where.push(sql`l.pipeline_id::text = ${pipelineId}`);
    if (s.ownerUserId !== "") where.push(sql`l.owner_user_id::text = ${s.ownerUserId}`);
    if (s.teamId) where.push(sql`l.team_id::text = ${s.teamId}`);
    if (s.source) where.push(sql`l.source = ${s.source}`);
    return appendScope(where, s.vis, Records.Leads.columns);
  }

  private async resolvePipeline(pipelineId: string) {
    let id = pipelineId;
    if (id === "") {
      const r = await sql<{ id: string }>`
        SELECT id::text AS "id" FROM pipelines WHERE kind = 'leads' AND is_active
        ORDER BY is_default DESC, created_at LIMIT 1`.execute(this.db);
      id = r.rows[0]?.id ?? "";
      if (id === "") return null;
    }
    const p = await this.pipelines.get(id);
    if (!p) throw AppError.notFound("pipeline not found");
    if (p.kind !== "leads") throw AppError.validation("pipeline is not a lead pipeline");
    return p;
  }

  async overview(s: InsightScope, pipelineId: string, from: GoTime, to: GoTime): Promise<LeadOverview> {
    return internal("failed to load lead overview", async () => {
      const where = this.base(s, pipelineId);
      const fromTs: Frag = sql`${from.sql}::timestamptz`;
      const toTs: Frag = sql`${to.sql}::timestamptz`;
      const wonIn = sql`l.won_at IS NOT NULL AND l.won_at >= ${fromTs} AND l.won_at <= ${toTs}`;
      const lostIn = sql`l.status = 'lost' AND l.lost_at >= ${fromTs} AND l.lost_at <= ${toTs}`;

      const totals = await sql<CurrencyTotals>`
        SELECT l.currency,
          COUNT(*) FILTER (WHERE ${OPEN})::int AS "openCount",
          COALESCE(SUM(l.potential_value) FILTER (WHERE ${OPEN}), 0)::float8 AS "openValue",
          COALESCE(SUM(l.potential_value * ${PROBABILITY} / 100) FILTER (WHERE ${OPEN}), 0)::float8 AS "weightedValue",
          COUNT(*) FILTER (WHERE ${wonIn})::int AS "wonCount",
          COALESCE(SUM(l.potential_value) FILTER (WHERE ${wonIn}), 0)::float8 AS "wonValue",
          COUNT(*) FILTER (WHERE ${lostIn})::int AS "lostCount",
          COALESCE(SUM(l.potential_value) FILTER (WHERE ${lostIn}), 0)::float8 AS "lostValue"
        FROM leads l
        LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
        WHERE ${and(where)}
        GROUP BY l.currency
        ORDER BY l.currency`.execute(this.db);
      const byCurrency = totals.rows;
      const currency = primaryCurrency(byCurrency);
      const cur = byCurrency.find((r) => r.currency === currency);
      const sum = (k: "openCount" | "wonCount" | "lostCount") => byCurrency.reduce((n, r) => n + r[k], 0);

      const att = await sql<{ needingAttention: number; noNextActivity: number; overdue: number; stale: number }>`
        SELECT
          COUNT(*) FILTER (WHERE (${sql.raw(AttentionSql.lead)}) <> '')::int AS "needingAttention",
          COUNT(*) FILTER (WHERE l.next_activity_at IS NULL)::int AS "noNextActivity",
          COUNT(*) FILTER (WHERE l.next_activity_at <= NOW())::int AS "overdue",
          COUNT(*) FILTER (WHERE COALESCE(l.last_activity_at, l.created_at) < NOW() - make_interval(days => ${STALE_DAYS}))::int AS "stale"
        FROM leads l
        LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
        WHERE ${and([...where, OPEN])}`.execute(this.db);
      const a = att.rows[0] ?? { needingAttention: 0, noNextActivity: 0, overdue: 0, stale: 0 };

      const pipeline = await this.resolvePipeline(pipelineId);
      let stages: StageStrip[] = [];
      let funnel: FunnelStep[] = [];
      if (pipeline) {
        const pWhere = this.base(s, pipeline.id);
        const strip = await sql<{ stageId: string | null; count: number; value: number }>`
          SELECT l.stage_id::text AS "stageId", COUNT(*)::int AS "count",
            COALESCE(SUM(l.potential_value) FILTER (WHERE l.currency = ${currency}), 0)::float8 AS "value"
          FROM leads l
          WHERE ${and([...pWhere, sql`(${OPEN} OR (${wonIn}) OR (${lostIn}))`])}
          GROUP BY l.stage_id`.execute(this.db);
        const byStage = new Map(strip.rows.map((r) => [r.stageId ?? "", r]));
        const active = pipeline.stages.filter((st) => st.isActive);
        stages = active.map((st) => ({
          id: st.id,
          name: st.name,
          position: st.position,
          isWon: st.isWon,
          isLost: st.isLost,
          probability: st.probability,
          visualAccent: st.visualAccent,
          count: byStage.get(st.id)?.count ?? 0,
          value: byStage.get(st.id)?.value ?? 0,
        }));

        const reached = await sql<{ stageId: string; reached: number }>`
          WITH per AS (
            SELECT t.lead_id,
              MAX(tps.position) FILTER (WHERE NOT tps.is_lost) AS reached,
              BOOL_OR(tps.is_lost) AS lost
            FROM lead_stage_transitions t
            JOIN pipeline_stages tps ON tps.id = t.to_stage_id
            JOIN leads l ON l.id = t.lead_id
            WHERE ${and([...pWhere, sql`t.to_pipeline_id::text = ${pipeline.id}`, sql`t.entered_at >= ${fromTs}`, sql`t.entered_at <= ${toTs}`])}
            GROUP BY t.lead_id
          )
          SELECT s.id::text AS "stageId",
            (CASE WHEN s.is_lost THEN COUNT(*) FILTER (WHERE per.lost) ELSE COUNT(*) FILTER (WHERE per.reached >= s.position) END)::int AS "reached"
          FROM pipeline_stages s CROSS JOIN per
          WHERE s.pipeline_id::text = ${pipeline.id} AND s.is_active
          GROUP BY s.id, s.is_lost`.execute(this.db);
        const reachedBy = new Map(reached.rows.map((r) => [r.stageId, r.reached]));
        const top = active[0] ? (reachedBy.get(active[0].id) ?? 0) : 0;
        funnel = active.map((st) => {
          const n = reachedBy.get(st.id) ?? 0;
          return {
            stageId: st.id,
            name: st.name,
            position: st.position,
            isWon: st.isWon,
            isLost: st.isLost,
            reached: n,
            rate: top > 0 ? round2((n / top) * 100) : 0,
          };
        });
      }

      const won = sum("wonCount");
      const lost = sum("lostCount");
      return {
        pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
        range: { from, to },
        currency,
        mixedCurrency: byCurrency.length > 1,
        openLeads: sum("openCount"),
        openValue: cur?.openValue ?? 0,
        weightedValue: round2(cur?.weightedValue ?? 0),
        wonLeads: won,
        wonValue: cur?.wonValue ?? 0,
        lostLeads: lost,
        lostValue: cur?.lostValue ?? 0,
        winRate: won + lost > 0 ? round2((won / (won + lost)) * 100) : null,
        needingAttention: a.needingAttention,
        noNextActivity: a.noNextActivity,
        overdue: a.overdue,
        stale: a.stale,
        byCurrency,
        stages,
        funnel,
      };
    });
  }

  /** Per-owner open, won and lost leads; values cover the primary currency only. */
  async byOwner(s: InsightScope, pipelineId: string, from: GoTime, to: GoTime): Promise<LeadOwnerBreakdown> {
    return internal("failed to load lead owner breakdown", async () => {
      const where = this.base(s, pipelineId);
      const fromTs: Frag = sql`${from.sql}::timestamptz`;
      const toTs: Frag = sql`${to.sql}::timestamptz`;
      const wonIn = sql`l.won_at IS NOT NULL AND l.won_at >= ${fromTs} AND l.won_at <= ${toTs}`;
      const lostIn = sql`l.status = 'lost' AND l.lost_at >= ${fromTs} AND l.lost_at <= ${toTs}`;

      const cur = await sql<{ currency: string; openCount: number; openValue: number }>`
        SELECT l.currency, COUNT(*)::int AS "openCount", COALESCE(SUM(l.potential_value), 0)::float8 AS "openValue"
        FROM leads l WHERE ${and([...where, OPEN])}
        GROUP BY l.currency`.execute(this.db);
      const currency = primaryCurrency(cur.rows);

      const rows = await sql<Omit<OwnerRow, "winRate" | "activities">>`
        SELECT l.owner_user_id::text AS "ownerUserId", MAX(u.full_name) AS "ownerName",
          COUNT(*) FILTER (WHERE ${OPEN})::int AS "openLeads",
          COALESCE(SUM(l.potential_value) FILTER (WHERE ${OPEN} AND l.currency = ${currency}), 0)::float8 AS "openValue",
          COUNT(*) FILTER (WHERE ${wonIn})::int AS "wonLeads",
          COALESCE(SUM(l.potential_value) FILTER (WHERE ${wonIn} AND l.currency = ${currency}), 0)::float8 AS "wonValue",
          COUNT(*) FILTER (WHERE ${lostIn})::int AS "lostLeads"
        FROM leads l
        LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ${and([...where, sql`(${OPEN} OR (${wonIn}) OR (${lostIn}))`])}
        GROUP BY l.owner_user_id`.execute(this.db);

      const acts = await sql<{ ownerUserId: string | null; n: number }>`
        SELECT l.owner_user_id::text AS "ownerUserId", COUNT(a.id)::int AS "n"
        FROM activities a
        JOIN leads l ON l.id = a.lead_id
        WHERE ${and([...where, sql`a.created_at >= ${fromTs}`, sql`a.created_at <= ${toTs}`])}
        GROUP BY l.owner_user_id`.execute(this.db);
      const actsBy = new Map(acts.rows.map((r) => [r.ownerUserId ?? "", r.n]));

      const out: OwnerRow[] = rows.rows.map((r) => {
        const closed = r.wonLeads + r.lostLeads;
        return {
          ...r,
          winRate: closed > 0 ? round2((r.wonLeads / closed) * 100) : null,
          activities: actsBy.get(r.ownerUserId ?? "") ?? 0,
        };
      });
      out.sort((a, b) => b.openValue - a.openValue || b.openLeads - a.openLeads || b.wonLeads - a.wonLeads);
      return { range: { from, to }, currency, mixedCurrency: cur.rows.length > 1, rows: out };
    });
  }

  private async dayList(where: Predicate[], order: Frag): Promise<{ items: DayLead[]; total: number }> {
    const r = await sql<DayLead & { total: number }>`
      SELECT l.id::text AS "id", l.full_name AS "fullName", l.employer, ps.name AS "stageName", ps.visual_accent AS "stageAccent",
        l.potential_value AS "potentialValue", l.currency, ou.full_name AS "ownerName",
        l.next_activity_at AS "nextActivityAt", na.title AS "nextActivityTitle", l.last_activity_at AS "lastActivityAt",
        l.won_at AS "wonAt", l.created_at AS "createdAt", COUNT(*) OVER ()::int AS "total"
      FROM leads l
      LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
      LEFT JOIN users ou ON ou.id = l.owner_user_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(a.title, ''), NULLIF(a.subject, ''), t.name, 'Follow up') AS title
        FROM activities a
        LEFT JOIN activity_types t ON t.id = a.activity_type_id
        WHERE a.lead_id = l.id AND a.status IN ('upcoming', 'due', 'overdue')
        ORDER BY a.due_at ASC NULLS LAST
        LIMIT 1
      ) na ON TRUE
      WHERE ${and(where)}
      ORDER BY ${order}
      LIMIT ${DAY_LIST_LIMIT}`.execute(this.db);
    return { items: r.rows.map(({ total: _t, ...lead }) => lead), total: r.rows[0]?.total ?? 0 };
  }

  /** Today's work queue; tz is a validated IANA zone that defines "today". */
  async myDay(s: InsightScope, tz: string): Promise<MyDay> {
    return internal("failed to load my day", async () => {
      const where = this.base(s, "");
      const open = [...where, OPEN];
      const endOfToday = sql`(date_trunc('day', NOW() AT TIME ZONE ${tz}) + INTERVAL '1 day') AT TIME ZONE ${tz}`;
      const lists: Record<DayBucket, [Predicate[], Frag]> = {
        overdue: [[...open, sql`l.next_activity_at < NOW()`], sql`l.next_activity_at ASC`],
        today: [[...open, sql`l.next_activity_at >= NOW()`, sql`l.next_activity_at < ${endOfToday}`], sql`l.next_activity_at ASC`],
        noNextAction: [[...open, sql`l.next_activity_at IS NULL`], sql`l.created_at DESC`],
        stale: [
          [...open, sql`COALESCE(l.last_activity_at, l.created_at) < NOW() - make_interval(days => ${STALE_DAYS})`],
          sql`COALESCE(l.last_activity_at, l.created_at) ASC`,
        ],
        recentlyWon: [
          [...where, sql`l.won_at IS NOT NULL`, sql`l.won_at >= NOW() - make_interval(days => ${RECENT_WON_DAYS})`],
          sql`l.won_at DESC`,
        ],
        recentlyCreated: [[...open, sql`l.created_at >= NOW() - make_interval(days => ${RECENT_CREATED_DAYS})`], sql`l.created_at DESC`],
      };
      const out = { counts: {} } as MyDay;
      for (const key of DAY_BUCKETS) {
        const [w, order] = lists[key];
        const { items, total } = await this.dayList(w, order);
        out[key] = items;
        out.counts[key] = total;
      }
      return out;
    });
  }

  /**
   * Open lead value by expected close month, weighted by stage probability, plus a
   * historical-win-rate view. Values cover the primary currency only.
   */
  async forecast(s: InsightScope, pipelineId: string, months: number, now = new Date()): Promise<LeadForecast> {
    const horizon = Math.min(Math.max(Math.trunc(months) || 3, 1), 12);
    return internal("failed to load lead forecast", async () => {
      const where = this.base(s, pipelineId);
      const rows = await sql<{ key: string; currency: string; count: number; value: number; weighted: number; noValue: number }>`
        SELECT
          CASE WHEN l.expected_close_at IS NULL THEN 'no_date'
            WHEN l.expected_close_at < CURRENT_DATE THEN 'overdue'
            ELSE to_char(l.expected_close_at, 'YYYY-MM') END AS "key",
          l.currency,
          COUNT(*)::int AS "count",
          COALESCE(SUM(l.potential_value), 0)::float8 AS "value",
          COALESCE(SUM(l.potential_value * ${PROBABILITY} / 100), 0)::float8 AS "weighted",
          COUNT(*) FILTER (WHERE l.potential_value IS NULL)::int AS "noValue"
        FROM leads l
        LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
        WHERE ${and([...where, OPEN])}
        GROUP BY 1, 2`.execute(this.db);

      const perCurrency = new Map<string, { currency: string; openCount: number; openValue: number }>();
      for (const r of rows.rows) {
        const c = perCurrency.get(r.currency) ?? { currency: r.currency, openCount: 0, openValue: 0 };
        c.openCount += r.count;
        c.openValue += r.value;
        perCurrency.set(r.currency, c);
      }
      const currency = primaryCurrency([...perCurrency.values()]);

      const monthKeys: string[] = [];
      for (let i = 0; i < horizon; i++) {
        monthKeys.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))));
      }
      const order = ["overdue", ...monthKeys, "later", "no_date"];
      const buckets = new Map(order.map((k) => [k, { key: k, count: 0, value: 0, weighted: 0, noValue: 0 }]));
      for (const r of rows.rows) {
        const key = r.key === "overdue" || r.key === "no_date" ? r.key : monthKeys.includes(r.key) ? r.key : "later";
        const b = buckets.get(key)!;
        b.count += r.count;
        b.noValue += r.noValue;
        if (r.currency === currency) {
          b.value += r.value;
          b.weighted += r.weighted;
        }
      }
      const list = order.map((k) => {
        const b = buckets.get(k)!;
        return { ...b, value: round2(b.value), weighted: round2(b.weighted) };
      });

      const hist = await sql<{ won: number; closed: number }>`
        SELECT COUNT(*) FILTER (WHERE l.won_at IS NOT NULL)::int AS "won", COUNT(*)::int AS "closed"
        FROM leads l
        WHERE ${and([
          ...where,
          sql`((l.won_at IS NOT NULL AND l.won_at >= NOW() - make_interval(days => ${HISTORY_DAYS}))
            OR (l.status = 'lost' AND l.lost_at >= NOW() - make_interval(days => ${HISTORY_DAYS})))`,
        ])}`.execute(this.db);
      const { won, closed } = hist.rows[0] ?? { won: 0, closed: 0 };
      const winRate = closed > 0 ? won / closed : null;

      const inWindow = list.filter((b) => b.key === "overdue" || monthKeys.includes(b.key));
      const value = inWindow.reduce((n, b) => n + b.value, 0);
      const weighted = inWindow.reduce((n, b) => n + b.weighted, 0);
      const count = inWindow.reduce((n, b) => n + b.count, 0);

      const limitations: string[] = ["Probabilities come from stage defaults, not a predictive model."];
      const noDate = buckets.get("no_date")!.count;
      if (noDate > 0) limitations.push(`${noDate} open lead${noDate === 1 ? " has" : "s have"} no expected close date and are not forecast.`);
      const noValue = list.reduce((n, b) => n + b.noValue, 0);
      if (noValue > 0) limitations.push(`${noValue} open lead${noValue === 1 ? " has" : "s have"} no value and count as zero.`);
      if (closed < MIN_CLOSED_SAMPLE) {
        limitations.push(
          `Only ${closed} lead${closed === 1 ? " was" : "s were"} won or lost in the last ${HISTORY_DAYS} days; the historical win rate is not reliable yet.`,
        );
      }
      if (perCurrency.size > 1) limitations.push(`Values cover ${currency} leads only; other currencies are counted but not summed.`);
      const overdue = buckets.get("overdue")!.count;
      if (overdue > 0) limitations.push(`${overdue} open lead${overdue === 1 ? " is" : "s are"} past the expected close date.`);

      return {
        currency,
        mixedCurrency: perCurrency.size > 1,
        months: horizon,
        buckets: list,
        totals: {
          count,
          value: round2(value),
          weighted: round2(weighted),
          historicalAdjusted: winRate === null ? null : round2(value * winRate),
        },
        historicalWinRate: winRate === null ? null : round2(winRate * 100),
        closedSample: closed,
        limitations,
      };
    });
  }
}
