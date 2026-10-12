import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import type { Activity, MutationResult } from "../src/modules/activities/activities.service.js";
import {
  ActivityPromptsService,
  moveProblem,
  PromptResult,
  promptTarget,
} from "../src/modules/activities/activity-prompts.service.js";
import type { Pipeline, Stage } from "../src/modules/pipelines/pipelines.service.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const PIPE = "55555555-5555-5555-5555-555555555504";
const META = { ip: "", userAgent: "" };

const stage = (id: string, name: string, position: number, extra: Partial<Stage> = {}): Stage => ({
  id,
  pipelineId: PIPE,
  name,
  position,
  probability: 0,
  visualAccent: "slate",
  requiredFields: [],
  requiredActivities: [],
  requiredDocuments: [],
  slaHours: null,
  isWon: false,
  isLost: false,
  isActive: true,
  ...extra,
});

const COLD = stage("s-cold", "Cold lead", 1);
const CONTACTED = stage("s-contacted", "Contacted", 2);
const QUALIFIED = stage("s-qualified", "Qualified", 3);
const PROPOSAL = stage("s-proposal", "Proposal", 4);
const WON = stage("s-won", "Won", 6, { isWon: true });
const LOST = stage("s-lost", "Lost", 7, { isLost: true });
const STAGES = [LOST, PROPOSAL, COLD, WON, QUALIFIED, CONTACTED];

describe("promptTarget", () => {
  it("moves a cold lead forward by stage name", () => {
    expect(promptTarget(STAGES, COLD.id, PromptResult.Contacted)?.id).toBe(CONTACTED.id);
    expect(promptTarget(STAGES, COLD.id, PromptResult.Qualified)?.id).toBe(QUALIFIED.id);
    expect(promptTarget(STAGES, COLD.id, PromptResult.NotQualified)?.id).toBe(LOST.id);
    expect(promptTarget(STAGES, COLD.id, PromptResult.NoAnswer)).toBeNull();
  });

  it("never moves a lead backwards or out of Won/Lost", () => {
    expect(promptTarget(STAGES, PROPOSAL.id, PromptResult.Contacted)).toBeNull();
    expect(promptTarget(STAGES, QUALIFIED.id, PromptResult.Qualified)).toBeNull();
    expect(promptTarget(STAGES, WON.id, PromptResult.NotQualified)).toBeNull();
    expect(promptTarget(STAGES, LOST.id, PromptResult.Qualified)).toBeNull();
  });

  it("falls back to stage order when the names were changed", () => {
    const renamed = [stage("a", "New", 1), stage("b", "Reached", 2), stage("c", "Good fit", 3), LOST];
    expect(promptTarget(renamed, "a", PromptResult.Contacted)?.id).toBe("b");
    expect(promptTarget(renamed, "a", PromptResult.Qualified)?.id).toBe("c");
    expect(promptTarget([stage("a", "New", 1)], "a", PromptResult.Contacted)).toBeNull();
  });

  it("ignores inactive stages", () => {
    const stages = [COLD, { ...CONTACTED, isActive: false }, stage("s-call", "Called", 3)];
    expect(promptTarget(stages, COLD.id, PromptResult.Contacted)?.id).toBe("s-call");
  });
});

describe("moveProblem", () => {
  it("lists missing stage requirements", () => {
    const err = AppError.validation("Stage requirements not met", {
      missingFields: ["phone"],
      missingActivities: ["call"],
      missingDocuments: [],
      stageName: "Qualified",
    });
    expect(moveProblem(err)).toBe("Qualified needs: phone, call");
    expect(moveProblem(AppError.forbidden("can only move your own leads"))).toBe("can only move your own leads");
  });
});

const activity = (extra: Partial<Activity> = {}): Activity =>
  ({ id: "act-1", leadId: "lead-1", status: "due", notes: "", ...extra }) as Activity;

function setup(opts: { activity?: Partial<Activity>; lead?: Record<string, unknown> | null; moveError?: Error } = {}) {
  const f = fakeDb();
  const update = vi.fn(async (_actor: string, id: string) => ({ ...activity({ id }), needsNextActivity: true }) as MutationResult);
  const activities = { get: vi.fn(async () => ({ activity: activity(opts.activity), context: {} as never })), update };
  const move = vi.fn(async () => {
    if (opts.moveError) throw opts.moveError;
    return { leadId: "lead-1", changed: true, status: "open", needsNextActivity: false };
  });
  const pipeline = { stages: STAGES } as Pipeline;
  const svc = new ActivityPromptsService(f.db, activities, { move }, { get: async () => pipeline });
  if (opts.lead !== null) f.queue([opts.lead ?? { pipelineId: PIPE, stageId: COLD.id, status: "open" }]);
  return { f, svc, update, move };
}

const me = claims({ userId: "user-1" });

describe("ActivityPromptsService.outcome", () => {
  it("completes the activity and moves the lead to Contacted", async () => {
    const { svc, update, move } = setup();
    const out = await svc.outcome(me, "act-1", { result: "contacted", note: "Keen, call back Friday" }, META);
    expect(update).toHaveBeenCalledWith(
      "user-1",
      "act-1",
      expect.objectContaining({ status: "completed", outcome: "Contacted", notes: "Keen, call back Friday" }),
      META,
      { advanceLead: false },
    );
    expect(move).toHaveBeenCalledWith({ kind: "user", claims: me }, "lead-1", expect.objectContaining({ stageId: CONTACTED.id }), META);
    expect(out.stage).toEqual({ moved: true, stageId: CONTACTED.id, stageName: "Contacted", message: "" });
    expect(out.needsNextActivity).toBe(true);
  });

  it("not qualified closes the lead as Lost with a reason", async () => {
    const { svc, move } = setup();
    const out = await svc.outcome(me, "act-1", { result: "not_qualified" }, META);
    expect(move).toHaveBeenCalledWith(expect.anything(), "lead-1", { stageId: LOST.id, lostReason: "Not qualified" }, META);
    expect(out.needsNextActivity).toBe(false);
  });

  it("no answer only completes the activity", async () => {
    const { svc, update, move } = setup();
    const out = await svc.outcome(me, "act-1", { result: "no_answer" }, META);
    expect(update).toHaveBeenCalledWith("user-1", "act-1", expect.objectContaining({ outcome: "No answer" }), META, {
      advanceLead: false,
    });
    expect(move).not.toHaveBeenCalled();
    expect(out.stage.moved).toBe(false);
  });

  it("keeps the answer when the move is refused", async () => {
    const err = AppError.validation("Stage requirements not met", { missingFields: ["phone"], stageName: "Contacted" });
    const { svc, update } = setup({ moveError: err });
    const out = await svc.outcome(me, "act-1", { result: "contacted" }, META);
    expect(update).toHaveBeenCalled();
    expect(out.stage).toEqual({ moved: false, stageId: null, stageName: null, message: "Contacted needs: phone" });
  });

  it("does not move a lead that is already further along", async () => {
    const { svc, move } = setup({ lead: { pipelineId: PIPE, stageId: PROPOSAL.id, status: "open" } });
    const out = await svc.outcome(me, "act-1", { result: "contacted" }, META);
    expect(move).not.toHaveBeenCalled();
    expect(out.stage.message).toBe("Lead stays in Proposal.");
  });

  it("rejects bad input and closed or unlinked activities", async () => {
    await expect(setup().svc.outcome(me, "act-1", { result: "maybe" }, META)).rejects.toThrow("result must be");
    await expect(setup({ activity: { leadId: null } }).svc.outcome(me, "act-1", { result: "contacted" }, META)).rejects.toThrow(
      "activity is not linked to a lead",
    );
    await expect(
      setup({ activity: { status: "completed" } }).svc.outcome(me, "act-1", { result: "contacted" }, META),
    ).rejects.toThrow("activity is already closed");
  });
});

describe("ActivityPromptsService.contactMade", () => {
  it("moves a cold lead to Contacted as a system move for the user", async () => {
    const { svc, move } = setup();
    await expect(svc.contactMade("user-1", "lead-1", META)).resolves.toEqual({ stageId: CONTACTED.id, stageName: "Contacted" });
    expect(move).toHaveBeenCalledWith(
      { kind: "automation", actorUserId: "user-1" },
      "lead-1",
      expect.objectContaining({ stageId: CONTACTED.id }),
      META,
    );
  });

  it("leaves leads at or past Contacted, and closed leads, alone", async () => {
    for (const lead of [
      { pipelineId: PIPE, stageId: CONTACTED.id, status: "open" },
      { pipelineId: PIPE, stageId: QUALIFIED.id, status: "open" },
      { pipelineId: PIPE, stageId: WON.id, status: "won" },
    ]) {
      const { svc, move } = setup({ lead });
      await expect(svc.contactMade("user-1", "lead-1", META)).resolves.toBeNull();
      expect(move).not.toHaveBeenCalled();
    }
  });

  it("returns null when the move is refused", async () => {
    const { svc } = setup({ moveError: AppError.validation("Stage requirements not met", { missingFields: ["email"] }) });
    await expect(svc.contactMade("user-1", "lead-1", META)).resolves.toBeNull();
  });
});

describe("ActivityPromptsService.due and snooze", () => {
  it("only lists the caller's due, unsnoozed lead activities", async () => {
    const { f, svc } = setup({ lead: null });
    await svc.due("user-1");
    const q = f.queries[0]!;
    expect(q.sql).toContain("a.owner_user_id = $1");
    expect(q.sql).toContain("a.prompt_snoozed_until IS NULL OR a.prompt_snoozed_until <= NOW()");
    expect(q.sql).toContain("COALESCE(a.start_at, a.due_at) <= NOW()");
    expect(q.parameters[0]).toBe("user-1");
  });

  it("validates snooze minutes", async () => {
    const { f, svc } = setup({ lead: null });
    await expect(svc.snooze("act-1", 0)).rejects.toThrow("minutes must be between 1 and 1440");
    await expect(svc.snooze("act-1", 1441)).rejects.toThrow("minutes must be between 1 and 1440");
    f.queue([]);
    await expect(svc.snooze("act-1", 10)).rejects.toThrow("activity not found");
    f.queue([{ snoozedUntil: new Date(0) }]);
    await expect(svc.snooze("act-1", 10)).resolves.toEqual({ snoozedUntil: new Date(0) });
  });
});
