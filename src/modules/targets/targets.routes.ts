import type { Request, Router } from "express";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMetaFirstHop } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import { createSchema, METRICS_CATALOG, updateSchema, type TargetListFilter, type TargetsService } from "./targets.service.js";

function listFilter(req: Request): TargetListFilter {
  const q = (k: string) => queryParam(req, k);
  return {
    periodType: q("periodType"),
    metric: q("metric"),
    scopeType: q("scopeType"),
    teamId: q("teamId"),
    userId: q("userId"),
    pipelineId: q("pipelineId"),
    from: q("from"),
    to: q("to"),
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
  };
}

export function targetsRouter(service: TargetsService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.TargetsView, P.TargetsManage);
  const manage = guard(P.TargetsManage);

  router.get("/api/v1/targets/metrics", ...view, (_req, res) => ok(res, METRICS_CATALOG));

  router.get("/api/v1/targets/progress", ...view, async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.listProgress(claimsOf(req), f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit <= 0 ? 50 : f.limit, offset: f.offset } });
  });

  router.get("/api/v1/targets", ...view, async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.list(claimsOf(req), f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit <= 0 ? 50 : f.limit, offset: f.offset } });
  });

  router.post("/api/v1/targets", ...manage, jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req), input, requestMetaFirstHop(req)));
  });

  router.get("/api/v1/targets/:id", ...view, async (req, res) => {
    ok(res, await service.get(claimsOf(req), pathParam(req, "id")));
  });

  router.get("/api/v1/targets/:id/progress", ...view, async (req, res) => {
    ok(res, await service.progress(claimsOf(req), pathParam(req, "id")));
  });

  router.patch("/api/v1/targets/:id", ...manage, jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req), pathParam(req, "id"), input, requestMetaFirstHop(req)));
  });

  router.delete("/api/v1/targets/:id", ...manage, async (req, res) => {
    await service.delete(claimsOf(req), pathParam(req, "id"), requestMetaFirstHop(req));
    ok(res, { deleted: true });
  });

  return router;
}
