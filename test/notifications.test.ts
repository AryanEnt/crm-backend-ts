import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { dayLabel, daysFromHours, slaDedupeKey, slaExceededCopy, slaLimitDays } from "../src/modules/notifications/sla-copy.js";
import { parseScanMinutes } from "../src/modules/notifications/sla-scan.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("sla copy", () => {
  it("explains how far past the stage limit the lead has gone", () => {
    const copy = slaExceededCopy({
      leadName: "Acme Australia",
      stageName: "Contacted",
      hoursInStage: 6 * 24,
      slaHours: 5 * 24,
      ownerName: "Sarah",
    });
    expect(copy.title).toBe("Lead SLA exceeded");
    expect(copy.body).toBe("Acme Australia has remained in Contacted for 6 days, exceeding its 5-day SLA by 1 day.");
  });

  it("rounds duration to whole days and keeps a stable dedupe key", () => {
    expect(daysFromHours(120)).toBe(5);
    expect(slaLimitDays(120)).toBe(5);
    expect(dayLabel(1)).toBe("1 day");
    const entered = new Date("2026-10-01T00:00:00.000Z");
    expect(slaDedupeKey("lead-1", "stage-1", entered)).toBe("lead_sla:lead-1:stage-1:2026-10-01T00:00:00.000Z");
  });

  it("clamps the scan interval", () => {
    expect(parseScanMinutes(undefined)).toBe(15);
    expect(parseScanMinutes("0")).toBe(1);
    expect(parseScanMinutes("90")).toBe(60);
    expect(parseScanMinutes("15")).toBe(15);
  });
});

const note = (overrides: Record<string, unknown> = {}) => ({
  id: "n1",
  recipientUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  type: "lead_sla_exceeded",
  title: "Lead SLA exceeded",
  body: "Acme has remained in Contacted for 6 days, exceeding its 5 days SLA by 1 day.",
  leadId: "l1",
  payload: { leadName: "Acme", stageName: "Contacted" },
  dedupeKey: "lead_sla:l1:s1:2026-10-01T00:00:00.000Z",
  readAt: null,
  createdAt: new Date("2026-10-29T00:00:00.000Z"),
  ...overrides,
});

describe("notification APIs", () => {
  it("lists only the authenticated user's inbox", async () => {
    const f = fakeDb();
    queueAuth(f);
    f.queue([{ n: 1 }], [note()]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/notifications")
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
    const listSql = String(f.queries.at(-1)?.sql ?? "");
    expect(listSql).toContain("recipient_user_id");
  });

  it("returns an unread count", async () => {
    const f = fakeDb();
    queueAuth(f);
    f.queue([{ n: 3 }]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/notifications/unread-count")
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.unread).toBe(3);
  });

  it("marks one notification read for the recipient", async () => {
    const f = fakeDb();
    queueAuth(f);
    f.queue([note({ readAt: new Date("2026-10-29T01:00:00.000Z") })]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/notifications/n1/read")
      .set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.readAt).toBeTruthy();
    expect(String(f.queries.at(-1)?.sql ?? "")).toContain("recipient_user_id");
  });

  it("rejects unknown types", async () => {
    const f = fakeDb();
    queueAuth(f);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/notifications?type=email")
      .set("Authorization", bearer());
    expect(res.status).toBe(400);
  });
});
