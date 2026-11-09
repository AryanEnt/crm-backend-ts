import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import {
  assertCanAccessTemplateTeam,
  canAccessTemplateTeam,
  canSeeAllTemplates,
  resolveTemplateTeamId,
} from "../src/modules/email/template-access.js";
import { claims } from "./helpers/claims.js";

const teamA = "11111111-1111-1111-1111-111111111111";
const teamB = "22222222-2222-2222-2222-222222222222";

const tl = () =>
  claims({
    userId: "tl-1",
    roleCode: "sales_manager",
    teamIds: [teamA],
    permissions: ["email:manage", "email:view", "email:send"],
    permissionScopes: { "email:manage": "team", "email:view": "team", "email:send": "team" },
  });

const se = () =>
  claims({
    userId: "se-1",
    roleCode: "sales_executive",
    teamIds: [teamA],
    permissions: ["email:view", "email:send"],
    permissionScopes: { "email:view": "own", "email:send": "own" },
  });

const admin = () =>
  claims({
    userId: "admin-1",
    roleCode: "super_admin",
    teamIds: [],
    permissions: ["email:manage", "email:view"],
    permissionScopes: { "email:manage": "organization", "email:view": "organization" },
  });

describe("email template team access", () => {
  it("lets a Team Lead create templates only for their team", () => {
    expect(resolveTemplateTeamId(tl(), undefined)).toBe(teamA);
    expect(resolveTemplateTeamId(tl(), teamA)).toBe(teamA);
    expect(() => resolveTemplateTeamId(tl(), teamB)).toThrow(AppError);
    expect(() => resolveTemplateTeamId(tl(), teamB)).toThrow(/stay on your team/);
  });

  it("requires a team for Team Leads with no membership", () => {
    const lone = tl();
    lone.teamIds = [];
    expect(() => resolveTemplateTeamId(lone, undefined)).toThrow(/belong to a team/);
  });

  it("requires teamId from org admins", () => {
    expect(() => resolveTemplateTeamId(admin(), undefined)).toThrow(/teamId is required/);
    expect(resolveTemplateTeamId(admin(), teamB)).toBe(teamB);
  });

  it("hides another team's templates from SE and TL", () => {
    expect(canAccessTemplateTeam(tl(), teamA)).toBe(true);
    expect(canAccessTemplateTeam(se(), teamA)).toBe(true);
    expect(canAccessTemplateTeam(tl(), teamB)).toBe(false);
    expect(canAccessTemplateTeam(se(), teamB)).toBe(false);
    expect(canAccessTemplateTeam(tl(), null)).toBe(false);
    expect(canSeeAllTemplates(admin())).toBe(true);
    expect(canAccessTemplateTeam(admin(), teamB)).toBe(true);
    expect(() => assertCanAccessTemplateTeam(tl(), teamB)).toThrow(/another team/);
  });
});
