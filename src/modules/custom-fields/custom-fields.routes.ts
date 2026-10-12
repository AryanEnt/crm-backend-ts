import type { RequestHandler, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { created, ok } from "../../lib/response.js";
import { queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { createRouter } from "../../lib/router.js";
import { anyMap, bool, decodeJson, int, optionalBool, optionalInt, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { Records, requireRecord, type RecordSpec } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import type { CustomFieldsService } from "./custom-fields.service.js";

const optionSchema = z.strictObject({ label: str(), value: str(), position: int() });
/** Go []OptionInput: a null element decodes to the zero struct. */
const optionList = z
  .array(optionSchema.nullable().transform((o) => o ?? { label: "", value: "", position: 0 }))
  .nullish()
  .transform((v) => v ?? undefined);

const createSchema = z.strictObject({
  entity: str(),
  name: str(),
  internalKey: str(),
  fieldType: str(),
  description: str(),
  helpText: str(),
  isRequired: bool(),
  isActive: optionalBool(),
  displayOrder: optionalInt(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  options: optionList,
});

const updateSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  helpText: optionalString(),
  isRequired: optionalBool(),
  isActive: optionalBool(),
  displayOrder: optionalInt(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  options: optionList,
});

const setValuesSchema = z.strictObject({ values: anyMap() });

const ENTITY_RECORDS: Record<string, { rec: RecordSpec; view: string; edit: string }> = {
  lead: { rec: Records.Leads, view: P.LeadsView, edit: P.LeadsEdit },
  customer: { rec: Records.Customers, view: P.CustomersView, edit: P.CustomersEdit },
  deal: { rec: Records.Deals, view: P.DealsView, edit: P.DealsEdit },
  activity: { rec: Records.Activities, view: P.ActivitiesView, edit: P.ActivitiesEdit },
};

/**
 * Scope check for /custom-fields/values/:entity/:recordId. custom_fields:view is a catalog
 * grant, so reads follow the record's own view scope; custom_fields:manage (admin-only)
 * lets Super Admin fill values without entity edit.
 */
function customFieldRecord(db: Database, edit: boolean): RequestHandler {
  return async (req, _res, next) => {
    const entity = pathParam(req, "entity");
    const entry = Object.hasOwn(ENTITY_RECORDS, entity) ? ENTITY_RECORDS[entity] : undefined;
    if (!entry) throw AppError.notFound("record not found");
    const perms = edit ? [entry.edit, P.CustomFieldsManage] : [entry.view];
    await requireRecord(db, claimsOf(req), entry.rec, pathParam(req, "recordId"), ...perms);
    next();
  };
}

export function customFieldsRouter(service: CustomFieldsService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const catalogView = [P.CustomFieldsView, P.LeadsView, P.CustomersView, P.DealsView, P.ActivitiesView];

  router.get("/api/v1/custom-fields", ...guard(...catalogView), async (req, res) => {
    const activeOnly = queryParam(req, "activeOnly") === "true" || queryParam(req, "active") === "true";
    ok(
      res,
      await service.list({
        entity: queryParam(req, "entity"),
        fieldType: queryParam(req, "fieldType"),
        activeOnly,
        q: queryParam(req, "q"),
        pipelineId: queryParam(req, "pipelineId"),
        stageId: queryParam(req, "stageId"),
        applyScope: queryParam(req, "applyScope") === "true",
      }),
    );
  });

  router.post("/api/v1/custom-fields", ...guard(P.CustomFieldsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get(
    "/api/v1/custom-fields/values/:entity/:recordId",
    ...guard(...catalogView),
    customFieldRecord(db, false),
    async (req, res) => {
      ok(res, await service.getValues(pathParam(req, "entity"), pathParam(req, "recordId")));
    },
  );

  router.put(
    "/api/v1/custom-fields/values/:entity/:recordId",
    ...guard(P.LeadsEdit, P.CustomersEdit, P.DealsEdit, P.ActivitiesEdit, P.CustomFieldsManage),
    customFieldRecord(db, true),
    jsonBody,
    async (req, res) => {
      const { values } = decodeJson(req, setValuesSchema);
      await service.setValues(claimsOf(req).userId, pathParam(req, "entity"), pathParam(req, "recordId"), values);
      ok(res, { saved: true });
    },
  );

  router.get("/api/v1/custom-fields/:id", ...guard(P.CustomFieldsView, P.CustomFieldsManage), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/custom-fields/:id", ...guard(P.CustomFieldsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.delete("/api/v1/custom-fields/:id", ...guard(P.CustomFieldsManage), async (req, res) => {
    await service.delete(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req));
    ok(res, { deleted: true });
  });

  return router;
}
