import type { ServerResponse } from "node:http";
import type { RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../logger.js";

/** Headers this server already sets; Go's copies would be duplicated and break CORS. */
const STRIP_FROM_GO = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "vary",
  "x-request-id",
];

/**
 * Forwards every request no TypeScript route handled to the Go backend, unchanged.
 * Mounted last; the request body is still unread because JSON parsing is per-router.
 */
export function goProxy(target: string): RequestHandler {
  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    logger: { info: () => undefined, warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) },
    on: {
      proxyReq: (proxyReq, req) => {
        const id = (req as { requestId?: string }).requestId;
        if (id) proxyReq.setHeader("X-Request-ID", id);
      },
      proxyRes: (proxyRes) => {
        for (const h of STRIP_FROM_GO) delete proxyRes.headers[h];
      },
      error: (err, req, res) => {
        logger.error({ err, path: req.url, target }, "go backend unreachable");
        const out = res as ServerResponse;
        if (typeof out.writeHead !== "function" || out.headersSent) return;
        out.writeHead(502, { "Content-Type": "application/json" });
        out.end(
          JSON.stringify({
            success: false,
            error: { code: "upstream_unavailable", message: "Upstream service is unavailable" },
            timestamp: new Date().toISOString(),
          }),
        );
      },
    },
  });
  return (req, res, next) => {
    void proxy(req, res, next);
  };
}
