import type { RequestHandler } from "express";
import type { Database } from "../../db/database.js";
import { pathParam } from "../../lib/request-meta.js";
import { requireRecord, type RecordSpec } from "../datascope/record.js";
import { authenticate, claimsOf, requirePermission } from "./auth.middleware.js";
import type { AuthService } from "./auth.service.js";

/** Go router's protect(perms, h): authenticate, then require any of perms (if given). */
export type Guard = (...perms: string[]) => RequestHandler[];

export function createGuard(service: AuthService): Guard {
  const auth = authenticate(service);
  return (...perms) => (perms.length > 0 ? [auth, requirePermission(...perms)] : [auth]);
}

/**
 * Go router's inScope: 404s unless the :param record is inside the caller's widest
 * data scope across perms. Handlers behind it load by id alone.
 */
export function inScope(db: Database, rec: RecordSpec, perms: string[], param = "id"): RequestHandler {
  return async (req, _res, next) => {
    await requireRecord(db, claimsOf(req), rec, pathParam(req, param), ...perms);
    next();
  };
}
