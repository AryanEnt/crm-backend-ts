import { AppError } from "../../lib/app-error.js";
import type { Claims } from "../auth/types.js";
import { widestScope } from "../datascope/datascope.js";
import { Role, type MaybeScope } from "../permissions/permissions.js";

/** The fields of a user record the policy looks at. */
export interface PolicyUser {
  id: string;
  roleId: string;
  roleCode: string;
  teamIds: string[] | null;
}

/** The caller's reach over user records for one kind of action. The zero value sees nothing. */
export class UserAccess {
  constructor(
    readonly scope: MaybeScope = "",
    readonly userId = "",
    readonly teamIds: readonly string[] = [],
  ) {}

  static for(claims: Claims, ...codes: string[]): UserAccess {
    return new UserAccess(widestScope(claims, ...codes), claims.userId, claims.teamIds);
  }

  get organization(): boolean {
    return this.scope === "organization";
  }

  /** Organization sees everyone, team sees themselves and anyone on their teams, own sees themselves. */
  canSee(u: PolicyUser | null): boolean {
    if (!u) return false;
    switch (this.scope) {
      case "organization":
        return true;
      case "team":
        return u.id === this.userId || sharesTeam(u.teamIds, this.teamIds);
      case "own":
        return this.userId !== "" && u.id === this.userId;
      default:
        return false;
    }
  }

  /** Team scope manages only the Sales Executives on the caller's teams, never themselves. */
  canManage(u: PolicyUser | null): boolean {
    if (!u) return false;
    switch (this.scope) {
      case "organization":
        return true;
      case "team":
        return u.id !== this.userId && u.roleCode === Role.SalesExecutive && sharesTeam(u.teamIds, this.teamIds);
      default:
        return false;
    }
  }

  /** Hides records the caller can't see (404) and refuses visible ones they can't manage (403). */
  requireManage(u: PolicyUser | null): void {
    if (!this.canSee(u)) throw AppError.notFound("user not found");
    if (!this.canManage(u)) throw AppError.forbidden("You can only manage Sales Executives on your own team");
  }

  /**
   * The team assignment for a new user: team-scoped callers get their own team filled in
   * and may not pick any other.
   */
  resolveCreateTeams(roleCode: string, teamIds: string[]): string[] {
    if (this.scope === "organization") return teamIds;
    if (this.scope !== "team") throw AppError.forbidden("You don't have permission to add users");
    if (roleCode !== Role.SalesExecutive) throw AppError.forbidden("Team Leads can only add Sales Executives");
    if (this.teamIds.length === 0) {
      throw AppError.forbidden("You aren't assigned to a team yet, so you can't add Sales Executives");
    }
    if (teamIds.length === 0) {
      if (this.teamIds.length > 1) throw AppError.fieldValidation("team_id", "Choose which of your teams to add them to");
      return [this.teamIds[0]!];
    }
    for (const id of teamIds) {
      if (!this.teamIds.includes(id)) throw AppError.forbidden("You can only add Sales Executives to your own team");
    }
    return teamIds;
  }

  /** Keeps role changes and team moves with organization-scoped callers. */
  authorizeUpdate(current: PolicyUser, roleId: string | undefined, teamIds: string[] | null, teamsProvided: boolean): void {
    this.requireManage(current);
    if (this.organization) return;
    if (roleId !== undefined && roleId !== current.roleId) {
      throw AppError.forbidden("Only Super Admin can change a user's role");
    }
    if (teamsProvided && !teamsEqual(current.teamIds, teamIds)) {
      throw AppError.forbidden("Only Super Admin can move people between teams");
    }
  }
}

function sharesTeam(a: readonly string[] | null, b: readonly string[]): boolean {
  return (a ?? []).some((x) => b.includes(x));
}

export function teamsEqual(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  const set = new Set(x);
  return y.every((id) => set.has(id));
}
