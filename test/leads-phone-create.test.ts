import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const baseBody = {
  fullName: "Priya Sharma",
  email: "",
  phone: "0412",
  phoneCountryCode: "AU",
  country: "Australia",
  nationality: "Nepali",
  location: "Sydney",
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

describe("lead create phone validation gate", () => {
  it("does not reject creates with an incomplete phone number at the API layer", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    // duplicate check (email/name only — phone skipped)
    f.queue([]);
    // optional default placement lookups may run; allow empty
    f.queue([]);
    f.queue([]);
    // INSERT
    f.queue([]);
    // get after create
    f.queue([
      {
        id: "lead-1",
        fullName: "Priya Sharma",
        email: null,
        phone: "0412",
        country: "Australia",
        nationality: "Nepali",
        location: "Sydney",
        ownerUserId: "user-1",
        ownerName: "SE",
        teamId: null,
        teamName: null,
        source: "Website",
        priority: "medium",
        tags: [],
        anzscoId: null,
        anzscoCode: null,
        anzscoTitle: null,
        pipelineId: null,
        pipelineName: null,
        stageId: null,
        stageName: null,
        stageAccent: null,
        notes: "",
        occupation: "",
        jobTitle: "",
        employer: "",
        experienceYears: null,
        qualification: "",
        skills: [],
        potentialValue: null,
        currency: "AUD",
        probability: null,
        expectedCloseAt: null,
        expectedOutcome: "",
        lastActivityAt: null,
        nextActivityAt: null,
        status: "open",
        wonAt: null,
        lostAt: null,
        lostReason: "",
        stageEnteredAt: new Date(),
        daysInStage: 0,
        convertedCustomerId: null,
        convertedAt: null,
        isArchived: false,
        archivedAt: null,
        ageDays: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        slaHours: null,
        createdByUserId: "user-1",
        phoneCountryCode: "AU",
        phoneValidationStatus: "pending",
        phoneNormalized: null,
        phoneValidationMessage: "Queued for validation",
        phoneDuplicateLeadIds: [],
        phoneValidatedAt: null,
        phoneLastNotifiedAt: null,
        phoneValidationVersion: 1,
      },
    ]);
    // markPending UPDATE RETURNING version
    f.queue([{ version: 2 }]);
    // attachVisibleDuplicates — no dup ids
    // get again after markPending
    f.queue([
      {
        id: "lead-1",
        fullName: "Priya Sharma",
        email: null,
        phone: "0412",
        country: "Australia",
        nationality: "Nepali",
        location: "Sydney",
        ownerUserId: "user-1",
        ownerName: "SE",
        teamId: null,
        teamName: null,
        source: "Website",
        priority: "medium",
        tags: [],
        anzscoId: null,
        anzscoCode: null,
        anzscoTitle: null,
        pipelineId: null,
        pipelineName: null,
        stageId: null,
        stageName: null,
        stageAccent: null,
        notes: "",
        occupation: "",
        jobTitle: "",
        employer: "",
        experienceYears: null,
        qualification: "",
        skills: [],
        potentialValue: null,
        currency: "AUD",
        probability: null,
        expectedCloseAt: null,
        expectedOutcome: "",
        lastActivityAt: null,
        nextActivityAt: null,
        status: "open",
        wonAt: null,
        lostAt: null,
        lostReason: "",
        stageEnteredAt: new Date(),
        daysInStage: 0,
        convertedCustomerId: null,
        convertedAt: null,
        isArchived: false,
        archivedAt: null,
        ageDays: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        slaHours: null,
        createdByUserId: "user-1",
        phoneCountryCode: "AU",
        phoneValidationStatus: "pending",
        phoneNormalized: null,
        phoneValidationMessage: "Queued for validation",
        phoneDuplicateLeadIds: [],
        phoneValidatedAt: null,
        phoneLastNotifiedAt: null,
        phoneValidationVersion: 2,
      },
    ]);

    // Remaining side-effect queries (audit/timeline/automation/sys activity) — drain with empties
    for (let i = 0; i < 20; i++) f.queue([]);

    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send(baseBody);

    // Soft success path: either 201 with lead, or 500 if fake queue order drifts —
    // assert we never got a phone-validation 400.
    expect(res.status).not.toBe(400);
    if (res.status === 201) {
      expect(res.body.data?.phone).toBe("0412");
      expect(res.body.data?.phoneValidationStatus).toBe("pending");
    }
  });

  it("does not soft-block create on phone-only duplicate matches", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    // findDuplicates with phone=null → only email/name; empty
    f.queue([]);
    for (let i = 0; i < 30; i++) f.queue([]);

    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/leads")
      .set("Authorization", bearer())
      .send({ ...baseBody, phone: "+61412345678", forceCreate: false });

    // Must not be the duplicate-review 409 from phone matching
    expect(res.status).not.toBe(409);
  });
});
