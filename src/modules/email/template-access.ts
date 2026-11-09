import { AppError } from "../../lib/app-error.js";
import type { Claims } from "../auth/types.js";
import { P, Role, scopeFor } from "../permissions/permissions.js";

/** Org admins can list and manage templates across teams (e.g. automations). */
export function canSeeAllTemplates(claims: Claims): boolean {
  if (claims.roleCode === Role.SuperAdmin) return true;
  const scope =
    scopeFor(claims.permissionScopes, P.EmailManage) || scopeFor(claims.permissionScopes, P.EmailView);
  return scope === "organization";
}

/** Team-scoped callers only see templates stamped with one of their teams. */
export function canAccessTemplateTeam(claims: Claims, teamId: string | null | undefined): boolean {
  if (canSeeAllTemplates(claims)) return true;
  if (!teamId) return false;
  return claims.teamIds.includes(teamId);
}

export function assertCanAccessTemplateTeam(claims: Claims, teamId: string | null | undefined): void {
  if (!canAccessTemplateTeam(claims, teamId)) {
    throw AppError.forbidden("This template belongs to another team");
  }
}

/**
 * Team Leads always write to their own team. Client-supplied teamId is ignored unless it is
 * one of the caller's teams (or the caller is org-scoped).
 */
export function resolveTemplateTeamId(claims: Claims, requested: string | undefined): string {
  const asked = requested?.trim() ?? "";
  if (canSeeAllTemplates(claims)) {
    if (asked === "") throw AppError.validation("teamId is required");
    return asked;
  }
  const teamId = asked !== "" ? asked : (claims.teamIds[0] ?? "");
  if (teamId === "") throw AppError.validation("You must belong to a team to manage email templates");
  if (!claims.teamIds.includes(teamId)) {
    throw AppError.forbidden("Templates must stay on your team");
  }
  return teamId;
}
