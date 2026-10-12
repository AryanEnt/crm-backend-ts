import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

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
