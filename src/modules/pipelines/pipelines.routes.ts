import type { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { created, ok } from "../../lib/response.js";
import { parseBool, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { createRouter } from "../../lib/router.js";
import {
  bool,
  decodeJson,
  optionalBool,
  optionalInt,
  optionalNumber,
  optionalString,
  str,
  stringArray,
} from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { expandImplies, P } from "../permissions/permissions.js";
import type { PipelinesService } from "./pipelines.service.js";

const createPipelineSchema = z.strictObject({
  name: str(),
  description: str(),
  kind: str(),
  isDefault: bool(),
  isActive: optionalBool(),
});

const updatePipelineSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  kind: optionalString(),
  isDefault: optionalBool(),
  isActive: optionalBool(),
});

const createStageSchema = z.strictObject({
  name: str(),
  position: optionalInt(),
  probability: optionalNumber(),
  visualAccent: str(),
  requiredFields: stringArray(),
  requiredActivities: stringArray(),
  requiredDocuments: stringArray(),
  slaHours: optionalInt(),
  isWon: bool(),
  isLost: bool(),
  isActive: optionalBool(),
});

const updateStageSchema = z.strictObject({
  name: optionalString(),
  position: optionalInt(),
  probability: optionalNumber(),
  visualAccent: optionalString(),
  requiredFields: stringArray(),
  requiredActivities: stringArray(),
  requiredDocuments: stringArray(),
  slaHours: optionalInt(),
  clearSla: bool(),
  isWon: optionalBool(),
  isLost: optionalBool(),
  isActive: optionalBool(),
});

const reorderSchema = z.strictObject({ stageIds: stringArray() });

export function pipelinesRouter(service: PipelinesService, guard: Guard): Router {
  const router = createRouter();

  router.get(
    "/api/v1/pipelines",
    ...guard(P.PipelinesView, P.LeadsView, P.DealsView, P.PipelinesManage),
    async (req, res) => {
      ok(res, await service.list(queryParam(req, "kind"), parseBool(queryParam(req, "includeInactive"))));
    },
  );

  router.get(
    "/api/v1/pipelines/:id",
    ...guard(P.PipelinesView, P.LeadsView, P.DealsView, P.PipelinesManage),
    async (req, res) => {
      const pipeline = await service.get(pathParam(req, "id"));
      const perms = expandImplies(claimsOf(req).permissions);
      if (pipeline.kind !== "leads" && !perms.hasAny(P.PipelinesView, P.DealsView, P.PipelinesManage)) {
        throw AppError.forbidden("insufficient permissions");
      }
      ok(res, pipeline);
    },
  );

  router.post("/api/v1/pipelines", ...guard(P.PipelinesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createPipelineSchema);
    created(res, await service.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.patch("/api/v1/pipelines/:id", ...guard(P.PipelinesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, updatePipelineSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/pipelines/:id/stages", ...guard(P.PipelinesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createStageSchema);
    created(res, await service.createStage(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.post("/api/v1/pipelines/:id/stages/reorder", ...guard(P.PipelinesManage), jsonBody, async (req, res) => {
    const { stageIds } = decodeJson(req, reorderSchema);
    ok(res, await service.reorderStages(claimsOf(req).userId, pathParam(req, "id"), stageIds, requestMeta(req)));
  });

  router.patch("/api/v1/pipeline-stages/:id", ...guard(P.PipelinesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateStageSchema);
    ok(res, await service.updateStage(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  return router;
}
