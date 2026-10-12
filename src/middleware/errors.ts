import express, { type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import { AppError } from "../lib/app-error.js";
import { fail } from "../lib/response.js";

const emptyBody = new WeakSet<object>();

const parseJson = express.json({
  limit: "5mb",
  type: () => true,
  // Go decodes a top-level null into a struct as a no-op; other non-objects still fail in decodeJson.
  strict: false,
  verify: (req, _res, buf) => {
    if (buf.toString("utf8").trim() === "") emptyBody.add(req);
  },
});

/**
 * JSON body parsing for ported routes. Like Go's DecodeJSON it ignores Content-Type,
 * and an empty body stays undefined (body-parser would turn it into {}) so handlers
 * report "EOF" like Go. Only mounted on TypeScript routers so forwarded requests keep
 * their raw body.
 */
export const jsonBody: RequestHandler = (req, res, next) => {
  parseJson(req, res, (err?: unknown) => {
    if (!err && emptyBody.has(req)) req.body = undefined;
    next(err);
  });
};

interface RouteLayer {
  match(path: string): boolean;
  route?: { methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
}

function allowedMethods(stack: RouteLayer[], path: string, out: Set<string>): void {
  for (const layer of stack) {
    if (!layer.match(path)) continue;
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) if (m !== "_all") out.add(m.toUpperCase());
    } else if (layer.handle?.stack) {
      allowedMethods(layer.handle.stack, path, out);
    }
  }
}

/** Go's http.Error: plain text with a trailing newline. */
function goHttpError(res: Response, status: number, text: string): void {
  res.status(status);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(text + "\n");
}

/** Go's ServeMux fallback: 405 with Allow when another method matches the path, else 404. */
export const notFound: RequestHandler = (req, res) => {
  const methods = new Set<string>();
  const stack = (req.app as unknown as { router?: { stack?: RouteLayer[] } }).router?.stack ?? [];
  allowedMethods(stack, req.path, methods);
  if (methods.has("GET")) methods.add("HEAD");
  if (methods.size > 0) {
    res.setHeader("Allow", [...methods].sort().join(", "));
    goHttpError(res, 405, "Method Not Allowed");
    return;
  }
  goHttpError(res, 404, "404 page not found");
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const bodyError = err as { type?: string; message?: string };
  if (bodyError.type === "entity.parse.failed") {
    fail(res, AppError.validation(`invalid JSON body: ${bodyError.message ?? "malformed JSON"}`));
    return;
  }
  if (bodyError.type === "entity.too.large") {
    fail(res, AppError.validation("invalid JSON body: request body too large"));
    return;
  }
  fail(res, err);
};
