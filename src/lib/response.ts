import type { Response } from "express";
import { AppError, ErrorCode, isAppError } from "./app-error.js";
import { logger } from "../logger.js";
import { goSortKeys } from "./go-json.js";

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** The standard response wrapper; key order and omission rules match the Go Envelope. */
export interface Envelope {
  success: boolean;
  data?: unknown;
  error?: ErrorBody;
  meta?: Record<string, unknown>;
}

export function sendJson(res: Response, status: number, payload: Envelope): void {
  const body: Record<string, unknown> = { success: payload.success };
  if (payload.data !== undefined) body.data = payload.data;
  if (payload.error !== undefined) body.error = payload.error;
  // meta is a Go map: encoded with sorted keys.
  if (payload.meta !== undefined && Object.keys(payload.meta).length > 0) body.meta = goSortKeys(payload.meta);
  body.timestamp = new Date().toISOString();
  // Go's json.Encoder: plain application/json (no charset) and a trailing newline.
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body) + "\n");
}

export function ok(res: Response, data: unknown): void {
  sendJson(res, 200, { success: true, data });
}

export function created(res: Response, data: unknown): void {
  sendJson(res, 201, { success: true, data });
}

export function fail(res: Response, err: unknown): void {
  if (isAppError(err)) {
    if (err.code === ErrorCode.Internal) {
      logger.error({ err: err.cause ?? err }, err.message);
    }
    const error: ErrorBody = { code: err.code, message: err.message };
    if (err.details && Object.keys(err.details).length > 0) error.details = goSortKeys(err.details);
    sendJson(res, err.status, { success: false, error });
    return;
  }
  logger.error({ err }, "unhandled error");
  sendJson(res, 500, {
    success: false,
    error: { code: ErrorCode.Internal, message: "An unexpected error occurred" },
  });
}

export { AppError };
