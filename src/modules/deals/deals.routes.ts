import type { Request, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { anyMap, bool, decodeJson, optionalNumber, optionalObject, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { nextActivitySchema } from "../activities/activities.routes.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import type { Claims } from "../auth/types.js";
import { applyOwnerFilter, resolve, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P, Role } from "../permissions/permissions.js";
import type { DealsService } from "./deals.service.js";

const createSchema = z.strictObject({
  customerId: str(),
  title: str(),
  ownerUserId: optionalString(),
  teamId: optionalString(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  value: optionalNumber(),
  currency: str(),
  probability: optionalNumber(),
  expectedCloseAt: optionalString(),
  source: str(),
  priority: str(),
  notes: str(),
  fieldValues: anyMap(),
});

const updateSchema = z.strictObject({
  title: optionalString(),
  ownerUserId: optionalString(),
  teamId: optionalString(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  value: optionalNumber(),
  currency: optionalString(),
  probability: optionalNumber(),
  expectedCloseAt: optionalString(),
  clearCloseDate: bool(),
  source: optionalString(),
  priority: optionalString(),
  notes: optionalString(),
  fieldValues: anyMap(),
  status: optionalString(),
});

const moveSchema = z.strictObject({
  stageId: str(),
  pipelineId: str(),
  force: bool(),
  lostReason: str(),
  nextActivity: optionalObject(nextActivitySchema),
});

const documentSchema = z.strictObject({ name: str(), category: str() });

/** Team leads may assign owners; sales executives and support always own their creates and cannot reassign. */
const canAssignOwner = (claims: Claims) => claims.roleCode === Role.SalesManager || claims.roleCode === Role.SuperAdmin;

function listScope(req: Request, ownerUserId: string, seId: string): Visibility {
  let vis = resolve(claimsOf(req), P.DealsView, seId);
  if (seId === "" && ownerUserId !== "") vis = applyOwnerFilter(vis, ownerUserId);
  return vis;
}

export function dealsRouter(service: DealsService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const view = [P.DealsView];
  const edit = [P.DealsEdit];

  router.get("/api/v1/deals", ...guard(...view), async (req, res) => {
    const q = (k: string) => queryParam(req, k);
    const seId = q("salesExecutiveId") || q("sales_executive_id");
    const f = {
      pipelineId: q("pipelineId"),
      search: q("q"),
      teamId: q("teamId"),
      status: q("status"),
      attention: q("attention"),
      limit: atoi(q("limit")),
      offset: atoi(q("offset")),
      scope: listScope(req, q("ownerUserId") || seId, seId),
    };
    const { items, total } = await service.list(f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit, offset: f.offset } });
  });

  router.get("/api/v1/deals/board", ...guard(...view), async (req, res) => {
    const pipelineId = queryParam(req, "pipelineId");
    if (pipelineId === "") throw AppError.validation("pipelineId is required");
    const seId = queryParam(req, "salesExecutiveId") || queryParam(req, "sales_executive_id");
    ok(res, await service.board(pipelineId, listScope(req, "", seId)));
  });

  router.post("/api/v1/deals", ...guard(P.DealsCreate), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    const claims = claimsOf(req);
    if (!canAssignOwner(claims)) {
      input.ownerUserId = claims.userId;
      if (claims.teamIds.length > 0) input.teamId = claims.teamIds[0];
    }
    created(res, await service.create(claims.userId, input, requestMeta(req)));
  });

  router.get("/api/v1/deals/:id", ...guard(...view), inScope(db, Records.Deals, view), async (req, res) => {
    ok(res, await service.getDetail(pathParam(req, "id")));
  });

  router.patch("/api/v1/deals/:id", ...guard(...edit), inScope(db, Records.Deals, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    const claims = claimsOf(req);
    if (!canAssignOwner(claims)) input.ownerUserId = undefined;
    ok(res, await service.update(claims.userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/deals/:id/move", ...guard(...edit), inScope(db, Records.Deals, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, moveSchema);
    ok(res, await service.move(claimsOf(req), pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/deals/:id/documents", ...guard(...edit), inScope(db, Records.Deals, edit), jsonBody, async (req, res) => {
    const { name, category } = decodeJson(req, documentSchema);
    const id = pathParam(req, "id");
    await service.addDocument(claimsOf(req).userId, id, name, category);
    ok(res, await service.getDetail(id));
  });

  return router;
}
