import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/lib/app-error.js";
import { goFloatV, goQuote, goV } from "../src/lib/go-fmt.js";
import { pgxMessage } from "../src/lib/pgx.js";
import {
  actionResultJson,
  decodeActions,
  decodeConditions,
  matchConditions,
  validateDefinition,
  type Action,
  type Condition,
} from "../src/modules/automation/automation.definition.js";
import {
  applyTemplate,
  AutomationExecutor as AutomationExecutorImpl,
  stripHtml,
} from "../src/modules/automation/automation.executor.js";
import type { Automation, AutomationRepository, Job, Run } from "../src/modules/automation/automation.repository.js";
import { automationJson, backoffMs } from "../src/modules/automation/automation.repository.js";
import { AutomationWorker } from "../src/modules/automation/automation.worker.js";
import type { AutomationExecutor } from "../src/modules/automation/automation.executor.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const validationMessage = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError && e.status === 400 ? e.message : e;
  }
  return null;
};

describe("Go formatting", () => {
  it("%v of floats uses exponent form below 1e-4 and from 1e6", () => {
    const cases: [number, string][] = [
      [1e6, "1e+06"], [1234567, "1.234567e+06"], [123456, "123456"], [1.5e6, "1.5e+06"], [0.0001, "0.0001"],
      [0.00001, "1e-05"], [1e20, "1e+20"], [1e21, "1e+21"], [15.234567891234, "15.234567891234"], [100, "100"],
      [-0.5, "-0.5"], [2.5e-7, "2.5e-07"], [-1234567, "-1.234567e+06"],
    ];
    for (const [v, want] of cases) expect(goFloatV(v)).toBe(want);
  });

  it("%v of JSON values", () => {
    expect(goV(null)).toBe("<nil>");
    expect(goV(["a", 1, true])).toBe("[a 1 true]");
    expect(goV({ b: 1, a: "x" })).toBe("map[a:x b:1]");
    expect(goV([])).toBe("[]");
  });

  it("%q escapes like strconv.Quote", () => {
    expect(goQuote('a"b')).toBe('"a\\"b"');
    expect(goQuote("ü\x01\t")).toBe('"ü\\x01\\t"');
    expect(goQuote("é😀")).toBe('"é😀"');
    expect(goQuote("\u200b")).toBe('"\\u200b"');
    expect(goQuote("\x7f\u00a0")).toBe('"\\x7f\\u00a0"');
  });

  it("pgx formats Postgres errors with severity and SQLSTATE", () => {
    const err = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { severity: "ERROR", code: "22P02" });
    expect(pgxMessage(err)).toBe('ERROR: invalid input syntax for type uuid: "x" (SQLSTATE 22P02)');
    expect(pgxMessage(new Error("plain"))).toBe("plain");
  });
});

describe("automation definitions", () => {
  const action = (type: string, params: Record<string, unknown> | null = {}): Action => ({ type, params });
  const cond = (field: string, operator: string, value: unknown): Condition => ({ field, operator, value });

  it("validates in Go's order with Go's messages", () => {
    const ok = [action("add_tag", { tag: "x" })];
    expect(validationMessage(() => validateDefinition("lead.deleted", [], ok))).toBe("unsupported WHEN trigger: lead.deleted");
    expect(validationMessage(() => validateDefinition("lead.created", [], []))).toBe("at least one THEN action is required");
    expect(validationMessage(() => validateDefinition("lead.created", [cond("colour", "", 1)], ok))).toBe(
      'condition 1: unsupported IF field "colour"',
    );
    expect(validationMessage(() => validateDefinition("lead.created", [cond("owner", "", 1), cond("stage", "like", 1)], ok))).toBe(
      'condition 2: unsupported operator "like"',
    );
    expect(validationMessage(() => validateDefinition("lead.created", [cond("owner", "", null)], ok))).toBe("condition 1: value is required");
    expect(validationMessage(() => validateDefinition("lead.created", [], [action("fly")]))).toBe('action 1: unsupported THEN type "fly"');
    expect(validationMessage(() => validateDefinition("lead.created", [], [action("create_task", null)]))).toBe(
      "action 1: create_task requires title",
    );
    expect(validationMessage(() => validateDefinition("lead.created", [], [action("update_field", { field: "owner" })]))).toBe(
      'action 1: update_field field "owner" is not allowed',
    );
    expect(validationMessage(() => validateDefinition("lead.created", [], [action("create_activity", { subject: "s" })]))).toBeNull();
    expect(validationMessage(() => validateDefinition("lead.created", [], [action("create_task", { title: 5 })]))).toBeNull();
  });

  it("matches conditions with Go's stringify and explanations", () => {
    const ctx = { priority: "high", dealValue: 1500000, inactivityDays: 3.5, tags: ["a", "b"], source: "Web Form" };
    expect(matchConditions([], ctx)).toEqual({ matched: true, detail: "no conditions" });
    expect(matchConditions([cond("priority", "", "high"), cond("deal_value", "eq", 1500000)], ctx)).toEqual({
      matched: true,
      detail: "all conditions matched",
    });
    expect(matchConditions([cond("priority", "eq", "low")], ctx).detail).toBe("priority is high, expected low");
    expect(matchConditions([cond("deal_value", "gte", 2000000)], ctx).detail).toBe("deal_value=1.5e+06 is below 2e+06");
    expect(matchConditions([cond("inactivity_days", "lte", "2 days")], ctx).detail).toBe("inactivity_days=3.5 is above 2 days");
    expect(matchConditions([cond("owner", "eq", "u1")], ctx).detail).toBe("owner is <nil>, expected u1");
    expect(matchConditions([cond("priority", "in", ["low", "mid"])], ctx).detail).toBe("priority=high not in list");
    expect(matchConditions([cond("priority", "in", "high")], ctx).matched).toBe(true);
    expect(matchConditions([cond("source", "contains", "web")], ctx).matched).toBe(true);
    expect(matchConditions([cond("priority", "neq", "high")], ctx).detail).toBe("priority is high, excluded value");
  });

  it("decodes stored definitions like json.Unmarshal into Go structs", () => {
    expect(decodeConditions({ not: "an array" })).toEqual([]);
    expect(decodeConditions([{ field: "owner", value: { b: 1, a: 2 }, extra: 1 }, null])).toEqual([
      { field: "owner", operator: "", value: { b: 1, a: 2 } },
      { field: "", operator: "", value: null },
    ]);
    expect(decodeActions([{ type: "add_tag" }, { type: "x", params: "nope" }])).toEqual([
      { type: "add_tag", params: null },
      { type: "x", params: null },
    ]);
    expect(actionResultJson({ type: "t", status: "succeeded", detail: "", error: "", payload: {} })).toEqual({ type: "t", status: "succeeded" });
  });

  it("serializes automations in Go field order with omitempty authors", () => {
    const a: Automation = {
      id: "a1", name: "n", description: "", isActive: true, triggerType: "lead.created",
      conditions: [{ field: "owner", operator: "eq", value: "u" }], actions: [{ type: "add_tag", params: { z: 1, a: { d: 1, c: 2 } } }],
      createdBy: null, updatedBy: "u2", createdAt: new Date("2026-09-30T01:02:03.456Z"), updatedAt: new Date("2026-09-30T01:02:03Z"),
    };
    const json = automationJson(a);
    expect(Object.keys(json)).toEqual(["id", "name", "description", "isActive", "triggerType", "conditions", "actions", "updatedBy", "createdAt", "updatedAt"]);
    expect(JSON.stringify(json.actions)).toBe('[{"type":"add_tag","params":{"a":{"c":2,"d":1},"z":1}}]');
    expect(json.createdAt).toBe("2026-09-30T01:02:03Z");
  });

  it("templates resolve only known, non-empty variables", () => {
    const vars = { first_name: "Asha", last_name: "" };
    expect(applyTemplate("Hi {{ first_name }} {{last_name}} {{constructor}}", vars)).toBe("Hi Asha {{last_name}} {{constructor}}");
    expect(stripHtml("<p>Hello\u00a0<b>there</b></p>\n\u0085 x\ufeff")).toBe("Hello there x\ufeff");
  });

  it("backs off 30s, 2m, 10m, then 30m", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([30_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000]);
  });
});

describe("automation worker", () => {
  const auto = (over: Partial<Automation> = {}): Automation => ({
    id: "a1", name: "Rule", description: "", isActive: true, triggerType: "lead.created",
    conditions: [], actions: [{ type: "add_tag", params: { tag: "x" } }],
    createdBy: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  const job = (over: Partial<Job> = {}): Job => ({
    id: "j1", eventId: "e1", automationId: "a1", triggerType: "lead.created", resourceType: "lead", resourceId: "l1",
    payload: { source: "payload", extra: 1 }, status: "processing", attempts: 0, maxAttempts: 5,
    nextAttemptAt: new Date(), lastError: "", createdAt: new Date(), ...over,
  });

  function harness(a: Automation | null, ctx: Record<string, unknown> | Error, results = [{ type: "add_tag", status: "succeeded" }]) {
    const runs: Run[] = [];
    const seen: Record<string, unknown>[] = [];
    const repo = {
      get: async () => a,
      insertRun: async (r: Run) => void runs.push(r),
      loadEntityContext: async () => {
        if (ctx instanceof Error) throw ctx;
        return { ...ctx };
      },
    } as unknown as AutomationRepository;
    const executor = {
      execute: async (_a: Automation, c: Record<string, unknown>) => {
        seen.push(c);
        const failure = results.find((r) => r.status === "failed") as { type: string; error?: string } | undefined;
        return { results, error: failure ? `${failure.type}: ${failure.error ?? ""}` : "" };
      },
    } as unknown as AutomationExecutor;
    return { worker: new AutomationWorker(repo, executor), runs, seen };
  }

  it("skips inactive automations and unmet conditions without failing the job", async () => {
    let h = harness(auto({ isActive: false }), {});
    expect(await h.worker.runJob(job())).toBeNull();
    expect(h.runs[0]).toMatchObject({ status: "skipped", errorMessage: "automation inactive", conditionsMatched: false });

    h = harness(auto({ conditions: [{ field: "priority", operator: "eq", value: "high" }] }), { priority: "low" });
    expect(await h.worker.runJob(job())).toBeNull();
    expect(h.runs[0]).toMatchObject({ status: "skipped", errorMessage: "priority is low, expected high" });
  });

  it("merges payload facts under entity facts and reports action failures", async () => {
    const h = harness(auto(), { source: "entity" }, [
      { type: "add_tag", status: "succeeded" },
      { type: "change_stage", status: "failed", error: "cannot change stage: entity has no pipeline" } as never,
    ]);
    expect(await h.worker.runJob(job())).toBe("change_stage: cannot change stage: entity has no pipeline");
    expect(h.seen[0]).toMatchObject({ source: "entity", extra: 1 });
    expect(h.runs[0]).toMatchObject({ status: "failed", conditionsMatched: true, errorMessage: "change_stage: cannot change stage: entity has no pipeline" });
  });

  it("fails the job when the record cannot be loaded or the automation is gone", async () => {
    let h = harness(auto(), new Error("no rows in result set"));
    expect(await h.worker.runJob(job())).toBe("no rows in result set");
    expect(h.runs[0]).toMatchObject({ status: "failed", conditionsMatched: true, errorMessage: "no rows in result set" });

    h = harness(null, {});
    expect(await h.worker.runJob(job())).toBe("automation not found");
    expect(await h.worker.runJob(job({ automationId: null }))).toBe("job missing automation");
    expect(h.runs).toHaveLength(0);
  });
});

describe("automation executor on leads", () => {
  const rule: Automation = {
    id: "a1", name: "Rule", description: "", isActive: true, triggerType: "lead.created", conditions: [], actions: [],
    createdBy: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const setup = (move: (...args: unknown[]) => Promise<unknown>) => {
    const f = fakeDb();
    const repo = { stageBelongsToPipeline: async () => true } as unknown as AutomationRepository;
    const audit = { record: async () => undefined } as never;
    const calls: unknown[][] = [];
    const leadStages = {
      move: async (...args: unknown[]) => {
        calls.push(args);
        return move(...args);
      },
    } as never;
    return { f, calls, executor: new AutomationExecutorImpl(f.db as never, repo, audit, leadStages) };
  };

  it("change_stage moves leads through the lead stage service", async () => {
    const { f, calls, executor } = setup(async () => ({ changed: true }));
    const { results } = await executor.execute(
      { ...rule, actions: [{ type: "change_stage", params: { stageId: "s-won" } }] },
      { pipelineId: "p1" },
      "lead",
      "l1",
    );
    expect(results[0]).toMatchObject({ type: "change_stage", status: "succeeded" });
    expect(calls[0]!.slice(0, 3)).toEqual([
      { kind: "automation", actorUserId: null },
      "l1",
      { stageId: "s-won", pipelineId: "p1", lostReason: "Automation: Rule" },
    ]);
    expect(f.queries).toHaveLength(0);
  });

  it("move validation failures fail the action instead of the job", async () => {
    const { executor } = setup(async () => {
      throw AppError.validation("Lead is closed as Won; reopen it to move");
    });
    const { results, error } = await executor.execute(
      { ...rule, actions: [{ type: "change_stage", params: { stageId: "s1" } }] },
      { pipelineId: "p1" },
      "lead",
      "l1",
    );
    expect(results[0]).toEqual({ type: "change_stage", status: "failed", error: "Lead is closed as Won; reopen it to move" });
    expect(error).toBe("change_stage: Lead is closed as Won; reopen it to move");
  });

  it("update_field cannot close a lead", async () => {
    const { f, executor } = setup(async () => ({}));
    const { results } = await executor.execute(
      { ...rule, actions: [{ type: "update_field", params: { field: "status", value: "won" } }] },
      {},
      "lead",
      "l1",
    );
    expect(results[0]).toMatchObject({ status: "failed", error: "use change_stage to close a lead as Won or Lost" });
    expect(f.queries).toHaveLength(0);
  });
});

describe("automation worker flag", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const load = (env: Record<string, string>) => {
    process.env = { ...saved, DATABASE_URL: "postgres://x", JWT_SECRET: "s", GO_BACKEND_URL: "", AUTOMATION_WORKER: "", ...env };
    return loadConfig().automationWorker;
  };

  it("defaults to on only when there is no Go backend", () => {
    expect(load({})).toBe(true);
    expect(load({ GO_BACKEND_URL: "http://go:8080" })).toBe(false);
    expect(load({ GO_BACKEND_URL: "http://go:8080", AUTOMATION_WORKER: "true" })).toBe(true);
    expect(load({ AUTOMATION_WORKER: "off" })).toBe(false);
    expect(() => load({ AUTOMATION_WORKER: "maybe" })).toThrow('AUTOMATION_WORKER must be true or false, got "maybe"');
  });
});

describe("automation routes validate before writing", () => {
  const app = (f: ReturnType<typeof fakeDb>) => createApp({ config: config(), db: f.db });
  const post = async (body: unknown) => {
    const f = fakeDb();
    queueAuth(f, P.AutomationsManage);
    const res = await request(app(f)).post("/api/v1/automations").set("Authorization", bearer()).send(body as object);
    return { res, queries: f.queries.length };
  };

  it.each([
    [{ name: " ", triggerType: "lead.created" }, "name is required"],
    [{ name: "x", triggerType: "nope", actions: [{ type: "add_tag", params: { tag: "t" } }] }, "unsupported WHEN trigger: nope"],
    [{ name: "x", triggerType: "lead.created", actions: null }, "at least one THEN action is required"],
    [{ name: "x", triggerType: "lead.created", actions: [{ type: "add_tag", params: {}, extra: 1 }] }, 'invalid JSON body: json: unknown field "extra"'],
    [{ name: "x", triggerType: "lead.created", conditions: [{ field: "owner" }], actions: [{ type: "add_tag", params: { tag: "t" } }] }, "condition 1: value is required"],
    [{ name: "x", triggerType: "lead.created", conditions: [null], actions: [{ type: "add_tag", params: { tag: "t" } }] }, 'condition 1: unsupported IF field ""'],
    [{ name: "x", triggerType: "lead.created", actions: [null] }, 'action 1: unsupported THEN type ""'],
  ])("POST %j -> 400", async (body, message) => {
    const { res, queries } = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message });
    expect(queries).toBe(4);
  });

  it("the catalog is static", async () => {
    const f = fakeDb();
    queueAuth(f, P.AutomationsView);
    const res = await request(app(f)).get("/api/v1/automations/catalog").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.triggers.map((t: { code: string }) => t.code)).toEqual([
      "lead.created",
      "lead.assigned",
      "lead.stage_changed",
      "lead.inactive",
      "activity.completed",
      "activity.overdue",
      "document.uploaded",
    ]);
    expect(res.body.data.conditions.map((c: { code: string }) => c.code)).toContain("lead_value");
    expect(res.body.data.conditions.map((c: { code: string }) => c.code)).not.toContain("deal_value");
    expect(f.queries.length).toBe(4);
  });
});
