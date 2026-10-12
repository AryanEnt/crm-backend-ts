import type { Request, Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { queryParam } from "../../lib/query.js";
import { ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { resolveReport } from "../datascope/datascope.js";
import { P, type Scope } from "../permissions/permissions.js";
import { FILTER_KEYS, parseFilter, type AnalyticsFilter } from "./analytics.filter.js";
import type { AnalyticsService } from "./analytics.service.js";

/** Parses the shared filter, then clamps team/owner to the caller's report scope. */
export function scopedFilter(req: Request, viewPermission: string): { f: AnalyticsFilter; scope: Scope } {
  const q: Record<string, string> = {};
  for (const k of FILTER_KEYS) q[k] = queryParam(req, k);
  const f = parseFilter(q);
  const rs = resolveReport(claimsOf(req), viewPermission, f.teamId, f.ownerUserId);
  f.teamId = rs.teamId;
  f.ownerUserId = rs.ownerUserId;
  f.scopeUserIds = rs.userIds;
  f.scopeTeamIds = rs.teamIds;
  return { f, scope: rs.scope };
}

export function analyticsRouter(service: AnalyticsService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.AnalyticsView);
  const filter = (req: Request) => scopedFilter(req, P.AnalyticsView).f;

  router.get("/api/v1/analytics/funnel", ...view, async (req, res) => ok(res, await service.funnel(filter(req))));
  router.get("/api/v1/analytics/summary", ...view, async (req, res) => ok(res, await service.summary(filter(req))));
  router.get("/api/v1/analytics/leads", ...view, async (req, res) => ok(res, await service.leads(filter(req))));
  router.get("/api/v1/analytics/pipeline", ...view, async (req, res) => ok(res, await service.pipeline(filter(req))));
  router.get("/api/v1/analytics/activities", ...view, async (req, res) => ok(res, await service.activities(filter(req))));
  router.get("/api/v1/analytics/conversions", ...view, async (req, res) => ok(res, await service.conversions(filter(req))));
  router.get("/api/v1/analytics/teams", ...view, async (req, res) => ok(res, await service.teams(filter(req))));
  router.get("/api/v1/analytics/sources", ...view, async (req, res) => ok(res, await service.sources(filter(req))));

  // Defaults to org-wide totals when no team/owner is chosen, so it needs organization scope.
  router.get("/api/v1/analytics/organization", ...view, async (req, res) => {
    const { f, scope } = scopedFilter(req, P.AnalyticsView);
    if (scope !== "organization") throw AppError.forbidden("organization analytics requires organization scope");
    ok(res, await service.organization(f));
  });

  return router;
}
