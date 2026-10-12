import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
import { AppError } from "../src/lib/app-error.js";
import {
  assertLeadEditable,
  LeadStageService,
  missingLeadFields,
  statusForStage,
  type MovableLead,
} from "../src/modules/leads/lead-stage.service.js";
import { parseFilter } from "../src/modules/analytics/analytics.filter.js";
import { P } from "../src/modules/permissions/permissions.js";
import type { Pipeline, PipelinesRepository, Stage } from "../src/modules/pipelines/pipelines.service.js";
import { LeadInsightsService } from "../src/modules/leads/lead-insights.service.js";
import { assignTargetInScope } from "../src/modules/leads/leads.service.js";
import { bearer, config, queueAuth, userRow } from "./helpers/app.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const PIPE = "55555555-5555-5555-5555-555555555504";
const OTHER_PIPE = "55555555-5555-5555-5555-555555555501";
const META = { ip: "", userAgent: "" };

const stage = (id: string, name: string, extra: Partial<Stage> = {}): Stage => ({
  id,
  pipelineId: PIPE,
  name,
  position: 1,
  probability: 10,
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

const CREATED = stage("s-created", "Created");
const PROPOSAL = stage("s-proposal", "Proposal", { position: 4, probability: 60 });
const WON = stage("s-won", "Won", { position: 6, probability: 100, isWon: true });
const LOST = stage("s-lost", "Lost", { position: 7, probability: 0, isLost: true });
const INACTIVE = stage("s-off", "Old", { isActive: false });
const FOREIGN = stage("s-foreign", "Sales", { pipelineId: OTHER_PIPE });
const STAGES = [CREATED, PROPOSAL, WON, LOST, INACTIVE, FOREIGN];

const PIPELINE: Pipeline = {
  id: PIPE,
  name: "Lead Pipeline",
  description: "",
  kind: "leads",
  isDefault: true,
  isActive: true,
  stages: [CREATED, PROPOSAL, WON, LOST, INACTIVE],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const pipelinesStub = (p: Pipeline = PIPELINE) =>
  ({
    get: async (id: string) => (id === p.id ? p : null),
    getStage: async (id: string) => STAGES.find((s) => s.id === id) ?? null,
  }) as unknown as PipelinesRepository;

const lead = (extra: Partial<MovableLead> = {}) => movable(extra) as unknown as Record<string, unknown>;
const movable = (extra: Partial<MovableLead> = {}): MovableLead => ({
  id: "lead-1",
  fullName: "Asha",
  email: null,
  phone: "0400",
  ownerUserId: "owner-1",
  teamId: "team-1",
  pipelineId: PIPE,
  stageId: CREATED.id,
  stageName: "Created",
  source: "Website",
  priority: "medium",
  notes: "",
  employer: "",
  potentialValue: null,
  expectedCloseAt: null,
  status: "open",
  isArchived: false,
  stageEnteredAt: new Date(Date.now() - 3_600_000),
  createdAt: new Date(Date.now() - 7_200_000),
  ...extra,
});

const admin = claims({ userId: "admin-1", roleCode: "super_admin", permissions: [P.LeadsEdit] });
const user = { kind: "user" as const, claims: admin };

function service(wake = vi.fn(), p?: Pipeline) {
  const f = fakeDb();
  const svc = new LeadStageService(f.db as unknown as Database, pipelinesStub(p), null, wake);
  return { f, svc, wake };
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

describe("lead stage helpers", () => {
  it("missingLeadFields checks lead columns, then custom field values", () => {
    const custom = new Map([["visa_type", true]]);
    expect(
      missingLeadFields(movable(), ["value", "expectedCloseAt", "source", "phone", "email", "company", "owner", " visa_type ", "budget", " "], custom),
    ).toEqual(["value", "expectedCloseAt", "email", "company", "budget"]);
    expect(missingLeadFields(movable({ potentialValue: 0, employer: "Acme" }), ["potential_value", "employer"], new Map())).toEqual([]);
  });

  it("statusForStage follows the outcome flags; archived leads keep their status", () => {
    expect(statusForStage(WON, movable())).toBe("won");
    expect(statusForStage(LOST, movable())).toBe("lost");
    expect(statusForStage(PROPOSAL, movable({ status: "won" }))).toBe("open");
    expect(statusForStage(PROPOSAL, movable({ status: "unqualified", isArchived: true }))).toBe("unqualified");
  });

  it("assertLeadEditable honours the leads:edit data scope", () => {
    const scoped = (scope: string, extra = {}) =>
      claims({ userId: "u1", permissions: [P.LeadsEdit], permissionScopes: { [P.LeadsEdit]: scope } as never, ...extra });
    expect(() => assertLeadEditable(scoped("organization"), movable())).not.toThrow();
    expect(() => assertLeadEditable(scoped("team", { teamIds: ["team-1"] }), movable())).not.toThrow();
    expect(() => assertLeadEditable(scoped("team", { teamIds: ["team-9"] }), movable())).toThrow("outside your team");
    expect(() => assertLeadEditable(scoped("own"), movable({ ownerUserId: "u1" }))).not.toThrow();
    expect(() => assertLeadEditable(scoped("own"), movable())).toThrow("own leads");
  });

  it("assignTargetInScope keeps reassignment inside the leads:assign scope", () => {
    const tl = claims({
      userId: "tl",
      roleCode: "sales_manager",
      teamIds: ["team-1"],
      teamMemberUserIds: ["se-1"],
      permissions: [P.LeadsAssign],
      permissionScopes: { [P.LeadsAssign]: "team" } as never,
    });
    expect(() => assignTargetInScope(tl, "se-1", "team-1")).not.toThrow();
    expect(() => assignTargetInScope(tl, "tl", "")).not.toThrow();
    expect(() => assignTargetInScope(tl, "se-9", "")).toThrow("people on your team");
    expect(() => assignTargetInScope(tl, "", "team-9")).toThrow("your own team");
    const se = claims({ userId: "se-1", roleCode: "sales_executive", permissions: [P.LeadsEdit] });
    expect(() => assignTargetInScope(se, "se-2", "")).toThrow("missing permission");
  });
});

describe("LeadStageService.move", () => {
  it("moves to Won in one transaction: lead, transition, timeline, audit, automation event", async () => {
    const { f, svc, wake } = service();
    f.queue([lead()], [], [], [], [{ id: "t1", metadata: {} }], [], [], [{ status: "won", nextActivityAt: null }]);

    const out = await svc.move(user, "lead-1", { stageId: WON.id }, META);

    expect(out).toEqual({ leadId: "lead-1", changed: true, status: "won", needsNextActivity: false });
    const q = sqlOf(f);
    expect(q[1]).toMatch(/^UPDATE leads SET pipeline_id = \$1, stage_id = \$2, probability = \$3, status = \$4/);
    expect(f.queries[1]!.parameters.slice(0, 4)).toEqual([PIPE, WON.id, 100, "won"]);
    expect(q[2]).toMatch(/^INSERT INTO lead_stage_transitions/);
    expect(f.queries[2]!.parameters.slice(1, 6)).toEqual(["lead-1", PIPE, CREATED.id, PIPE, WON.id]);
    expect(q[3]).toMatch(/^INSERT INTO timeline_events/);
    expect(q[5]).toMatch(/^insert into "audit_logs"/);
    expect(q[6]).toMatch(/^insert into "automation_events"/);
    expect(f.queries[6]!.parameters).toContain("lead.stage_changed");
    expect(wake).toHaveBeenCalledOnce();
  });

  it("an open lead with no next activity reports needsNextActivity", async () => {
    const { f, svc } = service();
    f.queue([lead()], [], [], [], [{ id: "t1", metadata: {} }], [], [], [{ status: "open", nextActivityAt: null }]);
    const out = await svc.move(user, "lead-1", { stageId: PROPOSAL.id }, META);
    expect(out.needsNextActivity).toBe(true);
  });

  it("the same stage is a no-op", async () => {
    const { f, svc, wake } = service();
    f.queue([lead()], [{ status: "open", nextActivityAt: new Date(Date.now() + 3_600_000) }]);
    const out = await svc.move(user, "lead-1", { stageId: CREATED.id }, META);
    expect(out).toMatchObject({ changed: false, needsNextActivity: false });
    expect(f.queries).toHaveLength(2);
    expect(wake).not.toHaveBeenCalled();
  });

  it("Won and Lost leads must be reopened explicitly", async () => {
    const { f, svc } = service();
    f.queue([lead({ status: "won", stageId: WON.id, stageName: "Won" })]);
    const err = await rejection(svc.move(user, "lead-1", { stageId: PROPOSAL.id }, META));
    expect(err.message).toBe("Lead is closed as Won; reopen it to move");
    expect(err.details).toEqual({ reason: "lead_closed", status: "won" });
    expect(f.queries).toHaveLength(1);
  });

  it("reopening clears the outcome and records the reopen", async () => {
    const { f, svc } = service();
    f.queue(
      [lead({ status: "lost", stageId: LOST.id, stageName: "Lost" })],
      [],
      [],
      [],
      [{ id: "t1", metadata: {} }],
      [],
      [],
      [{ status: "open", nextActivityAt: null }],
    );
    const out = await svc.move(user, "lead-1", { stageId: PROPOSAL.id, reopen: true }, META);
    expect(out.status).toBe("open");
    expect(f.queries[1]!.parameters.slice(0, 4)).toEqual([PIPE, PROPOSAL.id, 60, "open"]);
    expect(String(f.queries[2]!.parameters.at(-1))).toContain('"reopened":true');
  });

  it("Lost requires a reason", async () => {
    const { f, svc } = service();
    f.queue([lead()]);
    expect((await rejection(svc.move(user, "lead-1", { stageId: LOST.id }, META))).message).toBe("lost reason is required");
  });

  it("rejects inactive stages and stages from another pipeline", async () => {
    const { f, svc } = service();
    f.setRows([lead()]);
    expect((await rejection(svc.move(user, "lead-1", { stageId: INACTIVE.id }, META))).message).toBe(
      "target stage is invalid or inactive",
    );
    expect((await rejection(svc.move(user, "lead-1", { stageId: FOREIGN.id }, META))).message).toBe(
      "stage does not belong to the lead's pipeline",
    );
    expect((await rejection(svc.move(user, "lead-1", { stageId: WON.id, pipelineId: OTHER_PIPE }, META))).message).toBe(
      "stage does not belong to the specified pipeline",
    );
  });

  it("reports unmet stage requirements unless forced", async () => {
    const strict = { ...PROPOSAL, requiredFields: ["value"], requiredActivities: ["call"], requiredDocuments: ["passport"] };
    const pipe = { ...PIPELINE, stages: [CREATED, strict] };
    const f = fakeDb();
    const repo = {
      get: async () => pipe,
      getStage: async (id: string) => (id === strict.id ? strict : null),
    } as unknown as PipelinesRepository;
    const svc = new LeadStageService(f.db as unknown as Database, repo, null);
    f.queue([lead()], [], [], []);
    const err = await rejection(svc.move(user, "lead-1", { stageId: strict.id }, META));
    expect(err.message).toBe("Stage requirements not met");
    expect(err.details).toEqual({
      missingActivities: ["call"],
      missingDocuments: ["passport"],
      missingFields: ["value"],
      stageId: strict.id,
      stageName: "Proposal",
    });

    f.queue([lead()], [], [], [], [{ id: "t1", metadata: {} }], [], [], [{ status: "open", nextActivityAt: null }]);
    expect((await svc.move(user, "lead-1", { stageId: strict.id, force: true }, META)).changed).toBe(true);
  });

  it("enforces the caller's leads:edit scope", async () => {
    const { f, svc } = service();
    f.queue([lead()]);
    const own = claims({ userId: "someone", permissions: [P.LeadsEdit], permissionScopes: { [P.LeadsEdit]: "own" } as never });
    expect((await rejection(svc.move({ kind: "user", claims: own }, "lead-1", { stageId: PROPOSAL.id }, META))).status).toBe(403);
  });

  it("automation moves suppress re-triggering automations", async () => {
    const { f, svc } = service();
    f.queue([lead()], [], [], [], [{ id: "t1", metadata: {} }], [], [], [{ status: "open", nextActivityAt: null }]);
    await svc.move({ kind: "automation", actorUserId: null }, "lead-1", { stageId: PROPOSAL.id }, META);
    expect(String(f.queries[6]!.parameters.find((p) => typeof p === "string" && p.startsWith("{")))).toContain(
      '"_suppressAutomation":true',
    );
  });

  it("new leads cannot start in an outcome stage", async () => {
    const { svc } = service();
    await expect(svc.validateInitialStage(PIPE, WON.id)).rejects.toThrow("new leads start in an open stage");
    await expect(svc.validateInitialStage(OTHER_PIPE, CREATED.id)).rejects.toThrow("stage does not belong");
    await expect(svc.validateInitialStage(PIPE, CREATED.id)).resolves.toMatchObject({ id: CREATED.id });
  });
});

describe("LeadStageService.board", () => {
  const scope = { unscoped: true, ownerIds: [], teamIds: [] };
  const filter = { pipelineId: PIPE, search: "", ownerUserId: "", priority: "", source: "", tag: "", activity: "", scope, limit: 1 };
  const card = (id: string, stageId: string) => ({ id, stageId, fullName: id, potentialValue: 100, tags: [] });

  it("groups capped cards under active stages with per-stage totals", async () => {
    const { f, svc } = service();
    f.queue(
      [
        { stageId: CREATED.id, count: 3, totalValue: 300 },
        { stageId: WON.id, count: 1, totalValue: 100 },
      ],
      [card("a", CREATED.id), card("w", WON.id)],
    );
    const board = await svc.board(filter);
    expect(board.pipeline).toEqual({ id: PIPE, name: "Lead Pipeline", kind: "leads", isDefault: true });
    expect(board.stages.map((s) => s.name)).toEqual(["Created", "Proposal", "Won", "Lost"]);
    expect(board.stages[0]).toMatchObject({ count: 3, totalValue: 300, hasMore: true, leads: [card("a", CREATED.id)] });
    expect(board.stages[1]).toMatchObject({ count: 0, totalValue: 0, hasMore: false, leads: [] });
    expect(board.stages[2]).toMatchObject({ count: 1, hasMore: false });
    expect(sqlOf(f)[1]).toContain("ROW_NUMBER() OVER ( PARTITION BY l.stage_id");
  });

  it("rejects sales pipelines and unknown activity filters", async () => {
    const { svc } = service(vi.fn(), { ...PIPELINE, kind: "sales" });
    await expect(svc.board(filter)).rejects.toThrow("pipeline is not a lead pipeline");
    const ok = service();
    await expect(ok.svc.board({ ...filter, activity: "soon" })).rejects.toThrow("invalid activity filter");
  });

  it("applies the same team, value-range and this-week filters to totals and cards", async () => {
    const { f, svc } = service();
    f.queue([], []);
    await svc.board({ ...filter, teamId: "team-1", activity: "week", minValue: 1000, maxValue: 5000 });
    const [totals, cards] = sqlOf(f);
    for (const q of [totals, cards]) {
      expect(q).toContain("l.team_id::text = $");
      expect(q).toContain("l.potential_value >= $");
      expect(q).toContain("l.potential_value <= $");
      expect(q).toContain("INTERVAL '7 days'");
    }
    expect(f.queries[0]!.parameters).toEqual(expect.arrayContaining(["team-1", 1000, 5000]));
  });

  it("loads one more page of a column", async () => {
    const { f, svc } = service();
    f.queue([card("b", CREATED.id), card("c", CREATED.id)]);
    expect(await svc.boardStage({ ...filter, limit: 1 }, CREATED.id, 1)).toEqual({ leads: [card("b", CREATED.id)], hasMore: true });
    expect(f.queries[0]!.parameters.slice(-2)).toEqual([1, 3]);
  });
});

describe("lead insights", () => {
  const all = { vis: { unscoped: true, ownerIds: [], teamIds: [] }, ownerUserId: "" };

  it("forecast buckets by close month, values only the primary currency, and explains its limits", async () => {
    const f = fakeDb();
    f.queue(
      [
        { key: "2026-10", currency: "AUD", count: 2, value: 1000, weighted: 400, noValue: 0 },
        { key: "2026-12", currency: "AUD", count: 1, value: 500, weighted: 300, noValue: 0 },
        { key: "2027-06", currency: "AUD", count: 1, value: 900, weighted: 90, noValue: 0 },
        { key: "2026-10", currency: "NZD", count: 1, value: 7000, weighted: 700, noValue: 0 },
        { key: "no_date", currency: "AUD", count: 3, value: 0, weighted: 0, noValue: 3 },
      ],
      [{ won: 3, closed: 4 }],
    );
    const svc = new LeadInsightsService(f.db as unknown as Database, pipelinesStub());
    const fc = await svc.forecast(all, "", 3, new Date("2026-10-02T00:00:00Z"));
    expect(fc.currency).toBe("AUD");
    expect(fc.buckets.map((b) => [b.key, b.count, b.value])).toEqual([
      ["overdue", 0, 0],
      ["2026-10", 3, 1000],
      ["2026-11", 0, 0],
      ["2026-12", 1, 500],
      ["later", 1, 900],
      ["no_date", 3, 0],
    ]);
    expect(fc.totals).toEqual({ count: 4, value: 1500, weighted: 700, historicalAdjusted: 1125 });
    expect(fc.historicalWinRate).toBe(75);
    expect(fc.limitations).toEqual([
      "Probabilities come from stage defaults, not a predictive model.",
      "3 open leads have no expected close date and are not forecast.",
      "3 open leads have no value and count as zero.",
      "Only 4 leads were won or lost in the last 180 days; the historical win rate is not reliable yet.",
      "Values cover AUD leads only; other currencies are counted but not summed.",
    ]);
  });

  it("owner breakdown ranks by open value and derives win rate and activity counts", async () => {
    const f = fakeDb();
    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";
    f.queue(
      [{ currency: "AUD", openCount: 3, openValue: 900 }],
      [
        { ownerUserId: A, ownerName: "Ann", openLeads: 1, openValue: 100, wonLeads: 0, wonValue: 0, lostLeads: 0 },
        { ownerUserId: B, ownerName: "Bo", openLeads: 2, openValue: 800, wonLeads: 3, wonValue: 1200, lostLeads: 1 },
      ],
      [{ ownerUserId: B, n: 7 }],
    );
    const svc = new LeadInsightsService(f.db as unknown as Database, pipelinesStub());
    const range = parseFilter({ from: "2026-07-01T00:00:00Z", to: "2026-09-30T23:59:59Z" });
    const out = await svc.byOwner(all, "", range.from, range.to);
    expect(out.currency).toBe("AUD");
    expect(out.rows.map((r) => [r.ownerName, r.winRate, r.activities])).toEqual([
      ["Bo", 75, 7],
      ["Ann", null, 0],
    ]);
  });

  const send = async (path: string) => {
    const f = fakeDb();
    queueAuth(f, P.LeadsView);
    return request(createApp({ config: config(), db: f.db })).get(path).set("Authorization", bearer());
  };

  it("my day validates the timezone and the owner", async () => {
    expect((await send("/api/v1/leads/insights/my-day?tz=Mars/Base")).body.error.message).toBe("invalid IANA timezone");
    expect((await send("/api/v1/leads/insights/my-day?owner=bob")).body.error.message).toBe("owner must be me, all, or a user id");
    expect((await send("/api/v1/leads/insights/overview?teamId=x")).body.error.message).toBe("teamId must be a uuid");
  });

  it("insights need leads:view", async () => {
    const f = fakeDb();
    queueAuth(f, P.DealsView);
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/v1/leads/insights/overview").set("Authorization", bearer());
    expect(res.status).toBe(403);
  });
});

describe("lead routes", () => {
  const send = async (perm: string, method: "get" | "post", path: string, body?: unknown) => {
    const f = fakeDb();
    queueAuth(f, perm);
    let req = request(createApp({ config: config(), db: f.db }))[method](path).set("Authorization", bearer());
    if (body !== undefined) req = req.send(body as object);
    return { res: await req, f };
  };

  it("the board requires a pipeline", async () => {
    const { res } = await send(P.LeadsView, "get", "/api/v1/leads/board");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message: "pipelineId is required" });
  });

  it("board columns require a stage", async () => {
    const { res } = await send(P.LeadsView, "get", `/api/v1/leads/board/stage?pipelineId=${PIPE}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("stageId is required");
  });

  it("a Team Lead cannot create a lead owned by someone outside their team", async () => {
    const f = fakeDb();
    f.queue(
      [userRow({ roleCode: "sales_manager", roleName: "Team Lead" })],
      [
        { code: P.LeadsCreate, scope: "team" },
        { code: P.LeadsAssign, scope: "team" },
      ],
      [],
      [],
    );
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send({ fullName: "Asha", source: "Website", ownerUserId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("You can only assign leads to people on your team");
    expect(f.queries).toHaveLength(4);
  });

  it("moves need leads:edit", async () => {
    const { res } = await send(P.LeadsView, "post", "/api/v1/leads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/move", { stageId: "x" });
    expect(res.status).toBe(403);
  });

  it("a leads:view caller may read a lead pipeline but not a sales pipeline", async () => {
    const pipelineRow = (kind: string) => ({ id: PIPE, name: "P", description: "", kind, isDefault: true, isActive: true });
    const lead = fakeDb();
    queueAuth(lead, P.LeadsView);
    lead.queue([pipelineRow("leads")], []);
    const app = createApp({ config: config(), db: lead.db });
    expect((await request(app).get(`/api/v1/pipelines/${PIPE}`).set("Authorization", bearer())).status).toBe(200);

    const sales = fakeDb();
    queueAuth(sales, P.LeadsView);
    sales.queue([pipelineRow("sales")], []);
    const res = await request(createApp({ config: config(), db: sales.db }))
      .get(`/api/v1/pipelines/${PIPE}`)
      .set("Authorization", bearer());
    expect(res.status).toBe(403);
  });
});
