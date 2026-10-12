import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import type { Claims } from "../src/modules/auth/types.js";
import { P, Role, type Scope } from "../src/modules/permissions/permissions.js";
import { TeamAccess, type Team } from "../src/modules/teams/teams.service.js";
import { UserAccess, type PolicyUser } from "../src/modules/users/users.policy.js";
import { bearer, config, queueAuth, userRow } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const teamA = "team-a";
const teamB = "team-b";

function claimsFor(role: string, userId: string, teamIds: string[], grants: Record<string, Scope>): Claims {
  return {
    userId,
    email: "",
    fullName: "",
    roleCode: role,
    roleId: "",
    teamIds,
    teamMemberUserIds: [],
    permissions: Object.keys(grants),
    permissionScopes: grants,
    expiresAt: new Date(),
  };
}

// Grants as seeded by migrations 000015 and 000026.
const teamLead = (teamIds = [teamA]) =>
  claimsFor(Role.SalesManager, "tl-a", teamIds, {
    [P.UsersView]: "team",
    [P.UsersCreate]: "team",
    [P.UsersEdit]: "team",
    [P.UsersDelete]: "team",
  });
const salesExecutive = () => claimsFor(Role.SalesExecutive, "se-a1", [teamA], { [P.LeadsView]: "own", [P.TeamsView]: "own" });
const salesSupport = () => claimsFor(Role.SalesSupport, "support-1", [], { [P.LeadsView]: "own", [P.TeamsView]: "own" });
const superAdmin = () =>
  claimsFor(Role.SuperAdmin, "admin", [], {
    [P.UsersManage]: "organization",
    [P.UsersView]: "organization",
    [P.UsersCreate]: "organization",
    [P.UsersEdit]: "organization",
    [P.UsersDelete]: "organization",
  });

const seOnA: PolicyUser = { id: "se-a1", roleCode: Role.SalesExecutive, teamIds: [teamA], roleId: "role-se" };
const seOnB: PolicyUser = { id: "se-b1", roleCode: Role.SalesExecutive, teamIds: [teamB], roleId: "role-se" };
const leadOnA: PolicyUser = { id: "tl-a", roleCode: Role.SalesManager, teamIds: [teamA], roleId: "role-tl" };
const leadOnB: PolicyUser = { id: "tl-b", roleCode: Role.SalesManager, teamIds: [teamB], roleId: "role-tl" };
const unteamed: PolicyUser = { id: "se-x", roleCode: Role.SalesExecutive, teamIds: null, roleId: "role-se" };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : "not-app-error";
  }
  return "ok";
}

describe("user access policy", () => {
  it("team lead sees only their own team", () => {
    const a = UserAccess.for(teamLead(), P.UsersView);
    expect(a.scope).toBe("team");
    for (const u of [seOnA, leadOnA]) expect(a.canSee(u)).toBe(true);
    for (const u of [seOnB, leadOnB, unteamed]) expect(a.canSee(u)).toBe(false);
  });

  it("team lead manages only their own Sales Executives", () => {
    const a = UserAccess.for(teamLead(), P.UsersEdit);
    expect(codeOf(() => a.requireManage(seOnA))).toBe("ok");
    expect(codeOf(() => a.requireManage(seOnB))).toBe("not_found");
    expect(codeOf(() => a.requireManage(unteamed))).toBe("not_found");
    expect(codeOf(() => a.requireManage(leadOnA))).toBe("forbidden");
  });

  it("team lead create defaults to their own team and refuses others", () => {
    const a = UserAccess.for(teamLead(), P.UsersCreate);
    expect(a.resolveCreateTeams(Role.SalesExecutive, [])).toEqual([teamA]);
    expect(a.resolveCreateTeams(Role.SalesExecutive, [teamA])).toEqual([teamA]);
    expect(codeOf(() => a.resolveCreateTeams(Role.SalesExecutive, [teamB]))).toBe("forbidden");
    expect(codeOf(() => a.resolveCreateTeams(Role.SalesExecutive, [teamA, teamB]))).toBe("forbidden");
    for (const role of [Role.SalesManager, Role.SuperAdmin, Role.SalesSupport]) {
      expect(codeOf(() => a.resolveCreateTeams(role, [teamA]))).toBe("forbidden");
    }
    const unassigned = UserAccess.for(teamLead([]), P.UsersCreate);
    expect(codeOf(() => unassigned.resolveCreateTeams(Role.SalesExecutive, []))).toBe("forbidden");
  });

  it("team lead updates keep role and team", () => {
    const a = UserAccess.for(teamLead(), P.UsersEdit, P.UsersAssign);
    expect(codeOf(() => a.authorizeUpdate(seOnA, undefined, seOnA.teamIds, false))).toBe("ok");
    expect(codeOf(() => a.authorizeUpdate(seOnA, seOnA.roleId, seOnA.teamIds, false))).toBe("ok");
    expect(codeOf(() => a.authorizeUpdate(seOnA, "role-admin", seOnA.teamIds, false))).toBe("forbidden");
    expect(codeOf(() => a.authorizeUpdate(seOnA, undefined, [teamB], true))).toBe("forbidden");
    expect(codeOf(() => a.authorizeUpdate(seOnB, undefined, seOnB.teamIds, false))).toBe("not_found");
  });

  it("sales executives and support have no user access; zero access sees nothing", () => {
    for (const claims of [salesExecutive(), salesSupport()]) {
      for (const code of [P.UsersView, P.UsersCreate, P.UsersEdit, P.UsersDelete]) {
        expect(codeOf(() => UserAccess.for(claims, code))).toBe("forbidden");
      }
    }
    const zero = new UserAccess();
    expect(zero.canSee(seOnA) || zero.canManage(seOnA)).toBe(false);
  });

  it("super admin is organization-wide", () => {
    expect(UserAccess.for(superAdmin(), P.UsersCreate).resolveCreateTeams(Role.SalesExecutive, [teamB])).toEqual([teamB]);
    const edit = UserAccess.for(superAdmin(), P.UsersEdit, P.UsersAssign);
    expect(codeOf(() => edit.authorizeUpdate(seOnB, "role-tl", [teamA], true))).toBe("ok");
    for (const u of [seOnA, seOnB, leadOnB, unteamed]) expect(edit.canSee(u) && edit.canManage(u)).toBe(true);
  });
});

describe("team access policy", () => {
  const sampleTeam = (): Team => ({
    id: teamA,
    name: "",
    description: "",
    teamLeadUserId: null,
    teamLeadName: null,
    isActive: true,
    memberIds: ["tl-a", "se-a1"],
    members: [
      { id: "tl-a", fullName: "", email: "", roleCode: "", roleName: "" },
      { id: "se-a1", fullName: "", email: "", roleCode: "", roleName: "" },
    ],
    memberCount: 2,
    deactivatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("team lead sees only their own team, with members", () => {
    const a = TeamAccess.for(claimsFor(Role.SalesManager, "tl", [teamA], { [P.TeamsView]: "team" }), P.TeamsView);
    expect(a.canSee(teamA) && !a.canSee(teamB)).toBe(true);
    expect(a.redact(sampleTeam()).members).toHaveLength(2);
  });

  it("own scope sees their own team without members", () => {
    for (const role of [Role.SalesExecutive, Role.SalesSupport]) {
      const a = TeamAccess.for(claimsFor(role, "u", [teamA], { [P.TeamsView]: "own" }), P.TeamsView);
      expect(a.canSee(teamA) && !a.canSee(teamB)).toBe(true);
      const t = a.redact(sampleTeam());
      expect([t.members.length, t.memberIds.length]).toEqual([0, 0]);
    }
  });

  it("team setup is Super Admin only; zero access sees nothing", () => {
    const lead = TeamAccess.for(
      claimsFor(Role.SalesManager, "tl", [teamA], { [P.TeamsEdit]: "team", [P.TeamsAssign]: "team" }),
      P.TeamsEdit,
      P.TeamsAssign,
    );
    expect(codeOf(() => lead.requireOrganization())).toBe("forbidden");
    const admin = TeamAccess.for(
      claimsFor(Role.SuperAdmin, "admin", [], { [P.TeamsManage]: "organization", [P.TeamsEdit]: "organization" }),
      P.TeamsEdit,
      P.TeamsAssign,
    );
    expect(codeOf(() => admin.requireOrganization())).toBe("ok");
    expect(admin.canSee(teamB)).toBe(true);
    expect(new TeamAccess().canSee(teamA)).toBe(false);
  });
});

describe("users and teams routes", () => {
  it("lists roles with :manage expanded and permissions sorted", async () => {
    const f = fakeDb();
    queueAuth(f, P.RolesView);
    f.queue([{ id: "r1", code: "super_admin", name: "Super Admin", description: "" }], [{ code: "users:manage" }, { code: "leads:view" }]);
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/v1/roles").set("Authorization", bearer());
    expect(res.status).toBe(200);
    const perms = ["leads:view", "users:manage", ...["view", "create", "edit", "delete", "assign", "export", "configure"].map((a) => `users:${a}`)];
    expect(res.body.data).toEqual([{ id: "r1", code: "super_admin", name: "Super Admin", description: "", permissions: [...new Set(perms)].sort() }]);
  });

  it("echoes the requested limit in list meta while clamping the query, and returns null for no rows", async () => {
    const f = fakeDb();
    queueAuth(f, P.UsersView);
    f.queue([{ total: 0 }], []);
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/v1/users?limit=500").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.meta).toEqual({ limit: 500, offset: 0, total: 0 });
    expect(f.queries.at(-1)?.parameters.slice(-2)).toEqual([25, 0]);
  });

  it("validates bulk status ids and user creation input", async () => {
    const f = fakeDb();
    const app = createApp({ config: config(), db: f.db });
    queueAuth(f, P.UsersDelete);
    const bulk = await request(app).post("/api/v1/users/bulk-status").set("Authorization", bearer()).send({ ids: [], isActive: false });
    expect([bulk.status, bulk.body.error.message]).toEqual([400, "ids are required"]);

    queueAuth(f, P.UsersCreate);
    const create = await request(app).post("/api/v1/users").set("Authorization", bearer()).send({ email: " ", password: "x" });
    expect([create.status, create.body.error.message]).toEqual([400, "email is required"]);
  });

  it("refuses team setup to team-scoped callers", async () => {
    const f = fakeDb();
    f.queue([userRow({ roleCode: Role.SalesManager })], [{ code: P.TeamsCreate, scope: "team" }], [{ teamId: teamA }], []);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/teams")
      .set("Authorization", bearer())
      .send({ name: "New team" });
    expect([res.status, res.body.error.message]).toEqual([403, "Only Super Admin can change team setup"]);
  });
});
