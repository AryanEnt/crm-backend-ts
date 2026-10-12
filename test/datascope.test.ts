import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import {
  appendScope,
  resolve,
  resolveReport,
  widestScope,
} from "../src/modules/datascope/datascope.js";
import { P, Role } from "../src/modules/permissions/permissions.js";
import { claims } from "./helpers/claims.js";

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("resolve", () => {
  it("own scope rejects filtering by another SE", () => {
    const c = claims({
      userId: "se-1",
      roleCode: Role.SalesExecutive,
      permissionScopes: { [P.LeadsView]: "own" },
      permissions: [P.LeadsView],
    });
    expectCode(() => resolve(c, P.LeadsView, "se-2"), "forbidden");
  });

  it("team scope rejects an SE outside the team", () => {
    const c = claims({
      userId: "tl-1",
      roleCode: Role.SalesManager,
      teamIds: ["team-a"],
      teamMemberUserIds: ["tl-1", "se-ryan", "se-ansu"],
      permissionScopes: { [P.LeadsView]: "team" },
      permissions: [P.LeadsView],
    });
    expectCode(() => resolve(c, P.LeadsView, "se-beta"), "forbidden");
  });

  it("team scope allows the team's own SE", () => {
    const c = claims({
      userId: "tl-1",
      roleCode: Role.SalesManager,
      teamIds: ["team-a"],
      teamMemberUserIds: ["tl-1", "se-ryan"],
      permissionScopes: { [P.LeadsView]: "team" },
      permissions: [P.LeadsView],
    });
    const v = resolve(c, P.LeadsView, "se-ryan");
    expect(v.ownerIds).toEqual(["se-ryan"]);
    expect(v.teamIds).toEqual(["team-a"]);
  });

  it("organization scope is unscoped", () => {
    const c = claims({
      userId: "admin",
      roleCode: Role.SuperAdmin,
      permissionScopes: { [P.LeadsView]: "organization" },
      permissions: [P.LeadsView],
    });
    expect(resolve(c, P.LeadsView, "").unscoped).toBe(true);
  });

  it("falls back to role defaults when the grant has no scope", () => {
    const se = claims({ userId: "se-1", roleCode: Role.SalesExecutive, permissions: [P.LeadsView] });
    expect(resolve(se, P.LeadsView).ownerIds).toEqual(["se-1"]);
    expectCode(() => resolve(se, P.DealsView), "forbidden");
  });
});

describe("widestScope", () => {
  it("picks the broadest held grant and fails when none is held", () => {
    const c = claims({
      userId: "tl-1",
      roleCode: Role.SalesManager,
      permissionScopes: { [P.UsersEdit]: "team" },
      permissions: [P.UsersEdit],
    });
    expect(widestScope(c, P.UsersEdit, P.UsersAssign)).toBe("team");
    expectCode(() => widestScope(c, P.UsersDelete), "forbidden");
  });
});

describe("resolveReport", () => {
  it("own scope pins the caller", () => {
    const c = claims({
      userId: "se-1",
      roleCode: Role.SalesExecutive,
      permissionScopes: { [P.AnalyticsView]: "own" },
      permissions: [P.AnalyticsView],
    });
    const rs = resolveReport(c, P.AnalyticsView);
    expect(rs.ownerUserId).toBe("se-1");
    expect(rs.userIds).toEqual(["se-1"]);
    expect(rs.teamIds).toEqual([]);
    expectCode(() => resolveReport(c, P.AnalyticsView, "", "se-2"), "forbidden");
  });

  it("team scope pins the caller's own team", () => {
    const c = claims({
      userId: "tl-1",
      roleCode: Role.SalesManager,
      teamIds: ["team-a"],
      teamMemberUserIds: ["se-ryan"],
      permissionScopes: { [P.AnalyticsView]: "team" },
      permissions: [P.AnalyticsView],
    });
    const rs = resolveReport(c, P.AnalyticsView, "", "se-ryan");
    expect(rs.teamId).toBe("team-a");
    expect(rs.ownerUserId).toBe("se-ryan");
    expectCode(() => resolveReport(c, P.AnalyticsView, "team-b", ""), "forbidden");
    expectCode(() => resolveReport(c, P.AnalyticsView, "", "se-beta"), "forbidden");
  });

  it("team scope without teams matches nothing", () => {
    const c = claims({
      userId: "tl-1",
      roleCode: Role.SalesManager,
      permissionScopes: { [P.ForecastsView]: "team" },
      permissions: [P.ForecastsView],
    });
    const rs = resolveReport(c, P.ForecastsView);
    expect(rs.ownerUserId).not.toBe("");
    expect(rs.userIds).toEqual([]);
    expect(rs.teamIds).toEqual([]);
  });

  it("organization scope passes filters through", () => {
    const c = claims({
      userId: "admin",
      roleCode: Role.SuperAdmin,
      permissionScopes: { [P.AnalyticsView]: "organization" },
      permissions: [P.AnalyticsView],
    });
    const rs = resolveReport(c, P.AnalyticsView, "team-x", "u-9");
    expect(rs).toMatchObject({ teamId: "team-x", ownerUserId: "u-9", userIds: null, teamIds: null });
  });
});

describe("appendScope", () => {
  it("own scope adds one owner predicate", () => {
    const where = appendScope([], { unscoped: false, ownerIds: ["u1"], teamIds: [] }, {
      owner: "l.owner_user_id",
      team: "l.team_id",
    });
    expect(where).toHaveLength(1);
  });

  it("unscoped adds nothing", () => {
    expect(appendScope([], { unscoped: true, ownerIds: [], teamIds: [] }, { owner: "l.owner_user_id" })).toEqual([]);
  });
});
