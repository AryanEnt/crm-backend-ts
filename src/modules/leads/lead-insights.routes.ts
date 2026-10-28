import type { Request, Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { atoi, queryParam } from "../../lib/query.js";
import { ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { isUuid } from "../../lib/uuid.js";
import { isValidTimezone } from "../activities/activities.service.js";
import { parseFilter } from "../analytics/analytics.filter.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { applyOwnerFilter, resolve } from "../datascope/datascope.js";
import { P } from "../permissions/permissions.js";
import type { InsightScope, LeadInsightsService } from "./lead-insights.service.js";

/**
 * leads:view visibility, optionally narrowed to one owner: "me", a user id, or "all"/"" for
 * everyone the caller can see. Numbers always match what the board shows the caller.
 */
function insightScope(req: Request, defaultOwner: "me" | "all"): InsightScope {
  const claims = claimsOf(req);
  const owner = queryParam(req, "owner").trim() || defaultOwner;
  const vis = resolve(claims, P.LeadsView, "");
  const teamId = queryParam(req, "teamId").trim();
  if (teamId !== "" && !isUuid(teamId)) throw AppError.validation("teamId must be a uuid");
  const narrow = { teamId, source: queryParam(req, "source").trim() };
  if (owner === "all") return { vis, ownerUserId: "", ...narrow };
  if (owner === "me") return { vis, ownerUserId: claims.userId, ...narrow };
  if (!isUuid(owner)) throw AppError.validation("owner must be me, all, or a user id");
  return { vis: applyOwnerFilter(vis, owner), ownerUserId: "", ...narrow };
}

export function leadInsightsRouter(service: LeadInsightsService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.LeadsView);

  router.get("/api/v1/leads/insights/overview", ...view, async (req, res) => {
    const range = parseFilter({ from: queryParam(req, "from"), to: queryParam(req, "to") });
    ok(res, await service.overview(insightScope(req, "all"), queryParam(req, "pipelineId").trim(), range.from, range.to));
  });

  router.get("/api/v1/leads/insights/owners", ...view, async (req, res) => {
    const range = parseFilter({ from: queryParam(req, "from"), to: queryParam(req, "to") });
    ok(res, await service.byOwner(insightScope(req, "all"), queryParam(req, "pipelineId").trim(), range.from, range.to));
  });

  router.get("/api/v1/leads/insights/my-day", ...view, async (req, res) => {
    const tz = queryParam(req, "tz").trim() || "Asia/Kathmandu";
    if (!isValidTimezone(tz)) throw AppError.validation("invalid IANA timezone");
    ok(res, await service.myDay(insightScope(req, "me"), tz));
  });

  router.get("/api/v1/leads/insights/forecast", ...view, async (req, res) => {
    ok(
      res,
      await service.forecast(insightScope(req, "all"), queryParam(req, "pipelineId").trim(), atoi(queryParam(req, "months"))),
    );
  });

  return router;
}
