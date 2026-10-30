import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import type { AuditService } from "../src/modules/audit/audit.service.js";
import type { AutomationEmitter } from "../src/modules/automation/emitter.js";
import {
  DocumentsService,
  ShareScope,
  type DocumentRecord,
} from "../src/modules/documents/documents.service.js";
import { P, Role } from "../src/modules/permissions/permissions.js";
import type { Store } from "../src/modules/storage/storage.js";
import type { TimelineService } from "../src/modules/timeline/timeline.service.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const meta = { ip: "", userAgent: "" } as never;
const teamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const adminId = "11111111-1111-4111-8111-111111111111";
const tlId = "22222222-2222-4222-8222-222222222222";
const otherTlId = "33333333-3333-4333-8333-333333333333";
const seId = "44444444-4444-4444-8444-444444444444";
const docId = "55555555-5555-4555-8555-555555555555";

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: docId,
    name: "handbook.pdf",
    type: "policy",
    category: "policy",
    status: "uploaded",
    mimeType: "application/pdf",
    sizeBytes: 10,
    fileKey: "documents/handbook.pdf",
    storageProvider: "local",
    notes: "",
    description: "",
    originalFilename: "handbook.pdf",
    shareScope: ShareScope.AllTeams,
    rejectedReason: "",
    leadId: null,
    leadName: null,
    customerId: null,
    customerName: null,
    dealId: null,
    dealTitle: null,
    uploadedBy: adminId,
    uploadedByName: "Admin",
    uploadedByRole: Role.SuperAdmin,
    verifiedBy: null,
    verifiedByName: null,
    requestedDate: null,
    uploadedDate: now,
    expiryDate: null,
    verifiedAt: null,
    createdAt: now,
    updatedAt: now,
    viewerUserIds: [],
    sharedUserIds: [],
    sharedTeamIds: [],
    sharedTeamNames: [],
    ...overrides,
  };
}

function service(db = fakeDb().db) {
  const store: Store = {
    provider: () => "local",
    put: vi.fn(),
    open: vi.fn(),
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
  };
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const timeline = { record: vi.fn(async () => undefined) } as unknown as TimelineService;
  const hooks = { emit: vi.fn(async () => undefined) } as unknown as AutomationEmitter;
  return new DocumentsService(db, store, audit, timeline, hooks, null);
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

describe("document share plan resolution", () => {
  it("Admin all_teams needs no share rows", async () => {
    const f = fakeDb();
    const svc = service(f.db);
    const admin = claims({
      userId: adminId,
      roleCode: Role.SuperAdmin,
      permissions: [P.DocumentsCreate],
    });
    const plan = await svc.repo.resolveSharePlan(admin, { shareScope: ShareScope.AllTeams, teamIds: undefined, viewerUserIds: undefined }, undefined);
    expect(plan).toEqual({ shareScope: ShareScope.AllTeams, teamIds: [], userIds: [] });
  });

  it("Admin selected_teams validates active teams", async () => {
    const f = fakeDb();
    f.setRows([{ id: teamA }, { id: teamB }]);
    const svc = service(f.db);
    const admin = claims({
      userId: adminId,
      roleCode: Role.SuperAdmin,
      permissions: [P.DocumentsCreate],
    });
    const plan = await svc.repo.resolveSharePlan(
      admin,
      { shareScope: ShareScope.SelectedTeams, teamIds: [teamA, teamB], viewerUserIds: undefined },
      undefined,
    );
    expect(plan.shareScope).toBe(ShareScope.SelectedTeams);
    expect(plan.teamIds).toEqual([teamA, teamB]);
  });

  it("Admin cannot use selected_ses", async () => {
    const f = fakeDb();
    const svc = service(f.db);
    const admin = claims({ userId: adminId, roleCode: Role.SuperAdmin, permissions: [P.DocumentsCreate] });
    await expectCode(
      svc.repo.resolveSharePlan(
        admin,
        { shareScope: ShareScope.SelectedSes, teamIds: undefined, viewerUserIds: [seId] },
        undefined,
      ),
      "validation_error",
    );
  });

  it("TL all_team_ses uses their team id", async () => {
    const f = fakeDb();
    const svc = service(f.db);
    const tl = claims({
      userId: tlId,
      roleCode: Role.SalesManager,
      teamIds: [teamA],
      permissions: [P.DocumentsCreate],
    });
    const plan = await svc.repo.resolveSharePlan(
      tl,
      { shareScope: ShareScope.AllTeamSes, teamIds: undefined, viewerUserIds: undefined },
      undefined,
    );
    expect(plan).toEqual({ shareScope: ShareScope.AllTeamSes, teamIds: [teamA], userIds: [] });
  });

  it("TL selected_ses validates SEs on their team", async () => {
    const f = fakeDb();
    f.setRows([{ id: seId }]);
    const svc = service(f.db);
    const tl = claims({
      userId: tlId,
      roleCode: Role.SalesManager,
      teamIds: [teamA],
      permissions: [P.DocumentsCreate],
    });
    const plan = await svc.repo.resolveSharePlan(
      tl,
      { shareScope: ShareScope.SelectedSes, teamIds: undefined, viewerUserIds: [seId] },
      undefined,
    );
    expect(plan.userIds).toEqual([seId]);
  });

  it("SE cannot share library documents", async () => {
    const f = fakeDb();
    const svc = service(f.db);
    const se = claims({
      userId: seId,
      roleCode: Role.SalesExecutive,
      teamIds: [teamA],
      permissions: [P.DocumentsView],
    });
    await expectCode(
      svc.repo.resolveSharePlan(
        se,
        { shareScope: ShareScope.SelectedSes, teamIds: undefined, viewerUserIds: [seId] },
        undefined,
      ),
      "forbidden",
    );
  });
});

describe("document delete ownership", () => {
  it("TL can delete only their own uploads", async () => {
    const svc = service();
    const tl = claims({
      userId: tlId,
      roleCode: Role.SalesManager,
      teamIds: [teamA],
      permissions: [P.DocumentsDelete],
    });
    expect(() => svc.assertCanDelete(tl, doc({ uploadedBy: tlId }))).not.toThrow();
    expect(() => svc.assertCanDelete(tl, doc({ uploadedBy: adminId }))).toThrow(AppError);
    expect(() => svc.assertCanDelete(tl, doc({ uploadedBy: otherTlId }))).toThrow(AppError);
  });

  it("Admin can delete TL uploads", async () => {
    const svc = service();
    const admin = claims({
      userId: adminId,
      roleCode: Role.SuperAdmin,
      permissions: [P.DocumentsDelete],
    });
    expect(() => svc.assertCanDelete(admin, doc({ uploadedBy: tlId }))).not.toThrow();
  });

  it("delete rejects TL removing Admin document", async () => {
    const f = fakeDb();
    f.setRows([doc({ uploadedBy: adminId }) as unknown as Record<string, unknown>]);
    const svc = service(f.db);
    const tl = claims({
      userId: tlId,
      roleCode: Role.SalesManager,
      teamIds: [teamA],
      permissions: [P.DocumentsDelete],
    });
    await expectCode(svc.delete(tl, docId, meta), "forbidden");
  });
});
