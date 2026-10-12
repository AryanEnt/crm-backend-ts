import type { RequestHandler } from "express";
import { logger } from "../logger.js";

/** Go logs r.URL.Path, which is percent-decoded. */
function decodedPath(url: string): string {
  const raw = url.split("?")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  // "close" also fires when the client disconnects early; Go logs every request once its handler returns.
  res.on("close", () => {
    logger.info(
      {
        method: req.method,
        path: decodedPath(req.originalUrl),
        status: res.statusCode,
        duration_ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        request_id: req.requestId,
      },
      "request",
    );
  });
  next();
};
