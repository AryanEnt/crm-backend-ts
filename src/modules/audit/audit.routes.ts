import type { Router } from "express";
import { internal } from "../../lib/request-meta.js";
import { sendJson } from "../../lib/response.js";
import { atoi, queryParam } from "../../lib/query.js";
import { createRouter } from "../../lib/router.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { AuditService } from "./audit.service.js";

export function auditRouter(audit: AuditService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/audit-logs", ...guard(P.AuditView), async (req, res) => {
    const limit = atoi(queryParam(req, "limit"));
    const offset = atoi(queryParam(req, "offset"));
    const { items, total } = await internal("failed to list audit logs", () =>
      audit.list({ search: queryParam(req, "q"), limit, offset }),
    );
    // Go echoes the raw query values in meta, not the clamped ones.
    sendJson(res, 200, { success: true, data: items, meta: { total, limit, offset } });
  });

  return router;
}
