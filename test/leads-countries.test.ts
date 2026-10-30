import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("lead countries facet", () => {
  it("returns scoped country counts and ignores the country filter param", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsView);
    f.queue([
      { country: "Australia", count: 12 },
      { country: "Nepal", count: 5 },
      { country: "(Unknown)", count: 2 },
    ]);

    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/leads/countries?status=all&country=Australia")
      .set("Authorization", bearer());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { country: "Australia", count: 12 },
      { country: "Nepal", count: 5 },
      { country: "(Unknown)", count: 2 },
    ]);
    const sql = f.queries.map((q) => q.sql).join("\n");
    expect(sql).toMatch(/GROUP BY/i);
    expect(sql).toMatch(/\(Unknown\)/);
    // Facet query must not also constrain by the selected country.
    expect(sql).not.toMatch(/l\.country = \$/);
  });

  it("requires leads:view", async () => {
    const f = fakeDb();
    queueAuth(f);
    const res = await request(createApp({ config: config(), db: f.db }))
      .get("/api/v1/leads/countries")
      .set("Authorization", bearer());
    expect(res.status).toBe(403);
  });
});

describe("lead create client details", () => {
  const body = {
    fullName: "Priya Sharma",
    email: "",
    phone: "",
    country: "",
    nationality: "",
    location: "",
    source: "Website",
    priority: "medium",
    tags: [],
    notes: "",
    occupation: "",
    jobTitle: "",
    employer: "",
    qualification: "",
    skills: [],
    expectedOutcome: "",
    forceCreate: false,
  };

  it("rejects creates missing country, nationality or location", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/country is required/i);
  });

  it("rejects when only nationality is blank", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send({ ...body, country: "Australia", nationality: "  ", location: "Sydney" });

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/nationality is required/i);
  });
});
