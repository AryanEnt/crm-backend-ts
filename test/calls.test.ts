import { describe, expect, it } from "vitest";
import type { Claims } from "../src/modules/auth/types.js";
import { CallsService } from "../src/modules/calls/calls.service.js";
import type { CustomersRepository } from "../src/modules/customers/customers.service.js";
import type { LeadsRepository } from "../src/modules/leads/leads.service.js";
import { P } from "../src/modules/permissions/permissions.js";
import type { TimelineService } from "../src/modules/timeline/timeline.service.js";
import { fakeDb } from "./helpers/fake-db.js";

const me = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";

const claims: Claims = {
  userId: me,
  email: "se@crm.local",
  fullName: "SE",
  roleCode: "sales_executive",
  roleId: "",
  teamIds: [],
  teamMemberUserIds: [],
  permissions: [P.LeadsView, P.CustomersView],
  permissionScopes: { [P.LeadsView]: "own", [P.CustomersView]: "own" },
  expiresAt: new Date(Date.now() + 60_000),
};

function service() {
  const f = fakeDb();
  const svc = new CallsService(f.db, {} as LeadsRepository, {} as CustomersRepository, {} as TimelineService);
  return { f, svc };
}

const filter = { search: "", type: "", priority: "", pinnedOnly: false, limit: 0 };

describe("calls contacts filters", () => {
  it("rejects an unknown priority", async () => {
    const { svc } = service();
    await expect(svc.contacts(claims, { ...filter, priority: "critical" })).rejects.toThrow(
      "priority must be low, medium, high or urgent",
    );
  });

  it("filters by priority and pins, sorting the caller's pins first", async () => {
    const { f, svc } = service();
    await svc.contacts(claims, { ...filter, priority: "urgent", pinnedOnly: true, userId: "someone-else" });
    const q = f.queries[0]!;
    expect(q.sql).toContain("l.priority = ");
    expect(q.sql).toContain("c.priority = ");
    expect(q.sql).toMatch(/FROM leads l[\s\S]*WHERE[\s\S]*EXISTS \(SELECT 1 FROM call_pins/);
    expect(q.sql).toContain("ORDER BY pinned DESC, updated_at DESC");
    expect(q.parameters).toContain("urgent");
    expect(q.parameters).toContain(me);
    expect(q.parameters).not.toContain("someone-else");
  });
});

describe("calls pins", () => {
  it("pins only records in scope", async () => {
    const { f, svc } = service();
    f.queue([{ ok: false }]);
    await expect(svc.pin(claims, { entityType: "lead", entityId: leadId })).rejects.toThrow("lead not found");
    expect(f.queries).toHaveLength(1);

    f.queue([{ ok: true }]);
    await svc.pin(claims, { entityType: "lead", entityId: leadId });
    expect(f.queries[2]!.sql).toContain("INSERT INTO call_pins");
    expect(f.queries[2]!.parameters).toEqual([me, "lead", leadId]);
  });

  it("unpin validates the record type and id and deletes only the caller's pin", async () => {
    const { f, svc } = service();
    await expect(svc.unpin(claims, "deal", leadId)).rejects.toThrow("type must be lead or customer");
    await expect(svc.unpin(claims, "lead", "nope")).rejects.toThrow("id must be a valid UUID");
    await svc.unpin(claims, "lead", leadId);
    expect(f.queries[0]!.sql).toContain("DELETE FROM call_pins WHERE user_id = ");
    expect(f.queries[0]!.parameters).toEqual([me, "lead", leadId]);
  });
});
