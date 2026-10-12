import type { Request, RequestHandler } from "express";
import { AppError } from "../../lib/app-error.js";
import { expandImplies } from "../permissions/permissions.js";
import type { AuthService } from "./auth.service.js";
import { extractBearer } from "./cookies.js";
import type { Claims } from "./types.js";

/** Validates the Bearer access token (or access cookie) and loads req.claims. */
export function authenticate(service: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const token = extractBearer(req);
    if (token === "") throw AppError.unauthorized("authentication required");
    req.claims = await service.authenticateAccessToken(token);
    next();
  };
}

/** Requires at least one of the given permissions. */
export function requirePermission(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    const set = expandImplies(req.claims?.permissions ?? []);
    if (!set.hasAny(...codes)) throw AppError.forbidden("insufficient permissions");
    next();
  };
}

/** Requires every given permission. */
export function requireAllPermissions(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    const set = expandImplies(req.claims?.permissions ?? []);
    if (!set.hasAll(...codes)) throw AppError.forbidden("insufficient permissions");
    next();
  };
}

/** Claims for a route behind authenticate(); throws 401 if the middleware was skipped. */
export function claimsOf(req: Request): Claims {
  if (!req.claims) throw AppError.unauthorized("authentication required");
  return req.claims;
}
