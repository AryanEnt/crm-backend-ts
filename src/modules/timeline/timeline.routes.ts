import type { Router } from "express";
import { z } from "zod";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { anyMap, decodeJson, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import { TIMELINE_EVENT_TYPES, type TimelineService } from "./timeline.service.js";

const externalWriteSchema = z.strictObject({
  eventType: str(),
  title: str(),
  body: str(),
  occurredAt: optionalString(),
  source: str(),
  externalId: str(),
  externalProvider: str(),
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
  activityId: optionalString(),
  documentId: optionalString(),
  metadata: anyMap(),
});

export function timelineRouter(service: TimelineService, guard: Guard): Router {
  const router = createRouter();

  // Go serves timelines for any id the caller names; only the view permission is checked.
  router.get("/api/v1/timeline", ...guard(P.CustomersView, P.LeadsView, P.DealsView, P.ActivitiesView), async (req, res) => {
    const q = (k: string) => queryParam(req, k);
    let limit = atoi(q("limit"));
    const offset = atoi(q("offset"));
    if (limit <= 0) limit = 30;
    const eventTypes = q("types")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (q("type") !== "") eventTypes.push(q("type"));
    const { items, total } = await service.list({
      customerId: q("customerId"),
      dealId: q("dealId"),
      leadId: q("leadId"),
      eventTypes,
      source: q("source"),
      limit,
      offset,
    });
    sendJson(res, 200, {
      success: true,
      data: items,
      meta: { total, limit, offset, hasMore: offset + items.length < total },
    });
  });

  router.get("/api/v1/timeline/types", ...guard(P.CustomersView, P.LeadsView, P.DealsView), (_req, res) => {
    ok(res, TIMELINE_EVENT_TYPES);
  });

  router.get("/api/v1/timeline/:id", ...guard(P.CustomersView, P.LeadsView, P.DealsView), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.post("/api/v1/timeline/events", ...guard(P.ActivitiesCreate, P.DocumentsCreate), jsonBody, async (req, res) => {
    const input = decodeJson(req, externalWriteSchema);
    created(res, await service.writeExternal(claimsOf(req).userId, input));
  });

  return router;
}
