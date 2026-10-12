import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import type { AuditService } from "../src/modules/audit/audit.service.js";
import { LeadsRepository, type LeadListFilter } from "../src/modules/leads/leads.service.js";
import { ReferralsService, type ReferralListFilter } from "../src/modules/referrals/referrals.service.js";
import { fakeDb } from "./helpers/fake-db.js";

const leadFilter = (sort: string): LeadListFilter => ({
  search: "",
  ownerUserId: "",
  teamId: "",
  pipelineId: "",
  stageId: "",
  source: "",
  priority: "",
  anzscoId: "",
  tag: "",
  createdFrom: "",
  createdTo: "",
  inactiveDays: 0,
  includeArchived: false,
  status: "",
  attention: "",
  sort,
  order: "",
  limit: 0,
  offset: 0,
  scope: { unscoped: true, ownerIds: [], teamIds: [] },
});

const referralFilter = (sort: string): ReferralListFilter => ({
  search: "",
  ownerUserId: "",
  teamId: "",
  pipelineId: "",
  referrerTypeCode: "",
  referrerUserId: "",
  referrerCustomerId: "",
  referrerPartnerId: "",
  referrerName: "",
  statusCode: "",
  dateFrom: "",
  dateTo: "",
  scopeOwnerIds: [],
  scopeTeamIds: [],
  unscoped: true,
  sort,
  order: "",
  limit: 0,
  offset: 0,
});

const referralRow = (id: string, display: string, typeCode: string) => ({
  id,
  leadId: null,
  customerId: null,
  referrerTypeId: "t",
  referrerTypeCode: typeCode,
  referrerTypeName: typeCode,
  referrerUserId: `u-${id}`,
  referrerUserName: null,
  referrerCustomerId: null,
  referrerCustomerName: null,
  referrerPartnerId: null,
  referrerPartnerName: null,
  referrerName: "",
  referrerDisplayName: display,
  relationshipId: null,
  relationshipCode: null,
  relationshipName: null,
  referralDate: "2026-01-01",
  referralSource: "",
  notes: "",
  statusId: "s",
  statusCode: "active",
  statusName: "Active",
  isConverted: false,
  referralCode: null,
  createdByUserId: null,
  referredName: null,
  ownerUserId: null,
  ownerName: null,
  teamId: null,
  pipelineId: null,
  pipelineName: null,
  stageId: null,
  stageName: null,
  potentialValue: null,
  subjectKind: "",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const audit = { record: async () => undefined } as unknown as AuditService;

describe("list sort keys", () => {
  it.each(["constructor", "__proto__", "toString"])("leads fall back to created_at for %s", async (sort) => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    await new LeadsRepository(f.db as unknown as Database).list(leadFilter(sort));
    expect(f.queries[1]?.sql).toContain("ORDER BY l.created_at DESC NULLS LAST");
  });

  it("leads sort by potential value, empty values last", async () => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    await new LeadsRepository(f.db as unknown as Database).list(leadFilter("value"));
    expect(f.queries[1]?.sql).toContain("ORDER BY l.potential_value DESC NULLS LAST");
  });

  it("leads sort by closed date for the Won and Lost tables", async () => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    await new LeadsRepository(f.db as unknown as Database).list({ ...leadFilter("closed"), order: "asc" });
    expect(f.queries[1]?.sql).toContain("ORDER BY COALESCE(l.won_at, l.lost_at) ASC NULLS LAST");
  });

  it("searches company like the board, trims the term, and applies value bounds", async () => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    await new LeadsRepository(f.db as unknown as Database).list({
      ...leadFilter(""),
      search: "  acme ",
      minValue: 500,
      maxValue: null,
    });
    expect(f.queries[0]?.sql).toContain("l.employer ILIKE");
    expect(f.queries[0]?.sql).toContain("l.potential_value >= $");
    expect(f.queries[0]?.sql).not.toContain("l.potential_value <= $");
    expect(f.queries[0]?.parameters).toEqual(expect.arrayContaining(["acme", 500]));
  });

  it.each(["constructor", "hasOwnProperty"])("referrals fall back to referral_date for %s", async (sort) => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    await new ReferralsService(f.db as unknown as Database, audit).list(referralFilter(sort));
    expect(f.queries[1]?.sql).toContain("ORDER BY r.referral_date DESC NULLS LAST");
  });
});

describe("referrer profile", () => {
  it("takes the header from the first row with a display name", async () => {
    const f = fakeDb();
    f.queue([{ total: 2 }], [referralRow("a", "", "employee"), referralRow("b", "Bea", "partner")]);
    const p = await new ReferralsService(f.db as unknown as Database, audit).referrerProfile("user", "x");
    expect(p).toMatchObject({ referrerDisplayName: "Bea", referrerTypeCode: "partner", referrerUserId: "u-b", totalReferrals: 2 });
  });

  it("uses the last row when no display name is set", async () => {
    const f = fakeDb();
    f.queue([{ total: 2 }], [referralRow("a", "", "employee"), referralRow("b", "", "partner")]);
    const p = await new ReferralsService(f.db as unknown as Database, audit).referrerProfile("user", "x");
    expect(p).toMatchObject({ referrerDisplayName: "", referrerTypeCode: "partner", referrerUserId: "u-b" });
  });

  it("has null history and zero counts with no rows", async () => {
    const f = fakeDb();
    f.queue([{ total: 0 }], []);
    const p = await new ReferralsService(f.db as unknown as Database, audit).referrerProfile("partner", "x");
    expect(p).toEqual({
      referrerKey: "partner:x",
      referrerTypeCode: "",
      referrerTypeName: "",
      referrerUserId: null,
      referrerCustomerId: null,
      referrerPartnerId: null,
      referrerDisplayName: "",
      totalReferrals: 0,
      activeReferrals: 0,
      convertedReferrals: 0,
      history: null,
    });
  });
});
