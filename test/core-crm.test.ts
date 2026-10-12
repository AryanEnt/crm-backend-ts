import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { goMapOrNull } from "../src/lib/go-json.js";
import { parseLocalMinute, parseOptionalTime, parseRfc3339 } from "../src/lib/go-time.js";
import { decodeJson, optionalObject } from "../src/lib/validate.js";
import { nextActivitySchema } from "../src/modules/activities/activities.routes.js";
import { isValidTimezone, resolveDisplayStatus } from "../src/modules/activities/activities.service.js";
import { slugifyTypeCode } from "../src/modules/activities/activity-types.service.js";
import { Attention, computeAttention, validAttention } from "../src/modules/attention/attention.js";
import { missingRequiredFields, type Deal } from "../src/modules/deals/deals.service.js";
import { normalizeEmail, normalizePhone, nullIfBlank } from "../src/modules/leads/leads.service.js";
import { isReferralSource } from "../src/modules/referrals/referrals.service.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const H = 3_600_000;
const at = (iso: string) => new Date(iso);

describe("Go time parsing", () => {
  it("RFC3339 honours offsets and rejects out-of-range fields", () => {
    expect(parseRfc3339("2026-01-01T00:00:00+05:45")?.toISOString()).toBe("2025-12-31T18:15:00.000Z");
    expect(parseRfc3339("2026-02-29T00:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-01-01T00:00:00")).toBeNull();
  });

  it("the zone-less minute layout is UTC, with a one- or two-digit hour", () => {
    expect(parseLocalMinute("2030-05-06T8:30")?.toISOString()).toBe("2030-05-06T08:30:00.000Z");
    for (const bad of ["2030-05-06T08:3", "2030-02-30T01:00", "2030-05-06T24:00", "2030-05-06T08:30:00"]) {
      expect(parseLocalMinute(bad)).toBeNull();
    }
  });

  it("parseOptionalTime only accepts the minute layout when asked (activities)", () => {
    expect(parseOptionalTime(" ")).toBeNull();
    expect(() => parseOptionalTime("2030-05-06T07:08")).toThrow("invalid time");
    expect(parseOptionalTime("2030-05-06T07:08", { localMinute: true })?.toISOString()).toBe("2030-05-06T07:08:00.000Z");
    expect(parseOptionalTime(" 2030-05-06 ")?.toISOString()).toBe("2030-05-06T00:00:00.000Z");
  });
});

describe("attention", () => {
  const now = at("2026-09-30T12:00:00Z");
  const base = { closed: false, next: at("2026-10-05T00:00:00Z"), last: now, anchor: null, createdAt: now, slaHours: null, now };

  it("follows Go's precedence", () => {
    expect(computeAttention({ ...base, closed: true, next: null })).toBe("");
    expect(computeAttention({ ...base, next: null })).toBe(Attention.NoNext);
    expect(computeAttention({ ...base, next: now })).toBe(Attention.OverdueNext);
    expect(computeAttention({ ...base, slaHours: 10, anchor: new Date(now.getTime() - 11 * H) })).toBe(Attention.OverSla);
    expect(computeAttention({ ...base, slaHours: 10, anchor: new Date(now.getTime() - 9 * H) })).toBe(Attention.AttentionNeeded);
    expect(computeAttention({ ...base, last: null, createdAt: at("2026-09-20T00:00:00Z") })).toBe(Attention.NoRecentActivity);
    expect(computeAttention(base)).toBe("");
  });

  it("validAttention accepts blank and the known codes only", () => {
    expect(validAttention("")).toBe(true);
    expect(validAttention("over_sla")).toBe(true);
    expect(validAttention("bad")).toBe(false);
  });
});

describe("activities helpers", () => {
  const now = at("2026-09-30T12:00:00Z");

  it("displayStatus derives overdue/due from the due date", () => {
    expect(resolveDisplayStatus("completed", at("2020-01-01T00:00:00Z"), now)).toBe("completed");
    expect(resolveDisplayStatus("due", null, now)).toBe("due");
    expect(resolveDisplayStatus("overdue", null, now)).toBe("upcoming");
    expect(resolveDisplayStatus("upcoming", new Date(now.getTime() - 1), now)).toBe("overdue");
    expect(resolveDisplayStatus("upcoming", new Date(now.getTime() + 24 * H), now)).toBe("due");
    expect(resolveDisplayStatus("due", new Date(now.getTime() + 25 * H), now)).toBe("upcoming");
  });

  it("timezones follow time.LoadLocation, case-sensitively", () => {
    for (const ok of ["UTC", "Local", "Asia/Kathmandu", "US/Eastern", "Etc/GMT+5", "Asia/Calcutta"]) {
      expect(isValidTimezone(ok)).toBe(true);
    }
    for (const bad of ["asia/kathmandu", "etc/gmt+5", "+05:45", "Mars/Base", "utc", ""]) {
      expect(isValidTimezone(bad)).toBe(false);
    }
  });

  it("activity type codes are slugged like the Go admin", () => {
    expect(slugifyTypeCode(" TS Parity go Type!A ")).toBe("ts_parity_go_typea");
    expect(slugifyTypeCode("Ünï Côde")).toBe("n_cde");
    expect(slugifyTypeCode("!!!")).toBe("activity_type");
  });

  it("nested nextActivity keys fold case-insensitively and stay strict", () => {
    const schema = z.strictObject({ nextActivity: optionalObject(nextActivitySchema) });
    const decode = (body: unknown) => decodeJson({ body } as never, schema);
    expect(decode({ NEXTACTIVITY: { DueAt: "2031-01-01" } })).toEqual({
      nextActivity: { title: "", dueAt: "2031-01-01", typeCode: "" },
    });
    expect(decode({ nextActivity: null })).toEqual({ nextActivity: undefined });
    expect(() => decode({ nextActivity: { when: "x" } })).toThrow('json: unknown field "when"');
  });
});

describe("deals helpers", () => {
  const deal = {
    value: null,
    expectedCloseAt: "",
    source: " ",
    priority: "medium",
    notes: "n",
    ownerUserId: "u1",
    fieldValues: { budget: 5, empty: "", nil: null, zero: 0 },
  } as unknown as Deal;

  it("missingRequiredFields checks built-ins, then field values (trimmed keys, blanks skipped)", () => {
    expect(
      missingRequiredFields(deal, ["Value", "expected_close_at", "source", "priority", "notes", "owner", " budget ", "empty", "nil", "zero", "absent", " "]),
    ).toEqual(["Value", "expected_close_at", "source", "empty", "nil", "absent"]);
    expect(missingRequiredFields({ ...deal, fieldValues: null }, ["budget"])).toEqual(["budget"]);
  });
});

describe("shared normalisation", () => {
  it("emails lower-case and trim; blanks become null", () => {
    expect(normalizeEmail("  A@B.Test ")).toBe("a@b.test");
    expect(normalizeEmail(" ")).toBeNull();
    expect(normalizePhone(" 98 ")).toBe("98");
    expect(nullIfBlank(" x ")).toBe(" x ");
    expect(nullIfBlank("  ")).toBeNull();
  });

  it("referral source match is trimmed and case-insensitive", () => {
    expect(isReferralSource(" REFERRAL ")).toBe(true);
    expect(isReferralSource("referrals")).toBe(false);
  });

  it("goMapOrNull mirrors unmarshalling jsonb into map[string]any", () => {
    expect(goMapOrNull(null)).toBeNull();
    expect(goMapOrNull([1])).toEqual({});
    expect(Object.keys(goMapOrNull({ b: 1, a: 2 })!)).toEqual(["a", "b"]);
  });
});

describe("core CRM routes validate before touching data", () => {
  const send = async (perm: string, method: "get" | "post" | "patch", path: string, body?: unknown) => {
    const f = fakeDb();
    queueAuth(f, perm);
    let req = request(createApp({ config: config(), db: f.db }))[method](path).set("Authorization", bearer());
    if (body !== undefined) req = req.send(body as object);
    return { res: await req, f };
  };

  it.each([
    [P.DealsView, "get", "/api/v1/deals/board", undefined, "pipelineId is required"],
    [P.DealsCreate, "post", "/api/v1/deals", {}, "customerId and title are required"],
    [P.ActivitiesCreate, "post", "/api/v1/activities", { title: "x" }, "activity type is required"],
    [P.ActivitiesView, "get", "/api/v1/activities/calendar?from=2026-01-01", undefined, "from and to are required"],
    [P.ActivitiesView, "get", "/api/v1/activities?from=soon", undefined, "invalid from"],
    [P.ActivitiesView, "get", "/api/v1/activities/follow-up", undefined, "leadId, customerId, or dealId is required"],
    [P.LeadsView, "patch", "/api/v1/me/timezone", { timezone: "+05:45" }, "invalid IANA timezone"],
    [P.LeadsView, "patch", "/api/v1/me/timezone", { timezone: " " }, "timezone is required"],
  ] as const)("%s %s %s -> 400", async (perm, method, path, body, message) => {
    const { res, f } = await send(perm, method, path, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message });
    expect(f.queries.length).toBe(4);
  });

  it("deal moves need deals:edit", async () => {
    const { res } = await send(P.DealsView, "post", "/api/v1/deals/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/move", { stageId: "x" });
    expect(res.status).toBe(403);
  });
});
