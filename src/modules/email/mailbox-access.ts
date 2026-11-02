import type { Claims } from "../auth/types.js";
import { P, Role, scopeFor } from "../permissions/permissions.js";
import type { AccountRecord } from "./email.repository.js";

export function canSendFromMailbox(claims: Claims, acc: AccountRecord): boolean {
  return acc.userId === claims.userId;
}

export function canManageMailbox(claims: Claims, acc: AccountRecord): boolean {
  if (acc.userId === claims.userId) return true;
  if (claims.roleCode === Role.SuperAdmin) return true;
  const scope = scopeFor(claims.permissionScopes, P.EmailManage) || scopeFor(claims.permissionScopes, P.EmailView);
  if (scope === "organization") return true;
  if ((scope === "team" || claims.roleCode === Role.SalesManager) && claims.teamMemberUserIds.includes(acc.userId)) {
    return true;
  }
  return false;
}

/** Disconnect, replace password, edit IMAP/SMTP — current manager, org admin, or legacy unowned mailbox. */
export function canChangeMailboxSettings(claims: Claims, acc: AccountRecord): boolean {
  if (claims.roleCode === Role.SuperAdmin) return true;
  const scope = scopeFor(claims.permissionScopes, P.EmailManage);
  if (scope === "organization") return true;
  if (acc.managerUserId && acc.managerUserId === claims.userId) return true;
  if (!acc.managerUserId && canInviteUser(claims, acc.userId)) return true;
  return false;
}

export function assignedUserIds(claims: Claims): string[] {
  const ids = new Set<string>([claims.userId, ...claims.teamMemberUserIds]);
  return [...ids];
}

export function canInviteUser(claims: Claims, invitedUserId: string): boolean {
  if (invitedUserId === claims.userId) return true;
  if (claims.roleCode === Role.SuperAdmin) return true;
  const scope = scopeFor(claims.permissionScopes, P.EmailManage) || scopeFor(claims.permissionScopes, P.EmailView);
  if (scope === "organization") return true;
  if (scope === "team" || claims.roleCode === Role.SalesManager) {
    return claims.teamMemberUserIds.includes(invitedUserId);
  }
  return false;
}
