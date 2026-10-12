import type { Request, Response, Router } from "express";
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
  optionalNumber,
  optionalObject,
  optionalString,
  str,
  stringArray,
} from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import type { Claims } from "../auth/types.js";
import { applyOwnerFilter, resolve, type Visibility } from "../datascope/datascope.js";
import { Records } from "../datascope/record.js";
import { P, Role } from "../permissions/permissions.js";
import { referralInputSchema } from "../referrals/referrals.service.js";
import type { CustomerListFilter, CustomerWriteResult, CustomersService } from "./customers.service.js";

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
  occupation: str(),
  jobTitle: str(),
  employer: str(),
  experienceYears: optionalNumber(),
  qualification: str(),
  skills: stringArray(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  potentialValue: optionalNumber(),
  expectedOutcome: str(),
  notes: str(),
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
  occupation: optionalString(),
  jobTitle: optionalString(),
  employer: optionalString(),
  experienceYears: optionalNumber(),
  qualification: optionalString(),
  skills: stringArray(),
  pipelineId: optionalString(),
  stageId: optionalString(),
  potentialValue: optionalNumber(),
  expectedOutcome: optionalString(),
  notes: optionalString(),
  nextFollowUpAt: optionalString(),
  forceUpdate: bool(),
  customFields: anyMap(),
});

/** Team leads may assign owners; sales executives and support always own their creates and cannot reassign. */
const canAssignOwner = (claims: Claims) => claims.roleCode === Role.SalesManager || claims.roleCode === Role.SuperAdmin;

function sendWriteResult(res: Response, result: CustomerWriteResult, successStatus: 200 | 201): void {
  if ("duplicates" in result) {
    sendJson(res, 409, {
      success: false,
      data: { duplicates: result.duplicates, needsReview: true },
      error: { code: ErrorCode.Conflict, message: "Potential duplicates found. Review and confirm to continue." },
    });
    return;
  }
  if (successStatus === 201) created(res, result.customer);
  else ok(res, result.customer);
}

function listScope(claims: Claims, ownerUserId: string, teamId: string, seId: string): { scope: Visibility; teamId: string } {
  let vis = resolve(claims, P.CustomersView, seId);
  if (seId === "" && ownerUserId !== "") vis = applyOwnerFilter(vis, ownerUserId);
  if (teamId !== "" && !vis.unscoped && vis.teamIds.length > 0) {
    if (!vis.teamIds.includes(teamId)) throw AppError.forbidden("team is outside your scope");
    vis = { ...vis, teamIds: [teamId] };
  }
  return { scope: vis, teamId: vis.unscoped ? teamId : "" };
}

function listFilter(req: Request): CustomerListFilter {
  const q = (k: string) => queryParam(req, k);
  const seId = q("salesExecutiveId") || q("sales_executive_id");
  const { scope, teamId } = listScope(claimsOf(req), q("ownerUserId") || seId, q("teamId"), seId);
  return {
    search: q("q"),
    teamId,
    source: q("source"),
    country: q("country"),
    createdFrom: q("createdFrom"),
    createdTo: q("createdTo"),
    attention: q("attention"),
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
    scope,
  };
}

export function customersRouter(service: CustomersService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const view = [P.CustomersView];
  const edit = [P.CustomersEdit];

  router.get("/api/v1/customers", ...guard(...view), async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.list(f);
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: f.limit, offset: f.offset } });
  });

  router.post("/api/v1/customers", ...guard(P.CustomersCreate), jsonBody, async (req, res) => {
    const input = decodeJson(req, createSchema);
    const claims = claimsOf(req);
    if (!canAssignOwner(claims)) input.ownerUserId = claims.userId;
    sendWriteResult(res, await service.create(claims, input, requestMeta(req)), 201);
  });

  router.get("/api/v1/customers/:id", ...guard(...view), inScope(db, Records.Customers, view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.get("/api/v1/customers/:id/profile", ...guard(...view), inScope(db, Records.Customers, view), async (req, res) => {
    ok(res, await service.get360(pathParam(req, "id")));
  });

  router.patch("/api/v1/customers/:id", ...guard(...edit), inScope(db, Records.Customers, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    const claims = claimsOf(req);
    if (!canAssignOwner(claims)) input.ownerUserId = undefined;
    sendWriteResult(res, await service.update(claims, pathParam(req, "id"), input, requestMeta(req)), 200);
  });

  router.post(
    "/api/v1/leads/:id/convert",
    ...guard(P.LeadsEdit, P.CustomersCreate),
    inScope(db, Records.Leads, [P.LeadsEdit]),
    async (req, res) => {
      created(res, await service.convertFromLead(claimsOf(req).userId, pathParam(req, "id"), requestMeta(req)));
    },
  );

  return router;
}
