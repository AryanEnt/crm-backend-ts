import { sql, type RawBuilder } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { GoTime, parseDateOnly, parseRfc3339 } from "../../lib/go-time.js";

/** The shared analytics query filter. */
export interface AnalyticsFilter {
  from: GoTime;
  to: GoTime;
  pipelineId: string;
  teamId: string;
  ownerUserId: string;
  source: string;
  anzscoId: string;
  /** Exact lead.country match; "(Unknown)" means blank country. */
  country: string;
  /** Optional pipeline stage filter. */
  stageId: string;
  /** team | user | period | pipeline */
  groupBy: string;
  /** day | week | month */
  period: string;
  sortBy: string;
  sortDir: string;
  /** Bound breakdown rows; null means unrestricted. */
  scopeUserIds: string[] | null;
  scopeTeamIds: string[] | null;
}

export const FILTER_KEYS = [
  "from", "to", "pipelineId", "teamId", "ownerUserId", "source", "anzscoId",
  "country", "stageId",
  "groupBy", "period", "sortBy", "sortDir",
] as const;

const INVALID_DATE = "invalid date; use YYYY-MM-DD or RFC3339";

function parseTime(raw: string): GoTime {
  const t = parseRfc3339(raw) ?? parseDateOnly(raw);
  if (!t) throw AppError.validation(INVALID_DATE);
  return GoTime.fromDate(t);
}

/** Go analytics.ParseFilter; the default range is the last 90 days. */
export function parseFilter(q: Record<string, string>, now = new Date()): AnalyticsFilter {
  const get = (k: string) => (q[k] ?? "").trim();
  const sortDir = get("sortDir").toLowerCase();
  const f: AnalyticsFilter = {
    from: GoTime.fromDate(now),
    to: GoTime.fromDate(now),
    pipelineId: get("pipelineId"),
    teamId: get("teamId"),
    ownerUserId: get("ownerUserId"),
    source: get("source"),
    anzscoId: get("anzscoId"),
    country: get("country"),
    stageId: get("stageId"),
    groupBy: get("groupBy") || "user",
    period: get("period") || "month",
    sortBy: get("sortBy"),
    sortDir: sortDir === "asc" ? "asc" : "desc",
    scopeUserIds: null,
    scopeTeamIds: null,
  };

  const fromRaw = get("from");
  const toRaw = get("to");
  if (fromRaw === "" && toRaw === "") {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 90);
    f.from = GoTime.fromDate(from);
    return f;
  }
  f.from = fromRaw !== "" ? parseTime(fromRaw) : GoTime.fromDate(new Date(0));
  if (toRaw !== "") {
    f.to = parseTime(toRaw);
    // A date-only end is inclusive of the whole day.
    if (toRaw.length === 10) f.to = f.to.endOfDay();
  }
  return f;
}

export type Frag = RawBuilder<unknown>;

export const ts = (t: GoTime): Frag => sql`${t.sql}::timestamptz`;

/** Nil slices bind as SQL NULL so "$n::text[] IS NULL" means unrestricted. */
export const textArray = (ids: string[] | null): Frag => sql`${ids}::text[]`;

/** Dynamic AND-ed WHERE clause (Go sqlBuilder). */
export class Where {
  private readonly parts: Frag[] = [];

  add(p: Frag): this {
    this.parts.push(p);
    return this;
  }

  clone(): Where {
    const w = new Where();
    w.parts.push(...this.parts);
    return w;
  }

  get sql(): Frag {
    return this.parts.length === 0 ? sql`TRUE` : sql.join(this.parts, sql` AND `);
  }

  inRange(column: string, f: AnalyticsFilter): this {
    return this.add(sql`${sql.raw(column)} >= ${ts(f.from)}`).add(sql`${sql.raw(column)} <= ${ts(f.to)}`);
  }

  eqText(column: string, value: string): this {
    return value === "" ? this : this.add(sql`${sql.raw(column)}::text = ${value}`);
  }

  eq(column: string, value: unknown): this {
    return this.add(sql`${sql.raw(column)} = ${value}`);
  }

  /** Go applyCommonLead. */
  commonLead(alias: string, f: AnalyticsFilter): this {
    this.inRange(`${alias}.created_at`, f)
      .eq(`${alias}.is_archived`, false)
      .eqText(`${alias}.pipeline_id`, f.pipelineId)
      .eqText(`${alias}.team_id`, f.teamId)
      .eqText(`${alias}.owner_user_id`, f.ownerUserId)
      .eq2(`${alias}.source`, f.source)
      .eqText(`${alias}.anzsco_id`, f.anzscoId)
      .eqText(`${alias}.stage_id`, f.stageId);
    if (f.country !== "") {
      if (f.country === "(Unknown)" || f.country === "(none)") {
        this.add(sql`TRIM(${sql.raw(`${alias}.country`)}) = ''`);
      } else {
        this.eq2(`${alias}.country`, f.country);
      }
    }
    return this;
  }

  /** Deal team/owner/source/anzsco filters; anzsco needs customers joined as "c". */
  dealDims(f: AnalyticsFilter, opts: { pipeline?: boolean; anzsco?: boolean } = {}): this {
    if (opts.pipeline) this.eqText("d.pipeline_id", f.pipelineId);
    this.eqText("d.team_id", f.teamId).eqText("d.owner_user_id", f.ownerUserId).eq2("d.source", f.source);
    if (opts.anzsco ?? true) this.eqText("c.anzsco_id", f.anzscoId);
    return this;
  }

  /** Go recordDims: pipeline, team and owner on a leads/customers/deals alias. */
  recordDims(alias: string, f: AnalyticsFilter): this {
    return this.eqText(`${alias}.pipeline_id`, f.pipelineId)
      .eqText(`${alias}.team_id`, f.teamId)
      .eqText(`${alias}.owner_user_id`, f.ownerUserId);
  }

  /** Equality on a text column, skipped when value is blank. */
  eq2(column: string, value: string): this {
    return value === "" ? this : this.eq(column, value);
  }
}

export interface MetricPoint {
  key: string;
  label: string;
  value: number;
}

/**
 * Metric points in query order. Without a "label" column the key doubles as the label;
 * labelFallback also replaces an empty label with the key.
 */
export async function metricRows(db: Database, q: Frag, labelFallback = false): Promise<MetricPoint[]> {
  const { rows } = await sql<{ key: string; label?: string; value: number }>`${q}`.execute(db);
  return rows.map((r) => {
    let label = r.label ?? r.key;
    if (labelFallback && label === "") label = r.key;
    return { key: r.key, label, value: Number(r.value) };
  });
}

export function pct(num: number, den: number): number {
  return den <= 0 ? 0 : (num / den) * 100;
}

export function div(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/** Go math.Round(v*100)/100 (half away from zero). */
export function round2(v: number): number {
  const x = v * 100;
  return (x < 0 ? -Math.round(-x) : Math.round(x)) / 100;
}
