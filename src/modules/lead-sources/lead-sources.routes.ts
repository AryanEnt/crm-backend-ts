import type { Router } from "express";
import { z } from "zod";
import { created, ok } from "../../lib/response.js";
import { queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, optionalBool, optionalInt, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { LeadSourcesService } from "./lead-sources.service.js";

const createSchema = z.strictObject({
  name: str(),
  description: str(),
  isActive: optionalBool(),
  position: optionalInt(),
});

const updateSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  isActive: optionalBool(),
  position: optionalInt(),
});

export function leadSourcesRouter(service: LeadSourcesService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/lead-sources", ...guard(P.LeadSourcesView, P.LeadsCreate, P.LeadsEdit), async (req, res) => {
    const activeOnly = queryParam(req, "activeOnly") === "true" || queryParam(req, "active") === "true";
    ok(res, await service.list(activeOnly, queryParam(req, "q")));
  });

  router.post("/api/v1/lead-sources", ...guard(P.LeadSourcesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.patch("/api/v1/lead-sources/:id", ...guard(P.LeadSourcesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.delete("/api/v1/lead-sources/:id", ...guard(P.LeadSourcesManage), async (req, res) => {
    await service.delete(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req));
    ok(res, { deleted: true });
  });

  return router;
}
