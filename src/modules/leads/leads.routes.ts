import type { Request, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError, ErrorCode } from "../../lib/app-error.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import {
  anyMap,
  bool,
  decodeJson,
  optionalInt,
  optionalNumber,
  optionalObject,
  optionalString,
  str,
  stringArray,
} from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { nextActivitySchema } from "../activities/activities.routes.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import type { Claims } from "../auth/types.js";
import { applyListFilters, resolve } from "../datascope/datascope.js";
import { Records, requireRecords } from "../datascope/record.js";
import { P, Role } from "../permissions/permissions.js";
import { referralInputSchema } from "../referrals/referrals.service.js";
import type { BoardFilter } from "./lead-stage.service.js";
import { assignTargetInScope, type LeadListFilter, type LeadWriteResult, type LeadsService } from "./leads.service.js";

export { assignTargetInScope };

const createSchema = z.strictObject({
  fullName: str(),
  email: optionalString(),
  phone: optionalString(),
  country: str(),
  nationality: str(),
  location: str(),
  ownerUserId: optionalString(),
  teamId: optionalString(),
  source: str(),
  priority: str(),
  tags: stringArray(),
  anzscoId: optionalString(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  notes: str(),
  occupation: str(),
  jobTitle: str(),
  employer: str(),
  experienceYears: optionalNumber(),
  qualification: str(),
  skills: stringArray(),
  potentialValue: optionalNumber(),
  currency: optionalString(),
  expectedCloseAt: optionalString(),
  expectedOutcome: str(),
  nextActivityAt: optionalString(),
  forceCreate: bool(),
  customFields: anyMap(),
  referral: optionalObject(referralInputSchema),
});

const updateSchema = z.strictObject({
  fullName: optionalString(),
  email: optionalString(),
  phone: optionalString(),
  country: optionalString(),
  nationality: optionalString(),
  location: optionalString(),
  ownerUserId: optionalString(),
  teamId: optionalString(),
  source: optionalString(),
  priority: optionalString(),
  tags: stringArray(),
  anzscoId: optionalString(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  notes: optionalString(),
  occupation: optionalString(),
  jobTitle: optionalString(),
  employer: optionalString(),
  experienceYears: optionalNumber(),
  qualification: optionalString(),
  skills: stringArray(),
  potentialValue: optionalNumber(),
  clearValue: z.boolean().optional(),
  currency: optionalString(),
  expectedCloseAt: optionalString(),
  clearCloseDate: z.boolean().optional(),
  expectedOutcome: optionalString(),
  nextActivityAt: optionalString(),
  status: optionalString(),
  lostReason: optionalString(),
  forceStage: z.boolean().optional(),
  reopen: z.boolean().optional(),
  forceUpdate: bool(),
  customFields: anyMap(),
});

const moveSchema = z.strictObject({
  stageId: str(),
  pipelineId: optionalString(),
  force: bool(),
  reopen: bool(),
  lostReason: str(),
  documentDeadline: optionalString(),
  closingAmount: optionalInt(),
  nextActivity: optionalObject(nextActivitySchema),
});

const bulkArchiveSchema = z.strictObject({ ids: stringArray(), archive: bool() });
const bulkAssignSchema = z.strictObject({ ids: stringArray(), ownerUserId: optionalString(), teamId: optionalString() });
const bulkStageSchema = z.strictObject({ ids: stringArray(), pipelineId: str(), stageId: str() });
const duplicateSchema = z.strictObject({ email: optionalString(), phone: optionalString(), name: optionalString() });

const DUPLICATES_MESSAGE = "Potential duplicates found. Review and confirm to continue.";

/** 409 with the duplicates in data, or the saved lead with the success status. */
function sendWriteResult(res: Parameters<typeof ok>[0], result: LeadWriteResult, successStatus: 200 | 201): void {
  if ("needsReview" in result) {
    sendJson(res, 409, {
      success: false,
      data: result,
      error: { code: ErrorCode.Conflict, message: DUPLICATES_MESSAGE },
    });
    return;
  }
  if (successStatus === 201) created(res, result.lead);
  else ok(res, result.lead);
}

/** Authorization narrowing for the list; client teamId/ownerUserId only narrow within scope. */
function listScope(claims: Claims, ownerUserId: string, teamId: string, seId: string) {
  return applyListFilters(resolve(claims, P.LeadsView, seId), ownerUserId, teamId, seId);
}

function listFilter(req: Request): LeadListFilter {
  const q = (k: string) => queryParam(req, k);
  const seId = q("salesExecutiveId") || q("sales_executive_id");
  const ownerUserId = q("ownerUserId") || seId;
  const { scope, teamId } = listScope(claimsOf(req), ownerUserId, q("teamId"), seId);
  return {
    search: q("q"),
    ownerUserId: "",
    teamId,
    pipelineId: q("pipelineId"),
    stageId: q("stageId"),
    source: q("source"),
    priority: q("priority"),
    anzscoId: q("anzscoId"),
    tag: q("tag"),
    country: q("country"),
    createdFrom: q("createdFrom"),
    createdTo: q("createdTo"),
    closedFrom: instantParam(q, "closedFrom"),
    closedTo: instantParam(q, "closedTo"),
    inactiveDays: atoi(q("inactiveDays")),
    includeArchived: q("includeArchived") === "true",
    status: q("status"),
    attention: q("attention"),
    activity: q("activity"),
    ...valueRange(q),
    sort: q("sort"),
    order: q("order"),
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
    scope,
  };
}

/** An optional ISO date-time query param, normalised to UTC; "" when unset. */
function instantParam(q: (k: string) => string, key: string): string {
  const raw = q(key).trim();
  if (raw === "") return "";
  const ms = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(ms)) throw AppError.validation(`${key} must be an ISO date-time`);
  return new Date(ms).toISOString();
}

/** Optional `minValue` / `maxValue` (non-negative numbers) on the lead list and board. */
function valueRange(q: (k: string) => string): { minValue: number | null; maxValue: number | null } {
  const parse = (key: string): number | null => {
    const raw = q(key).trim();
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw AppError.validation(`${key} must be a non-negative number`);
    return n;
  };
  const minValue = parse("minValue");
  const maxValue = parse("maxValue");
  if (minValue != null && maxValue != null && minValue > maxValue) {
    throw AppError.validation("minValue must not exceed maxValue");
  }
  return { minValue, maxValue };
}

function boardFilter(req: Request): BoardFilter {
  const q = (k: string) => queryParam(req, k);
  const pipelineId = q("pipelineId");
  if (pipelineId === "") throw AppError.validation("pipelineId is required");
  const seId = q("salesExecutiveId");
  const { scope, teamId } = listScope(claimsOf(req), q("ownerUserId") || seId, q("teamId"), seId);
  return {
    pipelineId,
    search: q("q").trim(),
    ownerUserId: "",
    teamId,
    priority: q("priority"),
    source: q("source"),
    tag: q("tag"),
    country: q("country"),
    activity: q("activity"),
    ...valueRange(q),
    scope,
    limit: atoi(q("limit")),
  };
}

export function leadsRouter(service: LeadsService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const view = [P.LeadsView];
  const edit = [P.LeadsEdit];
  const requireLeads = (claims: Claims, ids: string[] | undefined, perm: string) =>
    requireRecords(db, claims, Records.Leads, ids ?? [], perm);

  router.get("/api/v1/leads", ...guard(P.LeadsView), async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.list(f);
    sendJson(res, 200, {
      success: true,
      data: items,
      meta: { total, limit: f.limit, offset: f.offset },
    });
  });

  /** Distinct countries (+ counts) for the leads filter dropdown; respects scope and other filters. */
  router.get("/api/v1/leads/countries", ...guard(P.LeadsView), async (req, res) => {
    ok(res, await service.listCountries(listFilter(req)));
  });

  router.post("/api/v1/leads", ...guard(P.LeadsCreate), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    const claims = claimsOf(req);
    const owner = input.ownerUserId?.trim() ?? "";
    const team = input.teamId?.trim() ?? "";
    // Sales executives always own their creates; others may only hand a new lead to someone in their assign scope.
    if (
      claims.roleCode !== Role.SalesExecutive &&
      ((owner !== "" && owner !== claims.userId) || (team !== "" && !claims.teamIds.includes(team)))
    ) {
      assignTargetInScope(claims, owner, team);
    }
    sendWriteResult(res, await service.create(claims, input, requestMeta(req)), 201);
  });

  router.post("/api/v1/leads/bulk-archive", ...guard(P.LeadsDelete), jsonBody, async (req, res) => {
    const { ids, archive } = decodeJson(req, bulkArchiveSchema);
    const claims = claimsOf(req);
    await requireLeads(claims, ids, P.LeadsDelete);
    ok(res, { updated: await service.archive(claims.userId, ids, archive, requestMeta(req)) });
  });

  router.post("/api/v1/leads/bulk-assign", ...guard(P.LeadsAssign), jsonBody, async (req, res) => {
    const input = decodeJson(req, bulkAssignSchema);
    const claims = claimsOf(req);
    await requireLeads(claims, input.ids, P.LeadsAssign);
    assignTargetInScope(claims, input.ownerUserId ?? "", input.teamId ?? "");
    ok(res, { updated: await service.bulkAssign(claims.userId, input, requestMeta(req)) });
  });

  router.post("/api/v1/leads/bulk-stage", ...guard(P.LeadsEdit), jsonBody, async (req, res) => {
    const input = decodeJson(req, bulkStageSchema);
    const claims = claimsOf(req);
    await requireLeads(claims, input.ids, P.LeadsEdit);
    ok(res, await service.bulkStage(claims, input, requestMeta(req)));
  });

  router.get("/api/v1/leads/board", ...guard(P.LeadsView), async (req, res) => {
    ok(res, await service.stages.board(boardFilter(req)));
  });

  router.get("/api/v1/leads/board/stage", ...guard(P.LeadsView), async (req, res) => {
    const stageId = queryParam(req, "stageId");
    if (stageId === "") throw AppError.validation("stageId is required");
    ok(res, await service.stages.boardStage(boardFilter(req), stageId, atoi(queryParam(req, "offset"))));
  });

  router.post("/api/v1/leads/check-duplicates", ...guard(P.LeadsCreate, P.LeadsEdit), jsonBody, async (req, res) => {
    const { email, phone, name } = decodeJson(req, duplicateSchema);
    ok(res, await service.checkDuplicates(claimsOf(req), queryParam(req, "excludeId"), email, phone, name));
  });

  router.get("/api/v1/leads/:id", ...guard(...view), inScope(db, Records.Leads, view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/leads/:id", ...guard(...edit), inScope(db, Records.Leads, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    sendWriteResult(res, await service.update(claimsOf(req), pathParam(req, "id"), input, requestMeta(req)), 200);
  });

  router.post("/api/v1/leads/:id/move", ...guard(...edit), inScope(db, Records.Leads, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, moveSchema);
    const id = pathParam(req, "id");
    const outcome = await service.stages.move({ kind: "user", claims: claimsOf(req) }, id, input, requestMeta(req));
    ok(res, {
      lead: await service.get(id),
      changed: outcome.changed,
      needsNextActivity: outcome.needsNextActivity,
      ...(outcome.nextActivityId !== undefined ? { nextActivityId: outcome.nextActivityId } : {}),
    });
  });

  router.post("/api/v1/leads/:id/qualify", ...guard(...edit), inScope(db, Records.Leads, edit), async (req, res) => {
    ok(res, await service.qualify(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req)));
  });

  return router;
}
