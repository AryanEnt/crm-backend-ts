import type { Router } from "express";
import { z } from "zod";
import { ok } from "../../lib/response.js";
import { requestMeta } from "../../lib/request-meta.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { SettingsService } from "./settings.service.js";

const updateSchema = z.strictObject({
  settings: z
    .record(z.string(), str())
    .nullish()
    .transform((v) => v ?? undefined),
});

export function settingsRouter(service: SettingsService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/settings", ...guard(P.SettingsView, P.SettingsManage), async (_req, res) => {
    ok(res, await service.list());
  });

  router.get(
    "/api/v1/settings/defaults",
    ...guard(P.SettingsView, P.LeadsCreate, P.CustomersCreate, P.DealsCreate, P.ActivitiesCreate),
    async (_req, res) => {
      ok(res, await service.defaults());
    },
  );

  router.put("/api/v1/settings", ...guard(P.SettingsManage), jsonBody, async (req, res) => {
    const { settings } = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, settings, requestMeta(req)));
  });

  return router;
}
