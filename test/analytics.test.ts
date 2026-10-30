import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("analytics country population", () => {
  it("requires analytics:view and returns country aggregates", async () => {
    const f = fakeDb();
    queueAuth(f, P.AnalyticsView);
    f.queue(
      [
        {
          country: "Australia",
          total: 10,
          newCount: 4,
          contacted: 2,
          qualified: 3,
          unqualified: 1,
          won: 2,
          lost: 1,
        },
        {
          country: "(Unknown)",
          total: 2,
          newCount: 1,
          contacted: 0,
          qualified: 0,
          unqualified: 1,
          won: 0,
          lost: 1,
        },
      ],
      [],
    );

    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/analytics/countries?from=2026-01-01&to=2026-01-31")
      .set("Authorization", bearer());

    expect(res.status).toBe(200);
    expect(res.body.data.kpis).toMatchObject({
      totalLeads: 12,
      newLeads: 5,
      qualifiedLeads: 3,
    });
    expect(res.body.data.countries).toHaveLength(2);
    expect(res.body.data.countries[0]).toMatchObject({
      country: "Australia",
      totalLeads: 10,
      sharePct: 83.33,
    });
    expect(res.body.data.countryField).toBe("country");
    expect(f.queries.some((q) => q.sql.includes("l.country"))).toBe(true);
  });

  it("rejects callers without analytics:view", async () => {
    const f = fakeDb();
    queueAuth(f);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/analytics/countries")
      .set("Authorization", bearer());
    expect(res.status).toBe(403);
  });
});

describe("analytics team breakdown by pipeline", () => {
  const get = async (query: string) => {
    const f = fakeDb();
    queueAuth(f, P.AnalyticsView);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get(`/api/v1/analytics/teams?${query}`)
      .set("Authorization", bearer());
    return { res, f };
  };

  it("fails like Go when sorting by deals", async () => {
    const { res, f } = await get("groupBy=pipeline&sortBy=deals");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: "internal_error", message: "failed to load team analytics" });
    expect(f.queries.length).toBe(4);
  });

  it("orders by won deals, and by open value for any other sort", async () => {
    let { res, f } = await get("groupBy=pipeline&sortBy=wonDeals&sortDir=asc");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ groupBy: "pipeline", sortBy: "wonDeals", rows: [] });
    expect(f.queries[4]!.sql).toMatch(/ORDER BY COUNT\(\*\) FILTER \(WHERE d\.status='won'\) ASC NULLS LAST/);

    ({ res, f } = await get("groupBy=pipeline&sortBy=leadVolume"));
    expect(res.status).toBe(200);
    expect(f.queries[4]!.sql).toMatch(/ORDER BY COALESCE\(SUM\(d\.value\) FILTER \(WHERE d\.status='open'\),0\) DESC NULLS LAST/);
  });
});
