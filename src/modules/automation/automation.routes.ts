import type { Router } from "express";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import { createSchema, updateSchema, type AutomationService } from "./automation.service.js";

export function automationRouter(service: AutomationService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.AutomationsView, P.AutomationsManage);
  const manage = guard(P.AutomationsManage);
  const page = (limit: number, offset: number, total: number) => ({ total, limit: limit <= 0 ? 50 : limit, offset });

  router.get("/api/v1/automations/catalog", ...view, (_req, res) => ok(res, service.catalog()));

  router.get("/api/v1/automations", ...view, async (req, res) => {
    const limit = atoi(queryParam(req, "limit"));
    const offset = atoi(queryParam(req, "offset"));
    const { items, total } = await service.list(queryParam(req, "triggerType"), queryParam(req, "activeOnly") === "true", limit, offset);
    sendJson(res, 200, { success: true, data: items, meta: page(limit, offset, total) });
  });

  router.post("/api/v1/automations", ...manage, jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get("/api/v1/automations/runs", ...view, async (req, res) => {
    const limit = atoi(queryParam(req, "limit"));
    const offset = atoi(queryParam(req, "offset"));
    const { items, total } = await service.listRuns(queryParam(req, "automationId"), queryParam(req, "status"), limit, offset);
    sendJson(res, 200, { success: true, data: items, meta: page(limit, offset, total) });
  });

  router.get("/api/v1/automations/jobs", ...view, async (req, res) => {
    const limit = atoi(queryParam(req, "limit"));
    const offset = atoi(queryParam(req, "offset"));
    const { items, total } = await service.listJobs(queryParam(req, "status"), limit, offset);
    sendJson(res, 200, { success: true, data: items, meta: page(limit, offset, total) });
  });

  router.post("/api/v1/automations/jobs/:id/retry", ...manage, async (req, res) => {
    ok(res, await service.retryJob(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req)));
  });

  router.get("/api/v1/automations/:id", ...view, async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/automations/:id", ...manage, jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.delete("/api/v1/automations/:id", ...manage, async (req, res) => {
    await service.delete(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req));
    ok(res, { deleted: true });
  });

  return router;
}
