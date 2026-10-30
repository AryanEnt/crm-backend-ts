import type { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { atoi, parseBool, queryParam } from "../../lib/query.js";
import { pathParam } from "../../lib/request-meta.js";
import { ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { NotificationsService, validNotificationType } from "./notifications.service.js";

export function notificationsRouter(service: NotificationsService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/notifications", ...guard(), async (req, res) => {
    const type = queryParam(req, "type");
    if (!validNotificationType(type)) throw AppError.validation("unknown notification type");
    const { items, total, limit, offset } = await service.list(claimsOf(req).userId, {
      unread: parseBool(queryParam(req, "unread")),
      type,
      createdFrom: queryParam(req, "createdFrom"),
      createdTo: queryParam(req, "createdTo"),
      limit: atoi(queryParam(req, "limit")),
      offset: atoi(queryParam(req, "offset")),
    });
    sendJson(res, 200, { success: true, data: items, meta: { total, limit, offset } });
  });

  router.get("/api/v1/notifications/unread-count", ...guard(), async (req, res) => {
    ok(res, { unread: await service.unreadCount(claimsOf(req).userId) });
  });

  router.post("/api/v1/notifications/mark-all-read", ...guard(), async (req, res) => {
    ok(res, { updated: await service.markAllRead(claimsOf(req).userId) });
  });

  router.post("/api/v1/notifications/:id/read", ...guard(), async (req, res) => {
    ok(res, await service.markRead(claimsOf(req).userId, pathParam(req, "id"), true));
  });

  router.post("/api/v1/notifications/:id/unread", ...guard(), async (req, res) => {
    ok(res, await service.markRead(claimsOf(req).userId, pathParam(req, "id"), false));
  });

  return router;
}
