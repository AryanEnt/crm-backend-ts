import type { Request, Router } from "express";
import { z } from "zod";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam } from "../../lib/request-meta.js";
import { created, ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { CallsService } from "./calls.service.js";

const createNoteSchema = z.strictObject({
  entityType: str(),
  entityId: str(),
  topic: str(),
  content: str(),
});

const pinSchema = z.strictObject({
  entityType: str(),
  entityId: str(),
});

const updateNoteSchema = z.strictObject({
  topic: optionalString(),
  content: optionalString(),
});

export function callsRouter(service: CallsService, guard: Guard): Router {
  const router = createRouter();
  const view = guard(P.LeadsView, P.CustomersView);
  const record = (req: Request) => [queryParam(req, "type"), queryParam(req, "id")] as const;

  router.get("/api/v1/calls/contacts", ...view, async (req, res) => {
    ok(
      res,
      await service.contacts(claimsOf(req), {
        search: queryParam(req, "q"),
        type: queryParam(req, "type"),
        priority: queryParam(req, "priority"),
        pinnedOnly: queryParam(req, "pinned") === "true",
        limit: atoi(queryParam(req, "limit")),
      }),
    );
  });

  router.post("/api/v1/calls/pins", ...view, jsonBody, async (req, res) => {
    await service.pin(claimsOf(req), decodeJson(req, pinSchema));
    ok(res, { pinned: true });
  });

  router.delete("/api/v1/calls/pins/:type/:id", ...view, async (req, res) => {
    await service.unpin(claimsOf(req), pathParam(req, "type"), pathParam(req, "id"));
    ok(res, { pinned: false });
  });

  router.get("/api/v1/calls/context", ...view, async (req, res) => {
    ok(res, await service.context(claimsOf(req), ...record(req)));
  });

  router.get("/api/v1/calls/history", ...view, async (req, res) => {
    ok(res, await service.history(claimsOf(req), ...record(req)));
  });

  router.get("/api/v1/calls/notes", ...view, async (req, res) => {
    ok(res, await service.listNotes(claimsOf(req), ...record(req)));
  });

  router.post("/api/v1/calls/notes", ...guard(P.ActivitiesCreate), jsonBody, async (req, res) => {
    created(res, await service.createNote(claimsOf(req), decodeJson(req, createNoteSchema)));
  });

  router.patch("/api/v1/calls/notes/:id", ...guard(P.ActivitiesEdit), jsonBody, async (req, res) => {
    ok(res, await service.updateNote(claimsOf(req), pathParam(req, "id"), decodeJson(req, updateNoteSchema)));
  });

  router.delete("/api/v1/calls/notes/:id", ...guard(P.ActivitiesEdit), async (req, res) => {
    await service.deleteNote(claimsOf(req), pathParam(req, "id"));
    ok(res, { deleted: true });
  });

  return router;
}
