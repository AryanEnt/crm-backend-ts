import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, fakeDb, queueAuth } from "./helpers.js";

describe("lead country / nationality / location", () => {
  const body = {
    fullName: "Test Lead",
    email: "",
    phone: "",
    phoneCountry: "AU",
    country: "",
    nationality: "",
    location: "",
    ownerUserId: "",
    teamId: "",
    pipelineId: "",
    stageId: "",
    source: "Other",
    sourceDetail: "",
    priority: "medium",
    tags: [],
    anzscoId: "",
    occupation: "",
    potentialValue: null,
    nextActivityAt: "",
    expectedCloseAt: "",
    notes: "",
    jobTitle: "",
    employer: "",
    experienceYears: null,
    qualification: "",
    skills: [],
    expectedOutcome: "",
    forceCreate: false,
  };

  it("rejects creates missing country", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/country is required/i);
  });

  it("allows blank nationality and location when country is set", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    // Downstream insert will fail in the fake DB; we only assert we are past
    // nationality/location required checks (not a 400 field-validation for those).
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send({ ...body, country: "Australia", nationality: "  ", location: "" });

    expect(res.body.error?.message ?? "").not.toMatch(/nationality is required/i);
    expect(res.body.error?.message ?? "").not.toMatch(/location is required/i);
  });
});
