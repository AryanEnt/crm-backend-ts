import type { Request, Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import {
  bulkStatusSchema,
  createSchema,
  statusSchema,
  updateSchema,
  type UserListFilter,
  type UsersService,
} from "./users.service.js";

function listFilter(req: Request): UserListFilter {
  const q = (k: string) => queryParam(req, k);
  const active = q("isActive");
  return {
    search: q("q"),
    roleId: q("roleId"),
    roleCode: q("roleCode"),
    teamId: q("teamId") || q("team_id"),
    availableForTeamId: q("availableForTeamId") || q("available_for_team_id"),
    isActive: active === "true" ? true : active === "false" ? false : undefined,
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
  };
}

export function usersRouter(service: UsersService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.UsersView, P.UsersManage);
  const status = guard(P.UsersDelete, P.UsersManage);

  router.get("/api/v1/users", ...view, async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.list(claimsOf(req), f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit, offset: f.offset } });
  });

  router.post("/api/v1/users", ...guard(P.UsersCreate, P.UsersManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req), input, requestMeta(req)));
  });

  router.post("/api/v1/users/bulk-status", ...status, jsonBody, async (req, res) => {
    const input = decodeJson(req, bulkStatusSchema);
    const ids = input.ids ?? [];
    if (ids.length === 0) throw AppError.validation("ids are required");
    ok(res, { updated: await service.bulkSetActive(claimsOf(req), ids, input.isActive, requestMeta(req)) });
  });

  router.get("/api/v1/users/:id", ...view, async (req, res) => {
    ok(res, await service.get(claimsOf(req), pathParam(req, "id")));
  });

  router.patch("/api/v1/users/:id", ...guard(P.UsersEdit, P.UsersManage, P.UsersAssign), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req), pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/users/:id/status", ...status, jsonBody, async (req, res) => {
    const input = decodeJson(req, statusSchema);
    ok(res, await service.setActive(claimsOf(req), pathParam(req, "id"), input.isActive, requestMeta(req)));
  });

  router.get("/api/v1/roles", ...guard(P.RolesView, P.RolesManage, P.UsersView), async (_req, res) => {
    ok(res, await service.listRoles());
  });

  return router;
}
