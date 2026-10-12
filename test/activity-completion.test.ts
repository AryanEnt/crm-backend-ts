import { describe, expect, it, vi } from "vitest";
import { ActivitiesService, type Activity } from "../src/modules/activities/activities.service.js";
import { fakeDb } from "./helpers/fake-db.js";

const META = { ip: "", userAgent: "" };
const recorder = () => ({ record: vi.fn(async () => {}) });

function setup(before: Partial<Activity>, after: Partial<Activity> = { status: "completed" }) {
  const svc = new ActivitiesService(
    fakeDb().db,
    {} as never,
    recorder() as never,
    recorder() as never,
    { emit: vi.fn(async () => {}) } as never,
    recorder() as never,
  );
  const base = { id: "act-1", title: "Call", kind: "call", leadId: "lead-1", customerId: null, dealId: null, status: "due", notes: "" };
  svc.repo.get = vi.fn(async () => ({ ...base, ...before }) as Activity) as never;
  svc.repo.update = vi.fn(async () => ({ ...base, ...before, ...after }) as Activity) as never;
  svc.repo.linkedNeedsNext = vi.fn(async () => false) as never;
  const advancer = vi.fn(async () => ({ stageId: "s-contacted", stageName: "Contacted" }));
  svc.setLeadAdvancer(advancer);
  return { svc, advancer };
}

describe("completing a lead activity", () => {
  it("moves the lead forward and reports where it went", async () => {
    const { svc, advancer } = setup({});
    const out = await svc.update("user-1", "act-1", { status: "completed", clearDueAt: false }, META);
    expect(advancer).toHaveBeenCalledWith("user-1", "lead-1", META);
    expect(out.leadMovedTo).toEqual({ stageId: "s-contacted", stageName: "Contacted" });
  });

  it("skips the move when the caller handles the stage itself", async () => {
    const { svc, advancer } = setup({});
    const out = await svc.update("user-1", "act-1", { status: "completed", clearDueAt: false }, META, { advanceLead: false });
    expect(advancer).not.toHaveBeenCalled();
    expect(out.leadMovedTo).toBeUndefined();
  });

  it("only reacts to the change into completed, on lead activities", async () => {
    for (const [before, after] of [
      [{ status: "completed" }, { status: "completed" }],
      [{}, { status: "cancelled" }],
      [{ leadId: null, customerId: "cust-1" }, { status: "completed" }],
    ] as [Partial<Activity>, Partial<Activity>][]) {
      const { svc, advancer } = setup(before, after);
      await svc.update("user-1", "act-1", { status: after.status, clearDueAt: false }, META);
      expect(advancer).not.toHaveBeenCalled();
    }
  });

  it("still completes the activity when the move fails", async () => {
    const { svc, advancer } = setup({});
    advancer.mockRejectedValueOnce(new Error("db down"));
    const out = await svc.update("user-1", "act-1", { status: "completed", clearDueAt: false }, META);
    expect(out.status).toBe("completed");
    expect(out.leadMovedTo).toBeUndefined();
  });
});
