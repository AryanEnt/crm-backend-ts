import type { Request } from "express";
import { AppError } from "./app-error.js";

export interface RequestMeta {
  /** Raw X-Forwarded-For, else "ip:port" — how the Go handlers record it. */
  ip: string;
  userAgent: string;
}

export function requestMeta(req: Request): RequestMeta {
  return { ip: clientIp(req), userAgent: req.get("User-Agent") ?? "" };
}

export function clientIp(req: Request): string {
  const xff = req.get("X-Forwarded-For");
  if (xff) return xff;
  return `${remoteHost(req)}:${req.socket.remotePort ?? 0}`;
}

/** Go's RemoteAddr host: IPv4-mapped addresses unmapped, IPv6 in brackets. */
function remoteHost(req: Request): string {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return addr.includes(":") ? `[${addr}]` : addr;
}

/** The documents handlers' variant: first X-Forwarded-For hop, else the remote host without port. */
export function requestMetaFirstHop(req: Request): RequestMeta {
  const xff = req.get("X-Forwarded-For");
  const ip = xff ? (xff.split(",")[0] ?? "").trim() : remoteHost(req);
  return { ip, userAgent: req.get("User-Agent") ?? "" };
}

/** The email handlers' variant: first X-Forwarded-For hop, else "ip:port". */
export function requestMetaFirstHopWithPort(req: Request): RequestMeta {
  const xff = req.get("X-Forwarded-For");
  const ip = xff ? (xff.split(",")[0] ?? "").trim() : clientIp(req);
  return { ip, userAgent: req.get("User-Agent") ?? "" };
}

/** Express path parameter; routes guarantee it exists. */
export function pathParam(req: Request, name: string): string {
  const v: unknown = req.params[name];
  return typeof v === "string" ? v : "";
}

/** Runs a query, converting any failure to AppError.internal(message) like the Go services. */
export async function internal<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.internal(message, err);
  }
}

/** Go services detect unique violations with strings.Contains(err.Error(), "unique"). */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("unique") || msg.includes("duplicate");
}
