import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import { LeadsService } from "../src/modules/leads/leads.service.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const META = { ip: "", userAgent: "" };
const FIRST = { id: "s-created", pipelineId: "p-leads", name: "Created", probability: 10 };

const teamLead = claims({
  userId: "tl-1",
  roleCode: "sales_manager",
  teamIds: ["team-1"],
  teamMemberUserIds: ["se-1", "se-2"],
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: "lead-1",
  fullName: "Asha",
  email: "asha@example.com",
  phone: null,
  country: "Australia",
  nationality: "Indian",
  location: "Sydney",
  ownerUserId: "se-1",
  ownerName: "SE One",
  teamId: "team-1",
  teamName: "Team",
  source: "Website",
  priority: "high",
  tags: ["visa"],
  anzscoId: null,
  anzscoCode: null,
  anzscoTitle: null,
  pipelineId: "p-leads",
  pipelineName: "Lead Pipeline",
  stageId: "s-lost",
  stageName: "Lost",
  stageAccent: null,
  notes: "Wants 189",
  occupation: "Engineer",
  jobTitle: "Civil Engineer",
  employer: "Acme",
  experienceYears: 6,
  qualification: "BE",
  skills: ["cad"],
  potentialValue: 5000,
  currency: "AUD",
  probability: 0,
  expectedCloseAt: null,
  expectedOutcome: "",
  lastActivityAt: null,
  nextActivityAt: null,
  status: "lost",
  wonAt: null,
  lostAt: new Date(),
  lostReason: "Price",
  negotiationTag: "Budget Concern",
  negotiationRemarks: "",
  contactRating: 3,
  contactRemarks: "Spoke twice",
  contactRatedAt: null,
  contactRatedBy: null,
  contactRatedByName: null,
  nextFollowUpRemarks: "Call next month",
  documentDelayRemarks: "",
  documentDelayRemarksAt: null,
  documentDelayRemarksBy: null,
  documentDelayRemarksByName: null,
  fileDeliveredEmailSentAt: null,
  stageEnteredAt: new Date(Date.now() - 10 * 86_400_000),
  daysInStage: 10,
  convertedCustomerId: null,
  convertedAt: null,
  isArchived: false,
  archivedAt: null,
  ageDays: 30,
  createdAt: new Date(Date.now() - 30 * 86_400_000),
  updatedAt: new Date(),
  slaHours: null,
  createdByUserId: "se-1",
  phoneCountryCode: "AU",
  phoneValidationStatus: "valid",
  phoneNormalized: null,
  phoneValidationMessage: "",
  phoneDuplicateLeadIds: [],
  phoneValidatedAt: null,
  phoneLastNotifiedAt: null,
  phoneValidationVersion: 0,
  ...extra,
});

function service() {
  const f = fakeDb();
  const stub = {
    record: vi.fn(),
    emit: vi.fn(),
    attachToLead: vi.fn(),
    getForLead: vi.fn(async () => null),
    getValues: vi.fn(async () => ({})),
    setValues: vi.fn(),
  };
  const stages = {
    defaultPlacement: vi.fn(async () => ({ pipelineId: "p-leads", stage: FIRST })),
    recordInitialStage: vi.fn(async () => undefined),
  };
  const svc = new LeadsService(
    f.db as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stages as never,
  );
  return { f, svc, stub, stages };
}

const sqlOf = (f: ReturnType<typeof fakeDb>) => f.queries.map((q) => q.sql.replace(/\s+/g, " ").trim());

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("LeadsService.transferLost", () => {
  it("creates a new open lead for the executive at the first stage, keeping profile details", async () => {
    const { f, svc, stub, stages } = service();
    const fresh = row({
      id: "lead-2",
      ownerUserId: "se-2",
      ownerName: "SE Two",
      stageId: FIRST.id,
      stageName: FIRST.name,
      status: "open",
      lostAt: null,
      lostReason: "",
      negotiationTag: "",
      contactRating: null,
      contactRemarks: "",
      nextFollowUpRemarks: "",
      stageEnteredAt: new Date(),
      daysInStage: 0,
    });
    f.queue([row()], [{ id: "se-2", teamId: "team-1" }], [], [], [fresh]);
    f.setRows([fresh]);

    const out = await svc.transferLost(teamLead, "lead-1", "se-2", META);

    expect(out).toMatchObject({ id: "lead-2", ownerUserId: "se-2", status: "open", stageId: FIRST.id, daysInStage: 0 });
    const q = sqlOf(f);
    const insertAt = q.findIndex((s) => s.startsWith("INSERT INTO leads"));
    expect(insertAt).toBeGreaterThan(-1);
    expect(q[insertAt]).toContain("transferred_from_lead_id");
    expect(q[insertAt]).toContain("'open', NOW()");
    const params = f.queries[insertAt]!.parameters;
    for (const v of ["Asha", "asha@example.com", "se-2", "team-1", "Website", "Wants 189", "Acme", "p-leads", FIRST.id, "lead-1"]) {
      expect(params).toContain(v);
    }
    expect(params).not.toContain("Price");
    expect(params).not.toContain("Budget Concern");
    expect(params).not.toContain("Call next month");
    expect(q.some((s) => /^UPDATE leads SET (pipeline_id|status)/.test(s))).toBe(false);
    expect(stages.recordInitialStage).toHaveBeenCalledWith("lead-2", "p-leads", FIRST, "tl-1", {
      kind: "transferred",
      fromLeadId: "lead-1",
    });
    expect(stub.record).toHaveBeenCalledWith("tl-1", "lead.transferred", "lead", "lead-1", expect.anything(), META);
  });

  it("rejects callers who are not Team Leads", async () => {
    const { svc } = service();
    const se = claims({ userId: "se-1", roleCode: "sales_executive", teamIds: ["team-1"] });
    expect((await rejection(svc.transferLost(se, "lead-1", "se-2", META))).message).toBe("Only Team Leads can transfer leads");
  });

  it("rejects leads that are not Lost", async () => {
    const { f, svc } = service();
    f.queue([row({ status: "open" })]);
    expect((await rejection(svc.transferLost(teamLead, "lead-1", "se-2", META))).message).toBe(
      "Only Lost leads can be transferred",
    );
  });

  it("rejects leads outside the Team Lead's team", async () => {
    const { f, svc } = service();
    f.queue([row({ teamId: "team-9", ownerUserId: "se-9" })]);
    expect((await rejection(svc.transferLost(teamLead, "lead-1", "se-2", META))).message).toBe(
      "lead is outside your team scope",
    );
  });

  it("rejects the current owner", async () => {
    const { f, svc } = service();
    f.queue([row()]);
    expect((await rejection(svc.transferLost(teamLead, "lead-1", "se-1", META))).message).toMatch(/different executive/);
  });

  it("rejects an executive who is not an active SE on the team", async () => {
    const { f, svc } = service();
    f.queue([row()], []);
    expect((await rejection(svc.transferLost(teamLead, "lead-1", "se-9", META))).message).toBe(
      "Select an active executive from your team",
    );
  });

  it("rejects a lead that was already transferred", async () => {
    const { f, svc } = service();
    f.queue([row()], [{ id: "se-2", teamId: "team-1" }], [{ id: "lead-2" }]);
    const err = await rejection(svc.transferLost(teamLead, "lead-1", "se-2", META));
    expect(err.message).toBe("This lead has already been transferred");
    expect(sqlOf(f).some((s) => s.startsWith("INSERT INTO leads"))).toBe(false);
  });
});
