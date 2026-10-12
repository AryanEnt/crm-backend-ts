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
import { createSchema, statusSchema, updateSchema, type TeamsService } from "./teams.service.js";

export function teamsRouter(service: TeamsService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.TeamsView, P.TeamsManage);

  router.get("/api/v1/teams", ...view, async (req, res) => {
    const active = queryParam(req, "isActive");
    const f = {
      search: queryParam(req, "q"),
      isActive: active === "true" ? true : active === "false" ? false : undefined,
      limit: atoi(queryParam(req, "limit")),
      offset: atoi(queryParam(req, "offset")),
    };
    const { items, total } = await service.list(claimsOf(req), f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit, offset: f.offset } });
  });

  router.post("/api/v1/teams", ...guard(P.TeamsCreate, P.TeamsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req), input, requestMeta(req)));
  });

  router.get("/api/v1/teams/:id", ...view, async (req, res) => {
    ok(res, await service.get(claimsOf(req), pathParam(req, "id")));
  });

  router.patch("/api/v1/teams/:id", ...guard(P.TeamsEdit, P.TeamsManage, P.TeamsAssign), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req), pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/teams/:id/status", ...guard(P.TeamsDelete, P.TeamsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, statusSchema);
    ok(res, await service.setActive(claimsOf(req), pathParam(req, "id"), input.isActive, requestMeta(req)));
  });

  return router;
}
