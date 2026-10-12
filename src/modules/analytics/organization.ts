import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import type { GoTime } from "../../lib/go-time.js";
import { metricRows, pct, round2, ts, Where, type AnalyticsFilter, type Frag, type MetricPoint } from "./analytics.filter.js";

export interface OrganizationAnalytics {
  topMetrics: {
    totalUsers: number;
    activeUsers: number;
    totalTeams: number;
    totalLeads: number;
    totalCustomers: number;
    totalDeals: number;
    activeDeals: number;
    completedActivities: number;
    pipelineValue: number;
  };
  userAdoption: {
    activeUsers: number;
    usersWithActivity: number;
    usersWithNoRecentActivity: number;
    activitiesCreated: number;
    activitiesCompleted: number;
  };
  growth: { leads: MetricPoint[]; customers: MetricPoint[]; deals: MetricPoint[]; activities: MetricPoint[] };
  pipelineOverview: {
    activePipelineValue: number;
    dealsByPipeline: MetricPoint[];
    dealsByStage: MetricPoint[];
    avgDealValue: number;
  };
  conversionOverview: { leads: number; qualifiedLeads: number; deals: number; conversions: number; conversionRate: number };
  referralOverview: { total: number; active: number; converted: number; pipelineValue: number; trend: MetricPoint[] };
  from: GoTime;
  to: GoTime;
}

const growthTrunc = (f: AnalyticsFilter) => sql.raw(f.period === "week" ? "week" : f.period === "month" ? "month" : "day");

// Activities carry no team or pipeline; both come from the linked deal, lead or customer.
const activityTeam = (id: string) => sql`(EXISTS (SELECT 1 FROM deals d WHERE d.id = a.deal_id AND d.team_id::text = ${id})
    OR EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.team_id::text = ${id})
    OR EXISTS (SELECT 1 FROM customers c WHERE c.id = a.customer_id AND c.team_id::text = ${id}))`;
const activityPipeline = (id: string) => sql`(EXISTS (SELECT 1 FROM deals d WHERE d.id = a.deal_id AND d.pipeline_id::text = ${id})
    OR EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.pipeline_id::text = ${id})
    OR EXISTS (SELECT 1 FROM customers c WHERE c.id = a.customer_id AND c.pipeline_id::text = ${id}))`;

function activityDims(w: Where, f: AnalyticsFilter): Where {
  if (f.ownerUserId !== "") w.add(sql`COALESCE(a.owner_user_id, a.actor_user_id)::text = ${f.ownerUserId}`);
  if (f.teamId !== "") w.add(activityTeam(f.teamId));
  if (f.pipelineId !== "") w.add(activityPipeline(f.pipelineId));
  return w;
}

/** Users in the selected team and/or the selected owner. */
function userDims(w: Where, f: AnalyticsFilter): Where {
  if (f.teamId !== "") {
    w.add(sql`EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id::text = ${f.teamId})`);
  }
  return w.eqText("u.id", f.ownerUserId);
}

/** Referrals narrowed through the lead or customer they point to. */
function referralDims(w: Where, f: AnalyticsFilter): Where {
  if (f.pipelineId !== "") w.add(sql`COALESCE(c.pipeline_id, l.pipeline_id)::text = ${f.pipelineId}`);
  if (f.teamId !== "") w.add(sql`COALESCE(c.team_id, l.team_id)::text = ${f.teamId}`);
  if (f.ownerUserId !== "") w.add(sql`COALESCE(c.owner_user_id, l.owner_user_id)::text = ${f.ownerUserId}`);
  return w;
}

async function one<T>(db: Database, q: Frag): Promise<T> {
  const { rows } = await sql<T>`${q}`.execute(db);
  return rows[0]!;
}

/**
 * Totals, adoption, growth, pipeline, conversion and referrals. Totals are current snapshots
 * narrowed by pipeline/team/owner; everything else is also limited to the from–to range.
 */
export async function organization(db: Database, f: AnalyticsFilter): Promise<OrganizationAnalytics> {
  // Top metrics
  const users = await one<{ total: number; active: number }>(db, sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE u.is_active)::int AS active
    FROM users u WHERE ${userDims(new Where(), f).sql}`);

  const tw = new Where().eq("t.is_active", true).eqText("t.id", f.teamId);
  if (f.ownerUserId !== "") {
    tw.add(sql`EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id::text = ${f.ownerUserId})`);
  }
  const teams = await one<{ n: number }>(db, sql`SELECT COUNT(*)::int AS n FROM teams t WHERE ${tw.sql}`);
  const leads = await one<{ n: number }>(
    db,
    sql`SELECT COUNT(*)::int AS n FROM leads l WHERE ${new Where().eq("l.is_archived", false).recordDims("l", f).sql}`,
  );
  const customers = await one<{ n: number }>(
    db,
    sql`SELECT COUNT(*)::int AS n FROM customers c WHERE ${new Where().eq("c.is_archived", false).recordDims("c", f).sql}`,
  );
  const deals = await one<{ total: number; open: number; value: number }>(db, sql`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE d.status = 'open')::int AS open,
      COALESCE(SUM(d.value) FILTER (WHERE d.status = 'open'), 0)::float8 AS value
    FROM deals d WHERE ${new Where().recordDims("d", f).sql}`);
  const completed = await one<{ n: number }>(
    db,
    sql`SELECT COUNT(*)::int AS n FROM activities a WHERE ${activityDims(new Where().eq("a.status", "completed"), f).sql}`,
  );

  // Adoption
  const acts = await one<{ created: number; completed: number }>(db, sql`
    SELECT COUNT(*)::int AS created, COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed
    FROM activities a WHERE ${activityDims(new Where().inRange("a.created_at", f), f).sql}`);
  // Both counts use the same user set so "no recent activity" can't go negative.
  const uw = userDims(new Where().eq("u.is_active", true), f);
  const recent = sql`EXISTS (SELECT 1 FROM activities a
    WHERE COALESCE(a.owner_user_id, a.actor_user_id) = u.id AND a.created_at >= ${ts(f.from)} AND a.created_at <= ${ts(f.to)}${
      f.pipelineId !== "" ? sql` AND ${activityPipeline(f.pipelineId)}` : sql``
    })`;
  const activeUsers = await one<{ n: number }>(db, sql`SELECT COUNT(*)::int AS n FROM users u WHERE ${uw.sql}`);
  const withActivity = await one<{ n: number }>(
    db,
    sql`SELECT COUNT(*)::int AS n FROM users u WHERE ${uw.clone().add(recent).sql}`,
  );

  // Growth
  const trunc = growthTrunc(f);
  const series = (table: string, alias: string, w: Where) =>
    metricRows(db, sql`
      SELECT to_char(date_trunc('${trunc}', ${sql.raw(alias)}.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key, COUNT(*)::float8 AS value
      FROM ${sql.raw(table)} ${sql.raw(alias)} WHERE ${w.sql} GROUP BY 1 ORDER BY 1 ASC`);
  const growthLeads = await series("leads", "l", new Where().inRange("l.created_at", f).eq("l.is_archived", false).recordDims("l", f));
  const growthCustomers = await series(
    "customers",
    "c",
    new Where().inRange("c.created_at", f).eq("c.is_archived", false).recordDims("c", f),
  );
  const growthDeals = await series("deals", "d", new Where().inRange("d.created_at", f).recordDims("d", f));
  const growthActivities = await series("activities", "a", activityDims(new Where().inRange("a.created_at", f), f));

  // Pipeline
  const pw = new Where().eq("d.status", "open").recordDims("d", f).sql;
  const pipe = await one<{ value: number; avg: number }>(db, sql`
    SELECT COALESCE(SUM(d.value),0)::float8 AS value, COALESCE(AVG(d.value),0)::float8 AS avg
    FROM deals d WHERE ${pw}`);
  const byPipeline = await metricRows(
    db,
    sql`
      SELECT COALESCE(p.id::text,'none') AS key, COALESCE(p.name,'No pipeline') AS label, COUNT(*)::float8 AS value
      FROM deals d
      LEFT JOIN pipelines p ON p.id = d.pipeline_id
      WHERE ${pw}
      GROUP BY p.id, p.name
      ORDER BY 3 DESC`,
    true,
  );
  const byStage = await metricRows(
    db,
    sql`
      SELECT COALESCE(ps.id::text,'none') AS key, COALESCE(ps.name,'Unstaged') AS label, COUNT(*)::float8 AS value
      FROM deals d
      LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
      WHERE ${pw}
      GROUP BY ps.id, ps.name, ps.position
      ORDER BY COALESCE(ps.position, 999)`,
    true,
  );

  // Conversion
  const conv = await one<{ leads: number; qualified: number }>(db, sql`
    SELECT
      COUNT(*)::int AS leads,
      COUNT(*) FILTER (WHERE l.status = 'converted'
        OR EXISTS (
          SELECT 1 FROM pipeline_stages ps
          WHERE ps.id = l.stage_id AND (ps.is_won = TRUE OR lower(ps.name) LIKE '%qualif%')
        ))::int AS qualified
    FROM leads l WHERE ${new Where().commonLead("l", f).sql}`);
  const convDeals = await one<{ deals: number; conversions: number }>(db, sql`
    SELECT
      COUNT(*)::int AS deals,
      COUNT(*) FILTER (WHERE d.status = 'won' OR EXISTS (
        SELECT 1 FROM pipeline_stages ps WHERE ps.id = d.stage_id AND ps.is_won = TRUE
      ))::int AS conversions
    FROM deals d WHERE ${new Where().inRange("d.created_at", f).recordDims("d", f).sql}`);

  // Referrals
  const refFrom = sql`
    FROM referrals r
    JOIN referral_statuses rs ON rs.id = r.status_id
    LEFT JOIN leads l ON l.id = r.lead_id
    LEFT JOIN customers c ON c.id = r.customer_id`;
  const rw = referralDims(new Where().inRange("r.created_at", f), f).sql;
  const refs = await one<{ total: number; active: number; converted: number; value: number }>(db, sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE rs.code = 'active')::int AS active,
      COUNT(*) FILTER (WHERE rs.is_converted = TRUE)::int AS converted,
      COALESCE(SUM(COALESCE(c.potential_value, l.potential_value)) FILTER (
        WHERE rs.is_converted = FALSE AND rs.code <> 'cancelled'
      ), 0)::float8 AS value
    ${refFrom} WHERE ${rw}`);
  const trend = await metricRows(db, sql`
    SELECT to_char(date_trunc('${trunc}', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key, COUNT(*)::float8 AS value
    ${refFrom} WHERE ${rw} GROUP BY 1 ORDER BY 1 ASC`);

  const convLeads = Number(conv.leads);
  const conversions = Number(convDeals.conversions);
  return {
    topMetrics: {
      totalUsers: users.total,
      activeUsers: users.active,
      totalTeams: teams.n,
      totalLeads: leads.n,
      totalCustomers: customers.n,
      totalDeals: deals.total,
      activeDeals: deals.open,
      completedActivities: completed.n,
      pipelineValue: deals.value,
    },
    userAdoption: {
      activeUsers: activeUsers.n,
      usersWithActivity: withActivity.n,
      usersWithNoRecentActivity: Math.max(activeUsers.n - withActivity.n, 0),
      activitiesCreated: acts.created,
      activitiesCompleted: acts.completed,
    },
    growth: { leads: growthLeads, customers: growthCustomers, deals: growthDeals, activities: growthActivities },
    pipelineOverview: {
      activePipelineValue: pipe.value,
      dealsByPipeline: byPipeline,
      dealsByStage: byStage,
      avgDealValue: round2(pipe.avg),
    },
    conversionOverview: {
      leads: convLeads,
      qualifiedLeads: Number(conv.qualified),
      deals: Number(convDeals.deals),
      conversions,
      conversionRate: round2(pct(conversions, convLeads)),
    },
    referralOverview: {
      total: refs.total,
      active: refs.active,
      converted: refs.converted,
      pipelineValue: refs.value,
      trend,
    },
    from: f.from,
    to: f.to,
  };
}
