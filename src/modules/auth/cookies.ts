import type { CookieOptions, Request, Response } from "express";
import { isDevelopment, type Config } from "../../config.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "./tokens.js";
import type { TokenPair } from "./types.js";

const REFRESH_PATH = "/api/v1/auth";

function base(cfg: Config): CookieOptions {
  const dev = isDevelopment(cfg);
  return { httpOnly: true, secure: !dev, sameSite: dev ? "lax" : "none" };
}

export function setAuthCookies(res: Response, cfg: Config, pair: TokenPair): void {
  const now = Date.now();
  res.cookie(ACCESS_COOKIE, pair.accessToken, {
    ...base(cfg),
    path: "/",
    maxAge: Math.max(0, pair.accessExpiresAt.getTime() - now),
  });
  res.cookie(REFRESH_COOKIE, pair.refreshToken, {
    ...base(cfg),
    path: REFRESH_PATH,
    maxAge: Math.max(0, pair.refreshExpiresAt.getTime() - now),
  });
}

export function clearAuthCookies(res: Response, cfg: Config): void {
  // res.clearCookie drops Max-Age; send Max-Age=0 like the Go backend.
  res.cookie(ACCESS_COOKIE, "", { ...base(cfg), path: "/", maxAge: 0 });
  res.cookie(REFRESH_COOKIE, "", { ...base(cfg), path: REFRESH_PATH, maxAge: 0 });
}

export function refreshTokenFromRequest(req: Request): string {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" ? value : "";
}

/** Bearer header first, then the access cookie. */
export function extractBearer(req: Request): string {
  const header = req.get("Authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const cookie: unknown = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === "string" ? cookie : "";
}

export { clientIp } from "../../lib/request-meta.js";
