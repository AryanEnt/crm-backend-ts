import type { Router } from "express";
import type { Database } from "../../db/database.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam } from "../../lib/request-meta.js";
import { ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import { Records } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import type { PredictionsService } from "./predictions.service.js";

export function predictionsRouter(service: PredictionsService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const any = guard(P.PredictionsView, P.PredictionsManage);
  // Record routes are scoped by the record's own view grant: predictions:view carries organization scope.
  const lead = inScope(db, Records.Leads, [P.LeadsView]);
  const deal = inScope(db, Records.Deals, [P.DealsView]);

  router.get("/api/v1/predictions/catalog", ...any, (_req, res) => ok(res, service.catalog()));

  // Go computes workload for any ownerUserId and pipeline risk for any pipeline.
  router.get("/api/v1/predictions/workload", ...any, async (req, res) => {
    const claims = claimsOf(req);
    ok(res, await service.workload(claims.userId, queryParam(req, "ownerUserId") || claims.userId));
  });

  router.get("/api/v1/predictions/pipeline-risk", ...any, async (req, res) => {
    ok(res, await service.pipelineRisk(claimsOf(req).userId, queryParam(req, "pipelineId")));
  });

  router.post("/api/v1/predictions/leads/:id/score", ...any, lead, async (req, res) => {
    ok(res, await service.scoreLead(claimsOf(req).userId, pathParam(req, "id")));
  });

  router.get("/api/v1/predictions/leads/:id/score-history", ...any, lead, async (req, res) => {
    ok(res, await service.leadScoreHistory(pathParam(req, "id"), atoi(queryParam(req, "limit"))));
  });

  router.get("/api/v1/predictions/leads/:id/insights", ...any, lead, async (req, res) => {
    ok(res, await service.leadInsights(claimsOf(req).userId, pathParam(req, "id")));
  });

  router.get("/api/v1/predictions/deals/:id/insights", ...any, deal, async (req, res) => {
    ok(res, await service.dealInsights(claimsOf(req).userId, pathParam(req, "id")));
  });

  return router;
}
