import type { ScopeMap } from "../permissions/permissions.js";

/** Authenticated identity loaded per request, as in the Go auth.Claims. */
export interface Claims {
  userId: string;
  email: string;
  fullName: string;
  roleCode: string;
  roleId: string;
  teamIds: string[];
  /** Users sharing the caller's team memberships (for TEAM scope filters). */
  teamMemberUserIds: string[];
  permissions: string[];
  permissionScopes: ScopeMap;
  expiresAt: Date;
}

/** The authenticated principal returned to clients. */
export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  timezone: string;
  phone: string;
  /** null when the user is in no team, as the Go API returns it. */
  teamIds: string[] | null;
  permissions: string[];
  permissionScopes?: ScopeMap;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phone: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  timezone: string;
}
