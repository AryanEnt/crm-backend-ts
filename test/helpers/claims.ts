import type { Claims } from "../../src/modules/auth/types.js";

export function claims(partial: Partial<Claims>): Claims {
  return {
    userId: "",
    email: "",
    fullName: "",
    roleCode: "",
    roleId: "",
    teamIds: [],
    teamMemberUserIds: [],
    permissions: [],
    permissionScopes: {},
    expiresAt: new Date(0),
    ...partial,
  };
}
