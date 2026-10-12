import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { bool, optionalBool, optionalString, str, stringArray } from "../../lib/validate.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import { widestScope } from "../datascope/datascope.js";
import { P, Role, type MaybeScope } from "../permissions/permissions.js";
import { normalizeMembershipConflict } from "../users/users.service.js";

export interface TeamMember {
  id: string;
  fullName: string;
  email: string;
  roleCode: string;
  roleName: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  teamLeadUserId: string | null;
  teamLeadName: string | null;
  isActive: boolean;
  memberIds: string[];
  members: TeamMember[];
  memberCount: number;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const createSchema = z.strictObject({
  name: str(),
  description: str(),
  teamLeadUserId: optionalString(),
  ownerUserId: optionalString(),
  memberIds: stringArray(),
});
export type CreateInput = z.output<typeof createSchema>;

export const updateSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  teamLeadUserId: optionalString(),
  ownerUserId: optionalString(),
  memberIds: stringArray(),
  isActive: optionalBool(),
});
export type UpdateInput = z.output<typeof updateSchema>;

export const statusSchema = z.strictObject({ isActive: bool() });

export interface TeamListFilter {
  search: string;
  isActive: boolean | undefined;
  limit: number;
  offset: number;
}

/** The caller's reach over teams. The zero value sees nothing. */
export class TeamAccess {
  constructor(
    readonly scope: MaybeScope = "",
    readonly teamIds: readonly string[] = [],
  ) {}

  static for(claims: Claims, ...codes: string[]): TeamAccess {
    return new TeamAccess(widestScope(claims, ...codes), claims.teamIds);
  }

  get organization(): boolean {
    return this.scope === "organization";
  }

  /** Organization sees every team; team and own scope see only the caller's teams. */
  canSee(teamId: string): boolean {
    if (this.scope === "organization") return true;
    if (this.scope === "team" || this.scope === "own") return this.teamIds.includes(teamId);
    return false;
  }

  /** Own-scope callers may know their team but not its people. */
  redact(t: Team): Team {
    if (this.scope === "team" || this.organization) return t;
    return { ...t, memberIds: [], members: [] };
  }

  /** Team setup (create, rename, membership, Team Lead, status) stays with Super Admin. */
  requireOrganization(): void {
    if (!this.organization) throw AppError.forbidden("Only Super Admin can change team setup");
  }
}

type TeamRow = Omit<Team, "memberIds" | "members">;

const TEAM_SELECT = sql`
  SELECT t.id::text AS "id", t.name, t.description, t.team_lead_user_id::text AS "teamLeadUserId",
         u.full_name AS "teamLeadName", t.is_active AS "isActive", t.deactivated_at AS "deactivatedAt",
         t.created_at AS "createdAt", t.updated_at AS "updatedAt",
         (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id)::int AS "memberCount"
  FROM teams t
  LEFT JOIN users u ON u.id = t.team_lead_user_id`;

const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  description: r.description,
  teamLeadUserId: r.teamLeadUserId,
  teamLeadName: r.teamLeadName,
  isActive: r.isActive,
  memberIds: [],
  members: [],
  memberCount: r.memberCount,
  deactivatedAt: r.deactivatedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const isNameConflict = (err: unknown) => err instanceof Error && err.message.includes("teams_name_unique");

function membershipConflict(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("already assigned to") || msg.includes("Super Admin cannot") ? msg : "";
}

const appendUnique = (ids: string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);

function rejectOwnerField(owner: string | undefined): void {
  if (owner !== undefined && owner.trim() !== "") {
    throw AppError.validation("teams do not have an owner; assign a Team Lead");
  }
}

export class TeamsRepository {
  constructor(readonly db: Database) {}

  async list(f: TeamListFilter, access: TeamAccess): Promise<{ items: Team[] | null; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 25 : f.limit;
    const where: RawBuilder<unknown>[] = [
      sql`(${f.search} = '' OR t.name ILIKE '%' || ${f.search} || '%' OR t.description ILIKE '%' || ${f.search} || '%')`,
    ];
    if (f.isActive !== undefined) where.push(sql`t.is_active = ${f.isActive}`);
    if (!access.organization) {
      const teamIds = access.scope === "team" || access.scope === "own" ? [...access.teamIds] : [];
      where.push(sql`t.id = ANY(${teamIds}::uuid[])`);
    }
    const whereSql = sql.join(where, sql` AND `);
    const count = await sql<{ total: number }>`SELECT COUNT(*)::int AS total FROM teams t WHERE ${whereSql}`.execute(this.db);
    const rows = await sql<TeamRow>`
      ${TEAM_SELECT}
      WHERE ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    const teams = rows.rows.map(toTeam);
    await this.attachMembers(teams);
    return { items: teams.length > 0 ? teams : null, total: count.rows[0]?.total ?? 0 };
  }

  async get(id: string): Promise<Team | null> {
    const r = await sql<TeamRow>`${TEAM_SELECT} WHERE t.id = ${id}`.execute(this.db);
    if (!r.rows[0]) return null;
    const team = toTeam(r.rows[0]);
    await this.attachMembers([team]);
    return team;
  }

  async create(in_: CreateInput): Promise<Team | null> {
    const id = randomUUID();
    const lead = in_.teamLeadUserId ?? null;
    try {
      await sql`
        INSERT INTO teams (id, name, description, team_lead_user_id)
        VALUES (${id}, ${in_.name.trim()}, ${in_.description.trim()}, ${lead})`.execute(this.db);
    } catch (err) {
      if (isNameConflict(err)) throw AppError.conflict("team name already exists");
      throw err;
    }
    let members = in_.memberIds ?? [];
    if (lead !== null && lead.trim() !== "") members = appendUnique(members, lead.trim());
    await this.replaceMembers(id, members);
    return this.get(id);
  }

  async update(id: string, in_: UpdateInput): Promise<Team | null> {
    const current = await this.get(id);
    if (!current) return null;
    const name = in_.name !== undefined ? in_.name.trim() : current.name;
    const description = in_.description !== undefined ? in_.description.trim() : current.description;
    let lead = current.teamLeadUserId;
    if (in_.teamLeadUserId !== undefined) lead = in_.teamLeadUserId.trim() === "" ? null : in_.teamLeadUserId.trim();
    let isActive = current.isActive;
    let deactivatedAt = current.deactivatedAt;
    if (in_.isActive !== undefined) {
      isActive = in_.isActive;
      deactivatedAt = in_.isActive ? null : new Date();
    }
    try {
      await sql`
        UPDATE teams SET name = ${name}, description = ${description}, team_lead_user_id = ${lead},
          is_active = ${isActive}, deactivated_at = ${deactivatedAt}
        WHERE id = ${id}`.execute(this.db);
    } catch (err) {
      if (isNameConflict(err)) throw AppError.conflict("team name already exists");
      throw err;
    }
    if (in_.memberIds !== undefined) {
      const members = lead !== null ? appendUnique(in_.memberIds, lead) : in_.memberIds;
      await this.replaceMembers(id, members);
    }
    return this.get(id);
  }

  async setActive(id: string, active: boolean): Promise<Team | null> {
    await sql`UPDATE teams SET is_active = ${active}, deactivated_at = ${active ? null : new Date()} WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  /** Role codes by user id, for the users that exist. */
  async userRoles(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const r = await sql<{ id: string; code: string }>`
      SELECT u.id::text AS "id", r.code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ANY(${ids}::uuid[])`.execute(this.db);
    for (const row of r.rows) out.set(row.id, row.code);
    return out;
  }

  private async attachMembers(teams: Team[]): Promise<void> {
    if (teams.length === 0) return;
    const index = new Map(teams.map((t) => [t.id, t]));
    const r = await sql<TeamMember & { teamId: string }>`
      SELECT tm.team_id::text AS "teamId", u.id::text AS "id", u.full_name AS "fullName", u.email,
             r.code AS "roleCode", r.name AS "roleName"
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      JOIN roles r ON r.id = u.role_id
      WHERE tm.team_id = ANY(${teams.map((t) => t.id)}::uuid[])
        AND r.code <> 'super_admin'
      ORDER BY u.full_name`.execute(this.db);
    for (const { teamId, ...member } of r.rows) {
      const team = index.get(teamId);
      if (!team) continue;
      team.members.push({ id: member.id, fullName: member.fullName, email: member.email, roleCode: member.roleCode, roleName: member.roleName });
      team.memberIds.push(member.id);
    }
  }

  private async replaceMembers(teamId: string, memberIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`DELETE FROM team_members WHERE team_id = ${teamId}`.execute(tx);
      for (const uid of memberIds) {
        if (uid === "") continue;
        try {
          await sql`INSERT INTO team_members (team_id, user_id) VALUES (${teamId}, ${uid}) ON CONFLICT DO NOTHING`.execute(tx);
        } catch (err) {
          const msg = membershipConflict(err);
          if (msg) throw AppError.conflict(normalizeMembershipConflict(msg));
          throw err;
        }
      }
    });
  }
}

export class TeamsService {
  readonly repo: TeamsRepository;

  constructor(
    db: Database,
    private readonly audit: AuditService,
  ) {
    this.repo = new TeamsRepository(db);
  }

  async list(claims: Claims, f: TeamListFilter): Promise<{ items: Team[] | null; total: number }> {
    const access = TeamAccess.for(claims, P.TeamsView);
    const { items, total } = await internal("failed to list teams", () => this.repo.list(f, access));
    return { items: items?.map((t) => access.redact(t)) ?? null, total };
  }

  async get(claims: Claims, id: string): Promise<Team> {
    const access = TeamAccess.for(claims, P.TeamsView);
    if (!access.canSee(id)) throw AppError.notFound("team not found");
    const t = await internal("failed to load team", () => this.repo.get(id));
    if (!t) throw AppError.notFound("team not found");
    return access.redact(t);
  }

  async create(claims: Claims, in_: CreateInput, meta: RequestMeta): Promise<Team> {
    const access = TeamAccess.for(claims, P.TeamsCreate);
    access.requireOrganization();
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    rejectOwnerField(in_.ownerUserId);
    const { lead, members } = await this.normalizeMembership(in_.teamLeadUserId, in_.memberIds ?? []);
    await this.ensureSingleTeam(lead, "");
    await this.rejectCrossTeamAssignments(lead !== undefined && lead.trim() !== "" ? appendUnique(members, lead.trim()) : members, "");
    const team = await internal("failed to create team", () => this.repo.create({ ...in_, teamLeadUserId: lead, memberIds: members }));
    if (!team) throw AppError.internal("failed to create team");
    await this.audit.record(claims.userId, "team.created", "team", team.id, { name: team.name }, meta);
    return team;
  }

  async update(claims: Claims, id: string, in_: UpdateInput, meta: RequestMeta): Promise<Team> {
    const access = TeamAccess.for(claims, P.TeamsEdit, P.TeamsAssign);
    if (!access.canSee(id)) throw AppError.notFound("team not found");
    access.requireOrganization();
    const before = await internal("failed to load team", () => this.repo.get(id));
    if (!before) throw AppError.notFound("team not found");
    rejectOwnerField(in_.ownerUserId);

    const input = { ...in_ };
    if (in_.teamLeadUserId !== undefined || in_.memberIds !== undefined) {
      const lead = in_.teamLeadUserId ?? before.teamLeadUserId ?? undefined;
      const normalized = await this.normalizeMembership(lead, in_.memberIds ?? before.memberIds);
      input.teamLeadUserId = normalized.lead ?? "";
      input.memberIds = normalized.members;
      await this.ensureSingleTeam(normalized.lead, id);
      const checkIds =
        normalized.lead !== undefined && normalized.lead.trim() !== ""
          ? appendUnique(normalized.members, normalized.lead.trim())
          : normalized.members;
      await this.rejectCrossTeamAssignments(checkIds, id);
    }

    const team = await internal("failed to update team", () => this.repo.update(id, input));
    if (!team) throw AppError.notFound("team not found");
    await this.audit.record(claims.userId, "team.updated", "team", id, { name: team.name, isActive: team.isActive }, meta);
    if (input.teamLeadUserId !== undefined) {
      const prev = before.teamLeadUserId ?? "";
      const next = team.teamLeadUserId ?? "";
      if (prev !== next) {
        const action = prev !== "" && next !== "" ? "TEAM_LEAD_CHANGED" : "TEAM_LEAD_ASSIGNED";
        await this.audit.record(claims.userId, action, "team", id, { previousTeamLeadUserId: prev, teamLeadUserId: next }, meta);
      }
    }
    return team;
  }

  async setActive(claims: Claims, id: string, active: boolean, meta: RequestMeta): Promise<Team> {
    const access = TeamAccess.for(claims, P.TeamsDelete);
    if (!access.canSee(id)) throw AppError.notFound("team not found");
    access.requireOrganization();
    const team = await internal("failed to update team status", () => this.repo.setActive(id, active));
    if (!team) throw AppError.notFound("team not found");
    await this.audit.record(claims.userId, active ? "team.activated" : "team.deactivated", "team", id, null, meta);
    return team;
  }

  /** Trims and de-duplicates members, adds the lead, and checks every role. */
  private async normalizeMembership(
    lead: string | undefined,
    memberIds: readonly string[],
  ): Promise<{ lead: string | undefined; members: string[] }> {
    const leadId = lead?.trim() ?? "";
    const members: string[] = [];
    for (const raw of memberIds) {
      const id = raw.trim();
      if (id !== "" && !members.includes(id)) members.push(id);
    }
    if (leadId !== "" && !members.includes(leadId)) members.push(leadId);

    const roles = await internal("failed to check team members", () => this.repo.userRoles(members));
    for (const id of members) {
      const code = roles.get(id);
      if (code === undefined) throw AppError.validation("one or more users do not exist");
      if (code === Role.SuperAdmin) throw AppError.validation("Super Admin cannot be a team member or Team Lead");
    }
    if (leadId !== "" && roles.get(leadId) !== Role.SalesManager) {
      throw AppError.validation("Team Lead must be a user with the Team Lead role");
    }
    for (const id of members) {
      if (roles.get(id) === Role.SalesManager && id !== leadId) {
        throw AppError.validation("assign the Team Lead in Team Lead, not as a member");
      }
    }
    return { lead: leadId === "" ? undefined : leadId, members };
  }

  private async ensureSingleTeam(lead: string | undefined, exceptTeamId: string): Promise<void> {
    if (lead === undefined || lead.trim() === "") return;
    const r = await internal("failed to check Team Lead assignment", () =>
      sql<{ id: string }>`
        SELECT id::text AS "id" FROM teams WHERE team_lead_user_id = ${lead.trim()} AND id::text <> ${exceptTeamId}
        LIMIT 1`.execute(this.repo.db),
    );
    if (r.rows.length > 0) throw AppError.conflict("Team Lead is already assigned to another team.");
  }

  private async rejectCrossTeamAssignments(userIds: string[], exceptTeamId: string): Promise<void> {
    if (userIds.length === 0) return;
    const r = await internal("failed to check team membership", () =>
      sql<{ roleCode: string }>`
        SELECT r.code AS "roleCode"
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
        JOIN roles r ON r.id = u.role_id
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.user_id = ANY(${userIds}::uuid[])
          AND tm.team_id::text <> ${exceptTeamId}
          AND r.code IN ('sales_executive', 'sales_manager')
        ORDER BY u.full_name`.execute(this.repo.db),
    );
    const unique: string[] = [];
    for (const row of r.rows) {
      const who = row.roleCode === Role.SalesManager ? "Team Lead" : "Sales Executive";
      const msg = `${who} is already assigned to another team.`;
      if (!unique.includes(msg)) unique.push(msg);
    }
    if (unique.length > 0) throw AppError.conflict(unique.join(" "));
  }
}
