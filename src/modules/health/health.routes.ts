import type { RequestHandler, Router } from "express";
import { createRouter } from "../../lib/router.js";
import { ping, type Database } from "../../db/database.js";
import { sendJson } from "../../lib/response.js";

export const VERSION = "0.1.0";

/** Formats like Go's time.Duration.String() rounded to the second: "45s", "13m34s", "2h0m5s". */
export function formatUptime(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export function healthRouter(db: Database): Router {
  const started = Date.now();
  const router = createRouter();

  const handler: RequestHandler = async (_req, res) => {
    let database = "ok";
    try {
      await ping(db);
    } catch {
      database = "unavailable";
    }
    const status = database === "ok" ? "ok" : "degraded";
    sendJson(res, status === "ok" ? 200 : 503, {
      success: status === "ok",
      data: {
        status,
        version: VERSION,
        uptime: formatUptime(Date.now() - started),
        checks: { database },
        timestamp: new Date().toISOString(),
      },
    });
  };

  router.get("/api/health", handler);
  router.get("/api/v1/health", handler);
  return router;
}
