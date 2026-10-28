import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { goFixed } from "../src/lib/go-fmt.js";
import { AppError } from "../src/lib/app-error.js";
import { parseFilter } from "../src/modules/analytics/analytics.filter.js";
import { P, type Scope } from "../src/modules/permissions/permissions.js";
import {
  DISCLAIMER,
  explanationJson,
  LeadScoreStrategy,
  resultJson,
  signalJson,
} from "../src/modules/predictions/predictions.strategies.js";
import { authorizeExisting, authorizeWrite, validateInput, type Target } from "../src/modules/targets/targets.service.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { claims } from "./helpers/claims.js";
import { fakeDb } from "./helpers/fake-db.js";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? { status: e.status, message: e.message } : e;
  }
  return null;
};

describe("goFixed", () => {
  it("rounds exact binary ties to even, like Go's %.Nf", () => {
    expect(goFixed(0.5, 0)).toBe("0");
    expect(goFixed(1.5, 0)).toBe("2");
    expect(goFixed(2.5, 0)).toBe("2");
    expect(goFixed(12.5, 0)).toBe("12");
    expect(goFixed(-2.5, 0)).toBe("-2");
    expect(goFixed(0.125, 2)).toBe("0.12");
    expect(goFixed(0.375, 2)).toBe("0.38");
  });

  it("matches toFixed when the value is not an exact tie", () => {
    expect(goFixed(1.005, 2)).toBe("1.00");
    expect(goFixed(33.35, 1)).toBe((33.35).toFixed(1));
    expect(goFixed(66.666, 1)).toBe("66.7");
    expect(goFixed(100, 1)).toBe("100.0");
  });
});

describe("analytics filter", () => {
  const now = new Date("2026-09-30T10:20:30.456Z");

  it("defaults to the last 90 days", () => {
    const f = parseFilter({}, now);
    expect(JSON.parse(JSON.stringify({ from: f.from, to: f.to }))).toEqual({
      from: "2026-07-02T10:20:30.456Z",
      to: "2026-09-30T10:20:30.456Z",
    });
    expect(f).toMatchObject({ groupBy: "user", period: "month", sortDir: "desc", scopeUserIds: null });
  });

  it("a date-only end covers the whole day with Go's nanosecond precision", () => {
    const f = parseFilter({ from: " 2026-01-01 ", to: "2026-01-31" }, now);
    expect(f.from.toJSON()).toBe("2026-01-01T00:00:00Z");
    expect(f.to.toJSON()).toBe("2026-01-31T23:59:59.999999999Z");
    expect(f.to.sql).toBe("2026-01-31T23:59:59.999999Z");
  });

  it("an RFC3339 bound is converted to UTC and a lone end starts at the epoch", () => {
    const f = parseFilter({ to: "2026-02-01T05:45:00+05:45", sortDir: "ASC" }, now);
    expect(f.from.toJSON()).toBe("1970-01-01T00:00:00Z");
    expect(f.to.toJSON()).toBe("2026-02-01T00:00:00Z");
    expect(f.sortDir).toBe("asc");
  });

  it.each(["yesterday", "2026-13-01", "01/02/2026"])("rejects %s", (from) => {
    expect(errorOf(() => parseFilter({ from }, now))).toEqual({
      status: 400,
      message: "invalid date; use YYYY-MM-DD or RFC3339",
    });
  });
});

describe("target policy", () => {
  const scoped = (scope: Scope, extra = {}) =>
    claims({
      userId: "u1",
      teamIds: ["t1"],
      teamMemberUserIds: ["u2"],
      permissions: [P.TargetsManage],
      permissionScopes: { [P.TargetsManage]: scope },
      ...extra,
    });

  it("organization scope may write any target as given", () => {
    expect(authorizeWrite(scoped("organization"), "organization", null, null)).toBeNull();
    expect(authorizeWrite(scoped("organization"), "team", "t9", null)).toBe("t9");
  });

  it("team leads are pinned to their team", () => {
    const lead = scoped("team");
    expect(authorizeWrite(lead, "team", "", null)).toBe("t1");
    expect(authorizeWrite(lead, "user", null, " u2 ")).toBeNull();
    expect(errorOf(() => authorizeWrite(lead, "team", "t9", null))).toEqual({
      status: 403,
      message: "you can only set targets for your own team",
    });
    expect(errorOf(() => authorizeWrite(lead, "user", null, "u9"))).toEqual({
      status: 403,
      message: "you can only set targets for members of your team",
    });
    expect(errorOf(() => authorizeWrite(lead, "organization", null, null))).toEqual({
      status: 403,
      message: "organization targets can only be set by an administrator with organization scope",
    });
    expect(errorOf(() => authorizeWrite(scoped("team", { teamIds: ["t1", "t2"] }), "team", "", null))).toEqual({
      status: 400,
      message: "teamId is required for team targets",
    });
    expect(errorOf(() => authorizeWrite(scoped("team", { teamIds: [] }), "team", "t1", null))).toEqual({
      status: 403,
      message: "you are not assigned to a team",
    });
    expect(errorOf(() => authorizeWrite(scoped("own"), "user", null, "u1"))).toEqual({
      status: 403,
      message: "you cannot manage targets",
    });
  });

  it("existing targets must belong to the lead's team or a teammate", () => {
    const t = (over: Partial<Target>) => ({ scopeType: "team", teamId: null, userId: null, ...over }) as Target;
    expect(() => authorizeExisting(scoped("team"), t({ teamId: "t1" }))).not.toThrow();
    expect(() => authorizeExisting(scoped("team"), t({ scopeType: "user", userId: "u2" }))).not.toThrow();
    expect(errorOf(() => authorizeExisting(scoped("team"), t({ teamId: "t9" })))).toEqual({
      status: 403,
      message: "this target belongs to another team",
    });
  });

  it("validates input in Go's order", () => {
    const v = (over: Partial<Record<string, unknown>> = {}) => {
      const a = { metric: "leads", periodType: "monthly", scopeType: "team", start: "2026-09-01", end: "2026-09-30", team: "t1", user: null, value: 1, ...over };
      return errorOf(() => validateInput(a.metric as string, a.periodType as string, a.scopeType as string, a.start as string, a.end as string, a.team as string | null, a.user as string | null, a.value as number));
    };
    expect(v()).toBeNull();
    expect(v({ periodType: "daily", start: "2026-10-28", end: "2026-10-28" })).toBeNull();
    expect(v({ metric: "calls", periodType: "weekly" })).toMatchObject({ message: "invalid metric" });
    expect(v({ periodType: "weekly" })).toMatchObject({ message: "periodType must be daily, monthly or quarterly" });
    expect(v({ scopeType: "region" })).toMatchObject({ message: "invalid scopeType" });
    expect(v({ start: "09/01/2026" })).toMatchObject({ message: "invalid periodStart" });
    expect(v({ end: "2026-02-30" })).toMatchObject({ message: "invalid periodEnd" });
    expect(v({ end: "2026-08-31" })).toMatchObject({ message: "periodEnd must be on or after periodStart" });
    expect(v({ value: -1 })).toMatchObject({ message: "targetValue cannot be negative" });
    expect(v({ team: " " })).toMatchObject({ message: "teamId is required for team targets" });
    expect(v({ scopeType: "user" })).toMatchObject({ message: "userId is required for individual targets" });
  });
});

describe("prediction JSON shapes", () => {
  it("follows Go struct order and omitempty", () => {
    expect(Object.keys(signalJson({ code: "c", label: "l", impact: 0, polarity: "neutral", detail: "" }))).toEqual([
      "code", "label", "impact", "polarity",
    ]);
    expect(explanationJson({ summary: "", positiveSignals: null, negativeSignals: [], neutralNotes: [] })).toEqual({
      summary: "",
      positiveSignals: null,
      negativeSignals: [],
    });
  });

  it("lead score keeps a zero score, drops an empty message and sorts payload keys", () => {
    const r = LeadScoreStrategy.score({ entityType: "lead", entityId: "l1", features: { ageDays: 90, daysSinceActivity: 40, docsRequested: 2, overdueFollowups: 3 } });
    const json = resultJson(r);
    expect(Object.keys(json)).toEqual([
      "available", "disclaimer", "insightType", "entityType", "entityId", "score", "label", "strategyCode",
      "strategyVersion", "features", "explanation", "payload", "computedAt", "insufficientHistoricalData",
    ]);
    expect(json).toMatchObject({ available: true, disclaimer: DISCLAIMER, score: 0, label: "Cold", payload: { band: "Cold" } });
    expect(json.computedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const expl = json.explanation as { summary: string; positiveSignals: unknown[]; neutralNotes: string[] };
    expect(expl.summary).toBe("Score: 0 — cold lead based on configurable CRM signals.");
    expect(expl.positiveSignals).toEqual([]);
    expect(expl.neutralNotes[0]).toMatch(/^Insufficient historical data\./);
  });
});

describe("reporting routes validate before touching data", () => {
  const app = (f: ReturnType<typeof fakeDb>) => createApp({ config: config(), db: f.db });

  it.each([
    [P.AnalyticsView, "/api/v1/analytics/summary?from=yesterday", "invalid date; use YYYY-MM-DD or RFC3339"],
    [P.ForecastsView, "/api/v1/forecasts/pipeline", "pipelineId is required"],
    [P.ForecastsView, "/api/v1/forecasts/pipeline?pipelineId=p&historyTo=x", "invalid historyTo"],
    [P.PredictionsView, "/api/v1/predictions/pipeline-risk?pipelineId=%20", "pipelineId is required"],
    [P.PredictionsView, "/api/v1/predictions/workload?ownerUserId=%20", "ownerUserId is required"],
  ] as const)("%s GET %s -> 400", async (perm, url, message) => {
    const f = fakeDb();
    queueAuth(f, perm);
    const res = await request(app(f)).get(url).set("Authorization", bearer());
    expect(res.body.error).toMatchObject({ code: "validation_error", message });
    expect(res.status).toBe(400);
    expect(f.queries.length).toBe(4);
  });

  it("target creation validates before writing", async () => {
    const f = fakeDb();
    queueAuth(f, P.TargetsManage);
    const res = await request(app(f))
      .post("/api/v1/targets")
      .set("Authorization", bearer())
      .send({ metric: "calls", periodType: "monthly", periodStart: "2026-09-01", periodEnd: "2026-09-30", scopeType: "organization", targetValue: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("invalid metric");
    expect(f.queries.length).toBe(4);
  });

  it("static catalogs need no queries", async () => {
    for (const [perm, url] of [
      [P.TargetsView, "/api/v1/targets/metrics"],
      [P.ForecastsView, "/api/v1/forecasts/methodology"],
      [P.PredictionsView, "/api/v1/predictions/catalog"],
    ] as const) {
      const f = fakeDb();
      queueAuth(f, perm);
      const res = await request(app(f)).get(url).set("Authorization", bearer());
      expect(res.status).toBe(200);
      expect(f.queries.length).toBe(4);
    }
  });
});
