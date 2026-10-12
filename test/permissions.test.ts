import { describe, expect, it } from "vitest";
import {
  P,
  PermissionSet,
  expandImplies,
  expandImpliesScoped,
  widenScope,
} from "../src/modules/permissions/permissions.js";

describe("permissions", () => {
  it("manage implies the resource's other actions only", () => {
    const s = expandImplies([P.UsersManage, P.TeamsView]);
    expect(s.has(P.UsersView) && s.has(P.UsersDelete) && s.has(P.UsersAssign)).toBe(true);
    expect(s.has(P.TeamsView)).toBe(true);
    expect(s.has(P.TeamsDelete)).toBe(false);
  });

  it("manage does not imply provider actions like communications:send", () => {
    expect(expandImplies([P.CommunicationsManage]).has(P.CommunicationsSend)).toBe(false);
  });

  it("hasAny", () => {
    const s = new PermissionSet([P.UsersView, P.TeamsView]);
    expect(s.hasAny(P.UsersEdit, P.UsersView)).toBe(true);
    expect(s.hasAny(P.UsersEdit, P.UsersDelete)).toBe(false);
  });

  it("expandImpliesScoped carries team scope", () => {
    expect(expandImpliesScoped([{ code: "leads:view", scope: "team" }])["leads:view"]).toBe("team");
  });

  it("expandImpliesScoped defaults an empty scope to organization and widens implied grants", () => {
    const scopes = expandImpliesScoped([
      { code: "targets:view", scope: "own" },
      { code: "targets:manage", scope: "" },
    ]);
    expect(scopes["targets:manage"]).toBe("organization");
    expect(scopes["targets:view"]).toBe("organization");
  });

  it("widenScope", () => {
    expect(widenScope("own", "team")).toBe("team");
    expect(widenScope("team", "organization")).toBe("organization");
    expect(widenScope("organization", "own")).toBe("organization");
  });
});
