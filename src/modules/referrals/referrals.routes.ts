import type { Request, Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, optionalString } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { expandImplies, P, Role } from "../permissions/permissions.js";
import {
  partnerInputSchema,
  referralInputSchema,
  referralUpdateSchema,
  type ReferralListFilter,
  type ReferralsService,
} from "./referrals.service.js";

const createSchema = z.strictObject({
  leadId: optionalString(),
  customerId: optionalString(),
  ...referralInputSchema.shape,
});

/** Callers without referrals:manage see referrals whose lead/customer they own or share a team with. */
function listFilter(req: Request): ReferralListFilter {
  const q = (k: string) => queryParam(req, k);
  const f: ReferralListFilter = {
    search: q("q"),
    ownerUserId: q("ownerUserId"),
    teamId: q("teamId"),
    pipelineId: q("pipelineId"),
    referrerTypeCode: q("referrerType"),
    referrerUserId: q("referrerUserId"),
    referrerCustomerId: q("referrerCustomerId"),
    referrerPartnerId: q("referrerPartnerId"),
    referrerName: q("referrer"),
    statusCode: q("status"),
    dateFrom: q("from"),
    dateTo: q("to"),
    sort: q("sort"),
    order: q("order"),
    limit: atoi(q("limit")),
    offset: atoi(q("offset")),
    scopeOwnerIds: [],
    scopeTeamIds: [],
    unscoped: false,
  };
  const claims = claimsOf(req);
  if (expandImplies(claims.permissions).has(P.ReferralsManage) || claims.roleCode === Role.SuperAdmin) {
    return { ...f, unscoped: true };
  }
  return { ...f, scopeOwnerIds: [claims.userId], scopeTeamIds: [...claims.teamIds] };
}

export function referralsRouter(service: ReferralsService, guard: Guard): Router {
  const router = createRouter();
  const view = [P.ReferralsView, P.ReferralsManage];
  const picker = [P.ReferralsView, P.ReferralsManage, P.LeadsCreate, P.CustomersCreate];

  router.get("/api/v1/referrals/meta", ...guard(...picker), async (_req, res) => {
    ok(res, await service.meta());
  });

  router.get("/api/v1/referrals/summary", ...guard(...view), async (req, res) => {
    ok(res, await service.summary(listFilter(req)));
  });

  router.get("/api/v1/referrals/subject", ...guard(...view, P.LeadsView, P.CustomersView), async (req, res) => {
    const leadId = queryParam(req, "leadId");
    const customerId = queryParam(req, "customerId");
    if (leadId !== "") ok(res, await service.getForLead(leadId));
    else if (customerId !== "") ok(res, await service.getForCustomer(customerId));
    else throw AppError.validation("leadId or customerId is required");
  });

  router.get("/api/v1/referrals/referrer-users", ...guard(...picker), async (req, res) => {
    ok(res, await service.listReferrerUsers(queryParam(req, "q")));
  });

  router.get("/api/v1/referrals", ...guard(...view), async (req, res) => {
    const f = listFilter(req);
    const { items, total } = await service.list(f);
    sendJson(res, 200, {
      success: true,
      data: items,
      meta: { total, limit: f.limit <= 0 ? 50 : f.limit, offset: f.offset },
    });
  });

  router.post("/api/v1/referrals", ...guard(P.ReferralsCreate, P.ReferralsManage), jsonBody, async (req, res) => {
    const { leadId, customerId, ...input } = decodeJson(req, createSchema);
    created(res, await service.createFor(claimsOf(req).userId, leadId, customerId, input, requestMeta(req)));
  });

  router.get("/api/v1/referrals/:id", ...guard(...view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/referrals/:id", ...guard(P.ReferralsEdit, P.ReferralsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, referralUpdateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMeta(req)));
  });

  router.get("/api/v1/referrers/:type/:id", ...guard(...view), async (req, res) => {
    ok(res, await service.referrerProfile(pathParam(req, "type"), pathParam(req, "id")));
  });

  router.get("/api/v1/referral-partners", ...guard(...picker), async (req, res) => {
    ok(res, await service.listPartners(queryParam(req, "q")));
  });

  router.post("/api/v1/referral-partners", ...guard(P.ReferralsCreate, P.ReferralsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, partnerInputSchema);
    created(res, await service.createPartner(claimsOf(req).userId, input, requestMeta(req)));
  });

  return router;
}
