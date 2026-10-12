import type { Router } from "express";
import { ok, sendJson } from "../../lib/response.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam } from "../../lib/request-meta.js";
import { createRouter } from "../../lib/router.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { SystemActivityService } from "./system-activity.service.js";

export function systemActivityRouter(service: SystemActivityService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/system-activity", ...guard(P.SystemView), async (req, res) => {
    const limit = atoi(queryParam(req, "limit"));
    const offset = atoi(queryParam(req, "offset"));
    const { items, total } = await service.list({
      q: queryParam(req, "q"),
      eventType: queryParam(req, "eventType"),
      entityType: queryParam(req, "entityType"),
      result: queryParam(req, "result"),
      actorUserId: queryParam(req, "actorUserId"),
      limit,
      offset,
    });
    sendJson(res, 200, { success: true, data: items, meta: { total, limit, offset } });
  });

  router.get("/api/v1/system-activity/:id", ...guard(P.SystemView), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  return router;
}
