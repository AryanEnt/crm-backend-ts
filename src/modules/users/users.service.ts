import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { bool, optionalBool, optionalString, str, stringArray } from "../../lib/validate.js";
import type { AuditService } from "../audit/audit.service.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { hashPassword } from "../auth/password.js";
import type { Claims } from "../auth/types.js";
import { P, Role, expandImplies } from "../permissions/permissions.js";
import { UserAccess, teamsEqual } from "./users.policy.js";

export interface User {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  /** null when the user is in no team (a nil slice in Go). */
  teamIds: string[] | null;
  lastLoginAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleInfo {
  id: string;
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

export const createSchema = z.strictObject({
  email: str(),
  password: str(),
  fullName: str(),
  phone: str(),
  roleId: str(),
  teamIds: stringArray(),
  teamId: str(),
  isActive: optionalBool(),
});
export type CreateInput = z.output<typeof createSchema>;

export const updateSchema = z.strictObject({
  email: optionalString(),
  fullName: optionalString(),
  phone: optionalString(),
  roleId: optionalString(),
  password: optionalString(),
  teamIds: stringArray(),
  teamId: optionalString(),
  isActive: optionalBool(),
  confirmTeamChange: bool(),
});
export type UpdateInput = z.output<typeof updateSchema>;

export const statusSchema = z.strictObject({ isActive: bool() });
export const bulkStatusSchema = z.strictObject({ ids: stringArray(), isActive: bool() });

export interface UserListFilter {
  search: string;
  roleId: string;
  roleCode: string;
  teamId: string;
  /** When set ("new" for a team being created), excludes SE/TL already on another team. */
  availableForTeamId: string;
  isActive: boolean | undefined;
  limit: number;
  offset: number;
}

interface TeamInfo {
  id: string;
  name: string;
  isActive: boolean;
  teamLeadUserId: string | null;
  teamLeadName: string | null;
}

const NO_USER_ID = "00000000-0000-0000-0000-000000000000";

type UserRow = Omit<User, "teamIds">;

const USER_COLUMNS = sql`
  u.id::text AS "id", u.email, u.full_name AS "fullName", COALESCE(u.phone, '') AS "phone",
  u.role_id::text AS "roleId", r.code AS "roleCode", r.name AS "roleName", u.is_active AS "isActive",
  u.last_login_at AS "lastLoginAt", u.deactivated_at AS "deactivatedAt", u.created_at AS "createdAt",
  u.updated_at AS "updatedAt"`;

const withTeams = (r: UserRow, teamIds: string[] | null): User => ({
  id: r.id,
  email: r.email,
  fullName: r.fullName,
  phone: r.phone,
  roleId: r.roleId,
  roleCode: r.roleCode,
  roleName: r.roleName,
  isActive: r.isActive,
  teamIds,
  lastLoginAt: r.lastLoginAt,
  deactivatedAt: r.deactivatedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const isEmailConflict = (err: unknown) => err instanceof Error && err.message.includes("users_email_unique");

/** The team-membership trigger's message, when err is one of its rejections. */
function membershipConflictMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("already assigned to") || msg.includes("Super Admin cannot") ? msg : "";
}

export function normalizeMembershipConflict(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("super admin")) return "Super Admin cannot be a team member or Team Lead";
  if (lower.includes("team lead") || lower.includes("sales_manager")) return "Team Lead is already assigned to another team.";
  return "Sales Executive is already assigned to another team.";
}

export function uniqueNonEmpty(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizeTeamIds(in_: Pick<CreateInput, "teamIds" | "teamId">): string[] {
  const ids = [...(in_.teamIds ?? [])];
  if (in_.teamId.trim() !== "") ids.push(in_.teamId.trim());
  return uniqueNonEmpty(ids);
}

function resolveUpdateTeamIds(in_: UpdateInput, current: string[] | null): { ids: string[] | null; provided: boolean } {
  if (in_.teamId !== undefined) {
    const id = in_.teamId.trim();
    return { ids: id === "" ? [] : [id], provided: true };
  }
  if (in_.teamIds !== undefined) return { ids: uniqueNonEmpty(in_.teamIds), provided: true };
  return { ids: current, provided: false };
}

const prevTeamLeadId = (t: TeamInfo | null) => t?.teamLeadUserId ?? null;

export class UsersRepository {
  constructor(private readonly db: Database) {}

  async list(f: UserListFilter, access: UserAccess): Promise<{ items: User[] | null; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 25 : f.limit;
    const where: RawBuilder<unknown>[] = [
      sql`(${f.search} = '' OR u.email ILIKE '%' || ${f.search} || '%' OR u.full_name ILIKE '%' || ${f.search} || '%')`,
      sql`(${f.roleId} = '' OR u.role_id::text = ${f.roleId})`,
      sql`(${f.roleCode} = '' OR r.code = ${f.roleCode})`,
    ];
    if (!access.organization) {
      const teamIds = access.scope === "team" ? [...access.teamIds] : [];
      const selfId = access.userId || NO_USER_ID;
      where.push(sql`(u.id::text = ${selfId} OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id = ANY(${teamIds}::uuid[])))`);
    }
    if (f.isActive !== undefined) where.push(sql`u.is_active = ${f.isActive}`);
    if (f.teamId !== "") {
      where.push(sql`EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id::text = ${f.teamId})`);
    }
    if (f.availableForTeamId !== "") {
      // Super Admin never appears in team pickers; SE/TL only when unassigned or already on this team.
      where.push(sql`r.code <> 'super_admin'`);
      const exceptId = f.availableForTeamId === "new" ? NO_USER_ID : f.availableForTeamId;
      where.push(sql`
        (
          r.code NOT IN ('sales_executive', 'sales_manager')
          OR NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id::text <> ${exceptId})
          OR (
            ${exceptId} <> '00000000-0000-0000-0000-000000000000'
            AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id::text = ${exceptId})
          )
        )`);
    }
    const whereSql = sql.join(where, sql` AND `);

    const count = await sql<{ total: number }>`
      SELECT COUNT(*)::int AS total FROM users u JOIN roles r ON r.id = u.role_id WHERE ${whereSql}`.execute(this.db);
    const rows = await sql<UserRow>`
      SELECT ${USER_COLUMNS}
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);

    const items: User[] = [];
    for (const r of rows.rows) items.push(withTeams(r, await this.listTeamIds(r.id)));
    return { items: items.length > 0 ? items : null, total: count.rows[0]?.total ?? 0 };
  }

  async get(id: string): Promise<User | null> {
    const r = await sql<UserRow>`
      SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${id}`.execute(this.db);
    const row = r.rows[0];
    return row ? withTeams(row, await this.listTeamIds(row.id)) : null;
  }

  async create(in_: CreateInput, passwordHash: string, teamIds: string[]): Promise<User | null> {
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO users (id, email, password_hash, full_name, phone, role_id, is_active)
        VALUES (${id}, ${in_.email.trim().toLowerCase()}, ${passwordHash}, ${in_.fullName.trim()}, ${in_.phone.trim()},
          ${in_.roleId}, ${in_.isActive ?? true})`.execute(this.db);
    } catch (err) {
      if (isEmailConflict(err)) throw AppError.conflict("email already exists");
      throw err;
    }
    await this.replaceTeams(id, teamIds);
    return this.get(id);
  }

  async update(
    id: string,
    in_: UpdateInput,
    passwordHash: string | undefined,
    teamIds: string[] | null,
    replaceTeams: boolean,
  ): Promise<User | null> {
    const current = await this.get(id);
    if (!current) return null;
    const email = in_.email !== undefined ? in_.email.trim().toLowerCase() : current.email;
    const fullName = in_.fullName !== undefined ? in_.fullName.trim() : current.fullName;
    const phone = in_.phone !== undefined ? in_.phone.trim() : current.phone;
    const roleId = in_.roleId ?? current.roleId;
    let isActive = current.isActive;
    let deactivatedAt = current.deactivatedAt;
    if (in_.isActive !== undefined) {
      isActive = in_.isActive;
      deactivatedAt = in_.isActive ? null : new Date();
    }
    const password = passwordHash === undefined ? sql`` : sql`, password_hash = ${passwordHash}`;
    try {
      await sql`
        UPDATE users SET email = ${email}, full_name = ${fullName}, phone = ${phone}, role_id = ${roleId},
          is_active = ${isActive}, deactivated_at = ${deactivatedAt}${password}
        WHERE id = ${id}`.execute(this.db);
    } catch (err) {
      if (isEmailConflict(err)) throw AppError.conflict("email already exists");
      throw err;
    }
    if (replaceTeams) await this.replaceTeams(id, teamIds ?? []);
    return this.get(id);
  }

  async setActive(id: string, active: boolean): Promise<User | null> {
    await sql`UPDATE users SET is_active = ${active}, deactivated_at = ${active ? null : new Date()} WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async bulkSetActive(ids: string[], active: boolean): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await sql`
      UPDATE users SET is_active = ${active}, deactivated_at = ${active ? null : new Date()}
      WHERE id = ANY(${ids}::uuid[])`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n);
  }

  async listRoles(): Promise<RoleInfo[] | null> {
    const r = await sql<Omit<RoleInfo, "permissions">>`
      SELECT id::text AS "id", code, name, description FROM roles ORDER BY name`.execute(this.db);
    if (r.rows.length === 0) return null;
    const roles: RoleInfo[] = [];
    for (const row of r.rows) {
      const perms = await sql<{ code: string }>`
        SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ${row.id} ORDER BY p.code`.execute(this.db);
      roles.push({ ...row, permissions: perms.rows.map((p) => p.code) });
    }
    return roles;
  }

  async roleCode(roleId: string): Promise<string> {
    const r = await sql<{ code: string }>`SELECT code FROM roles WHERE id = ${roleId}`.execute(this.db);
    return r.rows[0]?.code ?? "";
  }

  async getTeam(teamId: string): Promise<TeamInfo | null> {
    const r = await sql<TeamInfo>`
      SELECT t.id::text AS "id", t.name, t.is_active AS "isActive", t.team_lead_user_id::text AS "teamLeadUserId",
             u.full_name AS "teamLeadName"
      FROM teams t LEFT JOIN users u ON u.id = t.team_lead_user_id
      WHERE t.id = ${teamId}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async setTeamLead(teamId: string, userId: string): Promise<void> {
    await sql`UPDATE teams SET team_lead_user_id = ${userId} WHERE id = ${teamId}`.execute(this.db);
    await sql`INSERT INTO team_members (team_id, user_id) VALUES (${teamId}, ${userId}) ON CONFLICT DO NOTHING`.execute(this.db);
  }

  async clearTeamLeadIf(teamId: string, userId: string): Promise<void> {
    await sql`UPDATE teams SET team_lead_user_id = NULL WHERE id = ${teamId} AND team_lead_user_id = ${userId}`.execute(this.db);
  }

  private async listTeamIds(userId: string): Promise<string[] | null> {
    const r = await sql<{ id: string }>`SELECT team_id::text AS "id" FROM team_members WHERE user_id = ${userId}`.execute(this.db);
    return r.rows.length > 0 ? r.rows.map((x) => x.id) : null;
  }

  private async replaceTeams(userId: string, teamIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`DELETE FROM team_members WHERE user_id = ${userId}`.execute(tx);
      for (const teamId of teamIds) {
        if (teamId === "") continue;
        try {
          await sql`INSERT INTO team_members (team_id, user_id) VALUES (${teamId}, ${userId}) ON CONFLICT DO NOTHING`.execute(tx);
        } catch (err) {
          const msg = membershipConflictMessage(err);
          if (msg) throw AppError.conflict(normalizeMembershipConflict(msg));
          throw err;
        }
      }
    });
  }
}

export class UsersService {
  readonly repo: UsersRepository;
  private readonly sessions: AuthRepository;

  constructor(
    db: Database,
    private readonly audit: AuditService,
  ) {
    this.repo = new UsersRepository(db);
    this.sessions = new AuthRepository(db);
  }

  async list(claims: Claims, f: UserListFilter): Promise<{ items: User[] | null; total: number }> {
    const access = UserAccess.for(claims, P.UsersView);
    return internal("failed to list users", () => this.repo.list(f, access));
  }

  async get(claims: Claims, id: string): Promise<User> {
    const access = UserAccess.for(claims, P.UsersView);
    const u = await this.load(id);
    if (!access.canSee(u)) throw AppError.notFound("user not found");
    return u;
  }

  private async load(id: string): Promise<User> {
    const u = await internal("failed to load user", () => this.repo.get(id));
    if (!u) throw AppError.notFound("user not found");
    return u;
  }

  async create(claims: Claims, in_: CreateInput, meta: RequestMeta): Promise<User | null> {
    const access = UserAccess.for(claims, P.UsersCreate);
    const actorId = claims.userId;
    validateCreate(in_);
    const roleCode = await internal("failed to validate role", () => this.repo.roleCode(in_.roleId));
    if (roleCode === "") throw AppError.validation("invalid role");

    const teamIds = access.resolveCreateTeams(roleCode, normalizeTeamIds(in_));
    await this.validateRoleTeamAssignment(roleCode, teamIds, "");

    const hash = await internal("failed to hash password", () => hashPassword(in_.password));
    const user = await internal("failed to create user", () => this.repo.create(in_, hash, uniqueNonEmpty(teamIds)));
    if (!user) throw AppError.internal("failed to create user");

    if (roleCode === Role.SalesManager && teamIds.length === 1) {
      const prev = await this.repo.getTeam(teamIds[0]!).catch(() => null);
      await internal("failed to assign team lead", () => this.repo.setTeamLead(teamIds[0]!, user.id));
      await this.audit.record(actorId, "TEAM_LEAD_ASSIGNED", "team", teamIds[0]!, {
        userId: user.id,
        previousTeamLeadUserId: prevTeamLeadId(prev),
      }, meta);
    }

    const action = roleCode === Role.SalesExecutive ? "SE_CREATED" : "user.created";
    await this.audit.record(actorId, action, "user", user.id, { email: user.email, role: user.roleCode, teamIds: user.teamIds }, meta);
    return user;
  }

  async update(claims: Claims, id: string, in_: UpdateInput, meta: RequestMeta): Promise<User> {
    const access = UserAccess.for(claims, P.UsersEdit, P.UsersAssign);
    const actorId = claims.userId;
    const current = await this.load(id);
    if (in_.isActive !== undefined && in_.isActive !== current.isActive) {
      let statusAccess: UserAccess;
      try {
        statusAccess = UserAccess.for(claims, P.UsersDelete);
      } catch {
        throw AppError.forbidden("You don't have permission to activate or deactivate users");
      }
      statusAccess.requireManage(current);
    }

    let hash: string | undefined;
    if (in_.password !== undefined && in_.password !== "") {
      if (Buffer.byteLength(in_.password) < 8) throw AppError.validation("password must be at least 8 characters");
      const password = in_.password;
      hash = await internal("failed to hash password", () => hashPassword(password));
    }

    let roleCode = current.roleCode;
    if (in_.roleId !== undefined) {
      const roleId = in_.roleId;
      const code = await internal("failed to validate role", () => this.repo.roleCode(roleId));
      if (code === "") throw AppError.validation("invalid role");
      roleCode = code;
    }

    let { ids: teamIds, provided: teamsProvided } = resolveUpdateTeamIds(in_, current.teamIds);
    access.authorizeUpdate(current, in_.roleId, teamIds, teamsProvided);
    if (roleCode === Role.SuperAdmin) {
      teamIds = null;
      teamsProvided = true;
    }
    if (teamsProvided || in_.roleId !== undefined) {
      await this.validateRoleTeamAssignment(roleCode, teamIds ?? [], id);
    }

    const teamChanged = teamsProvided && !teamsEqual(current.teamIds, teamIds);
    if (teamChanged && (roleCode === Role.SalesExecutive || roleCode === Role.SalesManager) && !in_.confirmTeamChange) {
      const [prevName, newName] = await this.teamNames(current.teamIds ?? [], teamIds ?? []);
      const who = roleCode === Role.SalesManager ? "Team Lead" : "Sales Executive";
      throw AppError.validation(`Confirm team change before moving this ${who}`, {
        field: "team_id",
        message: "Team change requires confirmation",
        requiresConfirm: true,
        previousTeamIds: current.teamIds,
        previousTeamName: prevName,
        newTeamIds: teamIds,
        newTeamName: newName,
      });
    }

    const user = await internal("failed to update user", () => this.repo.update(id, in_, hash, teamIds, teamsProvided));
    if (!user) throw AppError.notFound("user not found");

    const finalTeams = teamIds ?? [];
    if (teamChanged) {
      for (const tid of current.teamIds ?? []) await this.repo.clearTeamLeadIf(tid, id).catch(() => undefined);
      if (roleCode === Role.SalesManager && finalTeams.length === 1) {
        const prev = await this.repo.getTeam(finalTeams[0]!).catch(() => null);
        await this.repo.setTeamLead(finalTeams[0]!, id).catch(() => undefined);
        await this.audit.record(actorId, "TEAM_LEAD_CHANGED", "team", finalTeams[0]!, {
          userId: id,
          previousTeamLeadUserId: prevTeamLeadId(prev),
        }, meta);
      }
      await this.audit.record(actorId, "SE_TEAM_CHANGED", "user", id, {
        previousTeamIds: current.teamIds,
        newTeamIds: teamIds,
        role: roleCode,
      }, meta);
    } else if (roleCode === Role.SalesManager && teamsProvided && finalTeams.length === 1) {
      const prev = await this.repo.getTeam(finalTeams[0]!).catch(() => null);
      if (!prev || prev.teamLeadUserId !== id) {
        await this.repo.setTeamLead(finalTeams[0]!, id).catch(() => undefined);
        await this.audit.record(actorId, "TEAM_LEAD_ASSIGNED", "team", finalTeams[0]!, {
          userId: id,
          previousTeamLeadUserId: prevTeamLeadId(prev),
        }, meta);
      }
    }

    if (in_.isActive === false) await this.sessions.revokeAllUserSessions(id).catch(() => undefined);
    await this.audit.record(actorId, "user.updated", "user", id, {
      email: user.email,
      isActive: user.isActive,
      role: user.roleCode,
      teamIds: user.teamIds,
    }, meta);
    return user;
  }

  async setActive(claims: Claims, id: string, active: boolean, meta: RequestMeta): Promise<User> {
    const access = UserAccess.for(claims, P.UsersDelete);
    const current = await this.load(id);
    access.requireManage(current);
    const user = await internal("failed to update user status", () => this.repo.setActive(id, active));
    if (!user) throw AppError.notFound("user not found");
    if (!active) await this.sessions.revokeAllUserSessions(id).catch(() => undefined);
    await this.audit.record(claims.userId, active ? "user.activated" : "user.deactivated", "user", id, null, meta);
    return user;
  }

  async bulkSetActive(claims: Claims, ids: string[], active: boolean, meta: RequestMeta): Promise<number> {
    const access = UserAccess.for(claims, P.UsersDelete);
    if (!access.organization) {
      for (const id of ids) access.requireManage(await this.load(id));
    }
    const n = await internal("failed to update users", () => this.repo.bulkSetActive(ids, active));
    if (!active) {
      for (const id of ids) await this.sessions.revokeAllUserSessions(id).catch(() => undefined);
    }
    const action = active ? "users.bulk_activated" : "users.bulk_deactivated";
    await this.audit.record(claims.userId, action, "user", null, { ids, count: n }, meta);
    return n;
  }

  /** Permissions are expanded (:manage implies the other actions) and sorted; Go's order is random. */
  async listRoles(): Promise<RoleInfo[] | null> {
    const roles = await internal("failed to list roles", () => this.repo.listRoles());
    return roles?.map((r) => ({ ...r, permissions: expandImplies(r.permissions).list().sort() })) ?? null;
  }

  private async validateRoleTeamAssignment(roleCode: string, teamIds: string[], excludeUserId: string): Promise<void> {
    if (roleCode === Role.SuperAdmin) {
      if (teamIds.length > 0) throw AppError.validation("Super Admin is not assigned to a team");
      return;
    }
    if (roleCode !== Role.SalesExecutive && roleCode !== Role.SalesManager) return;
    const lead = roleCode === Role.SalesManager;
    if (teamIds.length === 0) {
      throw AppError.fieldValidation("team_id", lead ? "Team is required for Team Leads" : "Team is required for Sales Executives");
    }
    if (teamIds.length > 1) {
      throw AppError.fieldValidation(
        "team_id",
        lead ? "A Team Lead belongs to exactly one team" : "A Sales Executive belongs to exactly one team",
      );
    }
    const team = await internal("failed to validate team", () => this.repo.getTeam(teamIds[0]!));
    if (!team) throw AppError.fieldValidation("team_id", "Selected team does not exist");
    if (!team.isActive) throw AppError.fieldValidation("team_id", "Selected team is inactive");
    if (!lead && !team.teamLeadUserId) {
      throw AppError.fieldValidation("team_id", "Selected team does not have a Team Lead configured");
    }
    if (lead && team.teamLeadUserId && team.teamLeadUserId !== excludeUserId) {
      throw AppError.fieldValidation("team_id", "Team already has a Team Lead assigned");
    }
  }

  private async teamNames(prev: string[], next: string[]): Promise<[string, string]> {
    const name = async (ids: string[]) => (ids.length > 0 ? ((await this.repo.getTeam(ids[0]!).catch(() => null))?.name ?? "") : "");
    return [await name(prev), await name(next)];
  }
}

function validateCreate(in_: CreateInput): void {
  if (in_.email.trim() === "") throw AppError.validation("email is required");
  if (in_.fullName.trim() === "") throw AppError.validation("full name is required");
  if (Buffer.byteLength(in_.password) < 8) throw AppError.validation("password must be at least 8 characters");
  if (in_.roleId.trim() === "") throw AppError.validation("role is required");
}
