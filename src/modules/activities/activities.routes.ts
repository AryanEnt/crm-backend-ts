import type { Request, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { parseDateOnly, parseRfc3339 } from "../../lib/go-time.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import {
  anyMap,
  bool,
  decodeJson,
  int,
  optionalBool,
  optionalInt,
  optionalObject,
  optionalString,
  str,
} from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import { applyOwnerFilter, resolve } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import type { ActivitiesService, ActivityListFilter } from "./activities.service.js";
import type { ActivityPromptsService } from "./activity-prompts.service.js";
import type { ActivityTypesService } from "./activity-types.service.js";

const createSchema = z.strictObject({
  title: str(),
  subject: str(),
  kind: str(),
  typeCode: str(),
  body: str(),
  notes: str(),
  outcome: str(),
  status: str(),
  priority: str(),
  ownerUserId: optionalString(),
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
  startAt: optionalString(),
  endAt: optionalString(),
  dueAt: optionalString(),
  externalProvider: str(),
  externalId: str(),
  externalThreadId: str(),
  metadata: anyMap(),
});

export const nextActivitySchema = z.strictObject({ title: str(), dueAt: str(), typeCode: str() });

const updateSchema = z.strictObject({
  title: optionalString(),
  kind: optionalString(),
  typeCode: optionalString(),
  notes: optionalString(),
  outcome: optionalString(),
  status: optionalString(),
  priority: optionalString(),
  ownerUserId: optionalString(),
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
  startAt: optionalString(),
  endAt: optionalString(),
  dueAt: optionalString(),
  clearDueAt: bool(),
  externalProvider: optionalString(),
  externalId: optionalString(),
  externalThreadId: optionalString(),
  nextActivity: optionalObject(nextActivitySchema),
});

const typeCreateSchema = z.strictObject({
  name: str(),
  code: str(),
  description: str(),
  color: str(),
  icon: str(),
  isActive: optionalBool(),
  position: optionalInt(),
  requiresDatetime: bool(),
  requiresDuration: bool(),
  requiresOutcome: bool(),
  requiresNotes: bool(),
});

const typeUpdateSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  color: optionalString(),
  icon: optionalString(),
  isActive: optionalBool(),
  position: optionalInt(),
  requiresDatetime: optionalBool(),
  requiresDuration: optionalBool(),
  requiresOutcome: optionalBool(),
  requiresNotes: optionalBool(),
});

const timezoneSchema = z.strictObject({ timezone: str() });

const promptOutcomeSchema = z.strictObject({
  result: str(),
  note: optionalString(),
  nextActivity: optionalObject(nextActivitySchema),
});

const snoozeSchema = z.strictObject({ minutes: int() });

function rangeParam(req: Request, key: string): Date | null {
  const v = queryParam(req, key);
  if (v === "") return null;
  const t = parseRfc3339(v) ?? parseDateOnly(v);
  if (!t) throw AppError.validation(`invalid ${key}`);
  return t;
}

/** Scope narrowing; a teamId filter only applies to unscoped callers (team scope already bounds rows). */
function listFilter(req: Request): ActivityListFilter {
  const q = (k: string) => queryParam(req, k);
  const from = rangeParam(req, "from");
  const to = rangeParam(req, "to");
  const seId = q("salesExecutiveId") || q("sales_executive_id");
  const ownerUserId = q("ownerUserId") || seId;
  let scope = resolve(claimsOf(req), P.ActivitiesView, seId);
  if (seId === "" && ownerUserId !== "") scope = applyOwnerFilter(scope, ownerUserId);
  return {
    leadId: q("leadId"),
    customerId: q("customerId"),
    dealId: q("dealId"),
    teamId: scope.unscoped ? q("teamId") : "",
    typeCode: q("type"),
    pipelineId: q("pipelineId"),
    status: q("status"),
    from,
    to,
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
    scope,
  };
}

export function activitiesRouter(
  service: ActivitiesService,
  types: ActivityTypesService,
  prompts: ActivityPromptsService,
  db: Database,
  guard: Guard,
): Router {
  const router = createRouter();
  const view = [P.ActivitiesView];
  const edit = [P.ActivitiesEdit];

  router.get("/api/v1/activity-types", ...guard(...view), async (_req, res) => {
    ok(res, await types.listActive());
  });

  router.get("/api/v1/admin/activity-types", ...guard(P.ActivityTypesView, P.ActivityTypesManage), async (_req, res) => {
    ok(res, await types.listAll());
  });

  router.post("/api/v1/admin/activity-types", ...guard(P.ActivityTypesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, typeCreateSchema);
    created(res, await types.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.patch("/api/v1/admin/activity-types/:id", ...guard(P.ActivityTypesManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, typeUpdateSchema);
    ok(res, await types.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.delete("/api/v1/admin/activity-types/:id", ...guard(P.ActivityTypesManage), async (req, res) => {
    await types.delete(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req));
    ok(res, { deleted: true });
  });

  const list = async (req: Request, res: Parameters<typeof ok>[0], calendar = false) => {
    const f = { ...listFilter(req), hideStageChanges: calendar };
    const { items, total } = await service.list(f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit, offset: f.offset } });
  };

  router.get("/api/v1/activities", ...guard(...view), (req, res) => list(req, res));

  router.get("/api/v1/activities/calendar", ...guard(...view), async (req, res) => {
    if (queryParam(req, "from") === "" || queryParam(req, "to") === "") {
      throw AppError.validation("from and to are required");
    }
    await list(req, res, true);
  });

  router.get("/api/v1/activities/follow-up", ...guard(...view), async (req, res) => {
    const q = (k: string) => queryParam(req, k);
    ok(res, await service.followUp(q("leadId"), q("customerId"), q("dealId")));
  });

  router.post("/api/v1/activities", ...guard(P.ActivitiesCreate), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    created(res, await service.create(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get("/api/v1/activities/prompts", ...guard(...view), async (req, res) => {
    ok(res, await prompts.due(claimsOf(req).userId));
  });

  router.post(
    "/api/v1/activities/:id/outcome",
    ...guard(...edit),
    inScope(db, Records.Activities, edit),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, promptOutcomeSchema);
      ok(res, await prompts.outcome(claimsOf(req), pathParam(req, "id"), input, requestMeta(req)));
    },
  );

  router.post("/api/v1/activities/:id/snooze", ...guard(...edit), inScope(db, Records.Activities, edit), jsonBody, async (req, res) => {
    const { minutes } = decodeJson(req, snoozeSchema);
    ok(res, await prompts.snooze(pathParam(req, "id"), minutes));
  });

  router.get("/api/v1/activities/:id", ...guard(...view), inScope(db, Records.Activities, view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/activities/:id", ...guard(...edit), inScope(db, Records.Activities, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.get("/api/v1/me/timezone", ...guard(), async (req, res) => {
    ok(res, { timezone: await service.getTimezone(claimsOf(req).userId) });
  });

  router.patch("/api/v1/me/timezone", ...guard(), jsonBody, async (req, res) => {
    const { timezone } = decodeJson(req, timezoneSchema);
    await service.setTimezone(claimsOf(req).userId, timezone);
    ok(res, { timezone });
  });

  return router;
}
