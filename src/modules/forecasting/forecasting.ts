import type { Router } from "express";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goSortKeys } from "../../lib/go-json.js";
import { parseDateOnly, parseRfc3339 } from "../../lib/go-time.js";
import { queryParam } from "../../lib/query.js";
import { internal } from "../../lib/request-meta.js";
import { ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { resolveReport } from "../datascope/datascope.js";
import { P } from "../permissions/permissions.js";

// Methodology identifiers stay stable so new models can be added under new codes.
export const METHODOLOGY_WEIGHTED_PIPELINE_V1 = "weighted_pipeline_v1";
export const MIN_CLOSED_SAMPLE = 10;
export const INSUFFICIENT_MESSAGE = "Not enough historical data for a reliable forecast.";
export const DISCLAIMER =
  "Forecasts are estimates based on historical outcomes and current pipeline. They are not guaranteed results.";

export interface ForecastRequest {
  pipelineId: string;
  teamId: string;
  ownerUserId: string;
  from: Date | null;
  to: Date | null;
  historyFrom: Date | null;
  historyTo: Date | null;
}

interface Methodology {
  code: string;
  name: string;
  description: string;
  version: string;
}

export interface ForecastResult {
  available: boolean;
  message?: string;
  disclaimer: string;
  scenarios?: { conservative: number; expected: number; higherCase: number };
  openDealCount: number;
  openPipelineValue: number;
  transparency: {
    period: { from: string; to: string };
    pipelineId: string;
    pipelineName: string;
    sampleSize: number;
    historicalDataRange: { from: string; to: string };
    inputs: Record<string, unknown>;
    methodology: Methodology;
  };
}

interface OpenDeal {
  value: number;
  probability: number;
  expectedCloseAt: string | null;
}

const round2 = (v: number) => (v < 0 ? -Math.round(-v * 100) : Math.round(v * 100)) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Go time.AddDate: overflowing days/months normalise into the next unit. */
function addDate(d: Date, years: number, months: number, days: number): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear() + years,
      d.getUTCMonth() + months,
      d.getUTCDate() + days,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

function parseDay(v: string): Date | null {
  return parseRfc3339(v) ?? parseDateOnly(v);
}

export function parseForecastRequest(q: Record<string, string>): ForecastRequest {
  const get = (k: string) => (q[k] ?? "").trim();
  const req: ForecastRequest = {
    pipelineId: get("pipelineId"),
    teamId: get("teamId"),
    ownerUserId: get("ownerUserId"),
    from: null,
    to: null,
    historyFrom: null,
    historyTo: null,
  };
  for (const k of ["from", "to", "historyFrom", "historyTo"] as const) {
    const v = get(k);
    if (v === "") continue;
    const t = parseDay(v);
    if (!t) throw AppError.validation(`invalid ${k}`);
    req[k] = t;
  }
  return req;
}

export class ForecastingService {
  constructor(private readonly db: Database) {}

  async forecast(req: ForecastRequest, now = new Date()): Promise<ForecastResult> {
    if (req.pipelineId === "") throw AppError.validation("pipelineId is required");
    const from = req.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = req.to ?? addDate(from, 0, 3, -1);
    const historyTo = req.historyTo ?? now;
    const historyFrom = req.historyFrom ?? addDate(historyTo, -1, 0, 0);

    const pipe = await sql<{ name: string }>`SELECT name FROM pipelines WHERE id = ${req.pipelineId}`
      .execute(this.db)
      .then((r) => r.rows[0])
      .catch(() => undefined);
    if (!pipe) throw AppError.notFound("pipeline not found");

    const { teamId: team, ownerUserId: owner, pipelineId } = req;
    const hist = await internal("failed to load historical outcomes", async () => {
      const { rows } = await sql<{ closed: number; won: number }>`
        SELECT
          COUNT(*) FILTER (WHERE d.status IN ('won','lost')) AS closed,
          COUNT(*) FILTER (WHERE d.status='won') AS won
        FROM deals d
        WHERE d.pipeline_id = ${pipelineId}
          AND d.status IN ('won','lost')
          AND d.updated_at >= ${historyFrom} AND d.updated_at <= ${historyTo}
          AND (${team}='' OR d.team_id::text=${team})
          AND (${owner}='' OR d.owner_user_id::text=${owner})`.execute(this.db);
      return rows[0]!;
    });
    const closed = Number(hist.closed);
    const winRate = closed > 0 ? Number(hist.won) / closed : 0;
    // Go ignores a failure here and reports zero.
    const avgStage = await sql<{ v: number }>`
      SELECT COALESCE(AVG(t.duration_seconds),0)::float8 AS v
      FROM deal_stage_transitions t
      JOIN deals d ON d.id = t.deal_id
      WHERE d.pipeline_id = ${pipelineId}
        AND t.from_stage_id IS NOT NULL
        AND t.duration_seconds > 0
        AND t.exited_at >= ${historyFrom} AND t.exited_at <= ${historyTo}
        AND (${team}='' OR d.team_id::text=${team})
        AND (${owner}='' OR d.owner_user_id::text=${owner})`
      .execute(this.db)
      .then((r) => r.rows[0]!.v)
      .catch(() => 0);

    const deals = await internal("failed to load open pipeline", async () => {
      const { rows } = await sql<OpenDeal>`
        SELECT COALESCE(d.value,0)::float8 AS value, COALESCE(ps.probability,0)::float8 AS probability,
          d.expected_close_at AS "expectedCloseAt"
        FROM deals d
        LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
        WHERE d.status='open' AND d.pipeline_id = ${pipelineId}
          AND (${team}='' OR d.team_id::text=${team})
          AND (${owner}='' OR d.owner_user_id::text=${owner})`.execute(this.db);
      return rows;
    });
    const openValue = deals.reduce((sum, d) => sum + d.value, 0);

    const inputs: Record<string, unknown> = {
      openDealCount: deals.length,
      openPipelineValue: round2(openValue),
      historicalWinRate: round2(winRate * 100),
      avgStageDurationSeconds: round2(avgStage),
      teamId: team,
      ownerUserId: owner,
      minClosedSample: MIN_CLOSED_SAMPLE,
    };
    const transparency = (): ForecastResult["transparency"] => ({
      period: { from: day(from), to: day(to) },
      pipelineId,
      pipelineName: pipe.name,
      sampleSize: closed,
      historicalDataRange: { from: day(historyFrom), to: day(historyTo) },
      inputs: goSortKeys(inputs),
      methodology: {
        code: METHODOLOGY_WEIGHTED_PIPELINE_V1,
        name: "Weighted pipeline (v1)",
        description:
          "Open deal values are weighted by stage probability, adjusted with historical win rate. " +
          "Conservative uses 0.7× expected weight; higher-case uses 1.3× capped at 100%. " +
          "Deals with expected close dates outside the forecast period are excluded from period totals.",
        version: "1",
      },
    });

    if (closed < MIN_CLOSED_SAMPLE) {
      return {
        available: false,
        message: INSUFFICIENT_MESSAGE,
        disclaimer: DISCLAIMER,
        openDealCount: deals.length,
        openPipelineValue: round2(openValue),
        transparency: transparency(),
      };
    }

    let expected = 0;
    let conservative = 0;
    let higher = 0;
    let included = 0;
    const fromDay = day(from);
    const toDay = day(to);
    for (const d of deals) {
      if (d.expectedCloseAt !== null && (d.expectedCloseAt < fromDay || d.expectedCloseAt > toDay)) continue;
      included++;
      const stageProb = Math.min(1, Math.max(0, d.probability / 100));
      // Stage probability blended with the historical win rate, equally weighted.
      const weight = Math.min(1, Math.max(0, (stageProb + winRate) / 2));
      expected += d.value * weight;
      conservative += d.value * Math.min(1, weight * 0.7);
      higher += d.value * Math.min(1, weight * 1.3);
    }
    inputs.dealsIncludedInPeriod = included;
    return {
      available: true,
      disclaimer: DISCLAIMER,
      scenarios: { conservative: round2(conservative), expected: round2(expected), higherCase: round2(higher) },
      openDealCount: deals.length,
      openPipelineValue: round2(openValue),
      transparency: transparency(),
    };
  }
}

export function forecastingRouter(service: ForecastingService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.ForecastsView);

  router.get("/api/v1/forecasts/methodology", ...view, (_req, res) => {
    ok(res, {
      disclaimer: DISCLAIMER,
      insufficientMessage: INSUFFICIENT_MESSAGE,
      methods: [
        {
          code: METHODOLOGY_WEIGHTED_PIPELINE_V1,
          name: "Weighted pipeline (v1)",
          description:
            "Open deal values weighted by stage probability blended with historical win rate. " +
            "Conservative 0.7×, higher-case 1.3× (capped). Future statistical/ML models can be added under new methodology codes without changing this response shape.",
          version: "1",
        },
      ],
      minClosedSample: MIN_CLOSED_SAMPLE,
    });
  });

  router.get("/api/v1/forecasts/pipeline", ...view, async (req, res) => {
    const q: Record<string, string> = {};
    for (const k of ["pipelineId", "teamId", "ownerUserId", "from", "to", "historyFrom", "historyTo"]) q[k] = queryParam(req, k);
    const fr = parseForecastRequest(q);
    const rs = resolveReport(claimsOf(req), P.ForecastsView, fr.teamId, fr.ownerUserId);
    fr.teamId = rs.teamId;
    fr.ownerUserId = rs.ownerUserId;
    ok(res, await service.forecast(fr));
  });

  return router;
}
