import { sql, type RawBuilder } from "kysely";
import { AppError } from "../../lib/app-error.js";
import type { Claims } from "../auth/types.js";
import {
  Role,
  expandImplies,
  scopeFor,
  widenScope,
  type MaybeScope,
  type Scope,
} from "../permissions/permissions.js";

/** How list/get queries must restrict rows for the caller. */
export interface Visibility {
  unscoped: boolean;
  ownerIds: string[];
  teamIds: string[];
}

export const NO_MATCH_ID = "00000000-0000-0000-0000-000000000000";

const visibility = (v: Partial<Visibility>): Visibility => ({
  unscoped: false,
  ownerIds: [],
  teamIds: [],
  ...v,
});

/**
 * The caller's data scope for a view permission, falling back to role defaults
 * when the grant carries no explicit scope.
 */
export function effectiveScope(claims: Claims, viewPermission: string): Scope {
  const scope = scopeFor(claims.permissionScopes, viewPermission);
  if (scope !== "") return scope;
  if (!expandImplies(claims.permissions).has(viewPermission)) {
    throw AppError.forbidden("missing permission");
  }
  switch (claims.roleCode) {
    case Role.SuperAdmin:
      return "organization";
    case Role.SalesManager:
      return "team";
    default:
      return "own";
  }
}

/** effectiveScope across routes that accept any of several permissions; fails only when none are held. */
export function widestScope(claims: Claims, ...codes: string[]): Scope {
  let widest: MaybeScope = "";
  let firstErr: unknown;
  for (const code of codes) {
    try {
      widest = widenScope(widest, effectiveScope(claims, code));
    } catch (err) {
      firstErr ??= err;
    }
  }
  if (widest === "") throw firstErr ?? AppError.forbidden("missing permission");
  return widest;
}

/** Visibility for a view permission and optional sales_executive_id filter. */
export function resolve(claims: Claims, viewPermission: string, salesExecutiveId = ""): Visibility {
  const scope = effectiveScope(claims, viewPermission);
  const seId = salesExecutiveId.trim();

  switch (scope) {
    case "organization":
      return seId ? visibility({ ownerIds: [seId] }) : visibility({ unscoped: true });

    case "team": {
      if (claims.teamIds.length === 0) return visibility({ ownerIds: [NO_MATCH_ID] });
      const v = visibility({ teamIds: [...claims.teamIds] });
      if (seId) {
        if (
          claims.teamMemberUserIds.length > 0 &&
          !claims.teamMemberUserIds.includes(seId) &&
          seId !== claims.userId
        ) {
          throw AppError.forbidden("sales executive is outside your team scope");
        }
        v.ownerIds = [seId];
      }
      return v;
    }

    default:
      if (seId && seId !== claims.userId) {
        throw AppError.forbidden("cannot filter records outside your scope");
      }
      return visibility({ ownerIds: [claims.userId] });
  }
}

/** Clamped team/owner filter for aggregate reporting queries (one team, one owner at most). */
export interface ReportScope {
  scope: Scope;
  teamId: string;
  ownerUserId: string;
  /** Bounds per-user breakdown rows. null means unrestricted; [] means no rows. */
  userIds: string[] | null;
  /** Bounds per-team breakdown rows. null means unrestricted; [] means no rows. */
  teamIds: string[] | null;
}

/**
 * Clamps requested teamId/ownerUserId filters to the caller's scope. Own scope is pinned
 * to the caller; team scope to one of the caller's teams (the first when none is requested).
 */
export function resolveReport(
  claims: Claims,
  viewPermission: string,
  teamId = "",
  ownerUserId = "",
): ReportScope {
  const scope = effectiveScope(claims, viewPermission);
  const rs: ReportScope = {
    scope,
    teamId: teamId.trim(),
    ownerUserId: ownerUserId.trim(),
    userIds: null,
    teamIds: null,
  };

  switch (scope) {
    case "organization":
      return rs;

    case "team":
      if (claims.teamIds.length === 0) {
        return { ...rs, teamId: "", ownerUserId: NO_MATCH_ID, userIds: [], teamIds: [] };
      }
      if (rs.teamId === "") {
        rs.teamId = claims.teamIds[0]!;
      } else if (!claims.teamIds.includes(rs.teamId)) {
        throw AppError.forbidden("requested team is outside your scope");
      }
      if (
        rs.ownerUserId !== "" &&
        rs.ownerUserId !== claims.userId &&
        !claims.teamMemberUserIds.includes(rs.ownerUserId)
      ) {
        throw AppError.forbidden("requested owner is outside your scope");
      }
      rs.userIds = [claims.userId, ...claims.teamMemberUserIds];
      rs.teamIds = [rs.teamId];
      return rs;

    default:
      if (rs.ownerUserId !== "" && rs.ownerUserId !== claims.userId) {
        throw AppError.forbidden("requested owner is outside your scope");
      }
      return { ...rs, ownerUserId: claims.userId, userIds: [claims.userId], teamIds: [] };
  }
}

/** Narrows visibility with an explicit ownerUserId query param. */
export function applyOwnerFilter(v: Visibility, ownerUserId: string): Visibility {
  const owner = ownerUserId.trim();
  if (owner === "") return v;
  if (v.unscoped) return visibility({ ownerIds: [owner] });
  if (v.ownerIds.length === 1 && v.ownerIds[0] === owner) return v;
  if (v.ownerIds.length > 0 && !v.ownerIds.includes(owner)) {
    throw AppError.forbidden("requested owner is outside your scope");
  }
  // Team scope without an owner list: accepted; SQL still constrains by team.
  return { ...v, ownerIds: [owner] };
}

/** Ownership columns on a CRM entity. Column names are trusted constants, never user input. */
export interface Columns {
  /** e.g. "l.owner_user_id" */
  owner: string;
  /** e.g. "l.team_id"; empty for tables without team_id */
  team?: string;
}

export type Predicate = RawBuilder<unknown>;

/** Appends the visibility predicate for v to where (nothing when unscoped). */
export function appendScope(where: Predicate[], v: Visibility, cols: Columns): Predicate[] {
  if (v.unscoped) return where;

  // Explicit owner filter (OWN scope, or TEAM/ORG with an SE selected)
  if (v.ownerIds.length > 0 && cols.owner) {
    const ownerPred = sql`${sql.raw(cols.owner)} = ANY(${v.ownerIds}::uuid[])`;
    if (v.teamIds.length === 0) return [...where, ownerPred];
    // Owner + team: require both (prevents IDOR if the SE list is stale)
    return [...where, sql`(${ownerPred} AND ${teamMembershipPred(cols, v.teamIds)})`];
  }

  if (v.teamIds.length > 0) return [...where, teamMembershipPred(cols, v.teamIds)];

  return [...where, sql`FALSE`];
}

function teamMembershipPred(cols: Columns, teamIds: string[]): Predicate {
  const parts: Predicate[] = [];
  if (cols.team) parts.push(sql`${sql.raw(cols.team)} = ANY(${teamIds}::uuid[])`);
  if (cols.owner) {
    parts.push(
      sql`${sql.raw(cols.owner)} IN (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = ANY(${teamIds}::uuid[]))`,
    );
  }
  if (parts.length === 0) return sql`FALSE`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

export function and(where: Predicate[]): Predicate {
  return where.length === 0 ? sql`TRUE` : sql.join(where, sql` AND `);
}
