import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import { Records, requireRecord, requireRecords } from "../src/modules/datascope/record.js";
import { P, Role } from "../src/modules/permissions/permissions.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const leadId = "8d2b6c1e-8f1a-4d0e-9a57-1f3c2b4a5d6e";
const leadId2 = "0b7f3a9c-2e4d-4c1b-8a6f-9d8e7c6b5a4f";

const salesExec = claims({
  userId: "11111111-aaaa-4aaa-8aaa-111111111111",
  roleCode: Role.SalesExecutive,
  permissions: [P.LeadsView, P.LeadsEdit, P.DocumentsView],
  permissionScopes: { [P.LeadsView]: "own" },
});
const teamLead = claims({
  userId: "22222222-bbbb-4bbb-8bbb-222222222222",
  roleCode: Role.SalesManager,
  permissions: [P.LeadsView],
  teamIds: ["team-a"],
});
const superAdmin = claims({
  userId: "33333333-cccc-4ccc-8ccc-333333333333",
  roleCode: Role.SuperAdmin,
  permissions: [P.LeadsView, P.CustomFieldsManage],
});

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

describe("requireRecord", () => {
  it("sales exec only sees own rows", async () => {
    const f = fakeDb();
    f.setRows([{ ok: false }]);
    await expectCode(requireRecord(f.db, salesExec, Records.Leads, leadId, P.LeadsView), "not_found");
    const q = f.queries[0]!;
    expect(q.sql).toContain("l.owner_user_id = ANY($2::uuid[])");
    expect(q.parameters[1]).toEqual([salesExec.userId]);

    f.setRows([{ ok: true }]);
    await requireRecord(f.db, salesExec, Records.Leads, leadId, P.LeadsView);
  });

  it("team lead is limited to their teams; without a team they match nothing", async () => {
    let f = fakeDb();
    f.setRows([{ ok: true }]);
    await requireRecord(f.db, teamLead, Records.Leads, leadId, P.LeadsView);
    expect(f.queries[0]!.sql).toContain("l.team_id = ANY($2::uuid[])");

    f = fakeDb();
    f.setRows([{ ok: false }]);
    await expectCode(
      requireRecord(f.db, { ...teamLead, teamIds: [] }, Records.Leads, leadId, P.LeadsView),
      "not_found",
    );
    expect((f.queries[0]!.parameters[1] as string[])[0]).not.toBe(teamLead.userId);
  });

  it("organization scope is an id-only lookup", async () => {
    const f = fakeDb();
    f.setRows([{ ok: true }]);
    await requireRecord(f.db, superAdmin, Records.Leads, leadId, P.LeadsView);
    expect(f.queries[0]!.parameters).toHaveLength(1);
    expect(f.queries[0]!.sql).not.toContain("owner_user_id");
  });

  it("uses the widest scope across permissions", async () => {
    const f = fakeDb();
    f.setRows([{ ok: true }]);
    await requireRecord(f.db, superAdmin, Records.Leads, leadId, P.LeadsEdit, P.CustomFieldsManage);
    expect(f.queries[0]!.parameters).toHaveLength(1);
  });

  it("rejects malformed ids without querying", async () => {
    const f = fakeDb();
    await expectCode(requireRecord(f.db, superAdmin, Records.Leads, "not-a-uuid", P.LeadsView), "not_found");
    expect(f.queries).toHaveLength(0);
  });

  it("missing permission is forbidden", async () => {
    const f = fakeDb();
    await expectCode(requireRecord(f.db, salesExec, Records.Deals, leadId, P.DealsView), "forbidden");
  });

  it("documents follow their parent record or uploader", async () => {
    const f = fakeDb();
    f.setRows([{ ok: true }]);
    await requireRecord(f.db, salesExec, Records.Documents, leadId, P.DocumentsView);
    const q = f.queries[0]!;
    for (const want of ["FROM leads pl", "FROM customers pc", "FROM deals pd", "d.uploaded_by = $"]) {
      expect(q.sql).toContain(want);
    }
    expect(q.parameters.at(-1)).toBe(salesExec.userId);
  });

  it("wraps database failures as internal errors", async () => {
    const f = fakeDb();
    f.failWith(new Error("boom"));
    await expectCode(requireRecord(f.db, superAdmin, Records.Leads, leadId, P.LeadsView), "internal_error");
  });
});

describe("requireRecords", () => {
  it("every id must be visible; duplicates collapse", async () => {
    const f = fakeDb();
    f.setRows([{ count: 1 }]);
    await expectCode(
      requireRecords(f.db, salesExec, Records.Leads, [leadId, leadId2, leadId], P.LeadsEdit),
      "not_found",
    );
    expect(f.queries[0]!.parameters[0]).toHaveLength(2);

    f.setRows([{ count: 2 }]);
    await requireRecords(f.db, salesExec, Records.Leads, [leadId, leadId2], P.LeadsEdit);
  });
});
