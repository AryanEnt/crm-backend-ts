import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import { LeadsService } from "../src/modules/leads/leads.service.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const META = { ip: "", userAgent: "" };
const me = claims({ userId: "user-1", roleCode: "sales_executive" });

const leadRow = {
  id: "lead-1",
  fullName: "Asha",
  email: null,
  phone: null,
  country: "",
  nationality: "",
  location: "",
  ownerUserId: "user-1",
  ownerName: "SE",
  teamId: null,
  teamName: null,
  source: "",
  priority: "medium",
  tags: [],
  anzscoId: null,
  anzscoCode: null,
  anzscoTitle: null,
  pipelineId: "p",
  pipelineName: "Nurturing",
  stageId: "s",
  stageName: "Clients",
  stageAccent: null,
  notes: "",
  occupation: "",
  jobTitle: "",
  employer: "",
  experienceYears: null,
  qualification: "",
  skills: [],
  potentialValue: null,
  currency: "AUD",
  probability: null,
  expectedCloseAt: null,
  expectedOutcome: "",
  lastActivityAt: null,
  nextActivityAt: null,
  status: "open",
  wonAt: null,
  lostAt: null,
  lostReason: "",
  negotiationTag: "",
  negotiationRemarks: "",
  contactRating: null,
  contactRemarks: "",
  contactRatedAt: null,
  contactRatedBy: null,
  contactRatedByName: null,
  documentDelayRemarks: "",
  documentDelayRemarksAt: null,
  documentDelayRemarksBy: null,
  documentDelayRemarksByName: null,
  stageEnteredAt: new Date(),
  daysInStage: 1,
  convertedCustomerId: null,
  convertedAt: null,
  isArchived: false,
  archivedAt: null,
  ageDays: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  slaHours: null,
  createdByUserId: null,
  phoneCountryCode: "",
  phoneValidationStatus: "pending",
  phoneNormalized: null,
  phoneValidationMessage: "",
  phoneDuplicateLeadIds: [],
  phoneValidatedAt: null,
  phoneLastNotifiedAt: null,
  phoneValidationVersion: 0,
};

function service() {
  const f = fakeDb();
  const stub = { record: vi.fn(), emit: vi.fn(), attachToLead: vi.fn(), setValues: vi.fn() };
  const svc = new LeadsService(
    f.db as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    { listHistory: vi.fn() } as never,
  );
  return { f, svc };
}

function sqlOf(f: ReturnType<typeof fakeDb>) {
  return f.queries.map((q) => q.sql);
}

describe("document delay remarks", () => {
  it("rejects empty remarks", async () => {
    const { svc } = service();
    await expect(svc.addDocumentDelayRemark(me, "lead-1", "  ", META)).rejects.toThrow("remarks are required");
  });

  it("rejects remarks when documents are not overdue", async () => {
    const { f, svc } = service();
    f.queue([leadRow], [{ overdue: false }]);
    const err = await svc.addDocumentDelayRemark(me, "lead-1", "Client away", META).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/not overdue/i);
  });

  it("appends a remark and refreshes the lead when overdue", async () => {
    const { f, svc } = service();
    const after = {
      ...leadRow,
      documentDelayRemarks: "Client away",
      documentDelayRemarksAt: new Date(),
      documentDelayRemarksBy: "user-1",
      documentDelayRemarksByName: "SE",
    };
    // get → overdue check → insert → update → list history → get
    f.queue(
      [leadRow],
      [{ overdue: true }],
      [],
      [],
      [{ id: "r1", leadId: "lead-1", body: "Client away", authorUserId: "user-1", authorName: "SE", createdAt: new Date() }],
      [after],
    );
    const out = await svc.addDocumentDelayRemark(me, "lead-1", "Client away", META);
    expect(out.remark.body).toBe("Client away");
    expect(out.lead.documentDelayRemarks).toBe("Client away");
    expect(sqlOf(f).some((q) => q.includes("lead_document_delay_remarks"))).toBe(true);
  });
});
