import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { goMarshal, goSortKeys } from "../src/lib/go-json.js";
import { atoi, parseBool } from "../src/lib/query.js";
import { decodeJson, int, optionalString, str, stringArray } from "../src/lib/validate.js";
import { encodeValue } from "../src/modules/custom-fields/custom-fields.service.js";
import { slugify } from "../src/modules/lead-sources/lead-sources.service.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("Go-compatible helpers", () => {
  it("atoi ignores errors like strconv.Atoi with _ = err", () => {
    expect(atoi("25")).toBe(25);
    expect(atoi("+5")).toBe(5);
    expect(atoi("-3")).toBe(-3);
    for (const bad of ["", "abc", "5.0", " 5", "1e3"]) expect(atoi(bad)).toBe(0);
  });

  it("parseBool accepts exactly strconv.ParseBool's true spellings", () => {
    for (const t of ["1", "t", "T", "true", "TRUE", "True"]) expect(parseBool(t)).toBe(true);
    for (const f of ["", "yes", "on", "tRUE", "0"]) expect(parseBool(f)).toBe(false);
  });

  it("goMarshal sorts keys recursively and escapes HTML like json.Marshal", () => {
    expect(goMarshal({ b: 1, a: { d: "<x>&", c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}],"d":"\\u003cx\\u003e\\u0026"},"b":1}',
    );
    expect(goMarshal("a<b")).toBe('"a\\u003cb"');
  });

  it("goSortKeys leaves Dates and arrays intact", () => {
    const d = new Date(0);
    expect(goSortKeys({ z: d, a: [3, 1] })).toEqual({ a: [3, 1], z: d });
    expect(Object.keys(goSortKeys({ total: 1, limit: 2, offset: 3 }))).toEqual(["limit", "offset", "total"]);
  });
});

describe("decodeJson follows encoding/json rules", () => {
  const schema = z.strictObject({ name: str(), count: int(), note: optionalString(), tags: stringArray() });
  const decode = (body: unknown) => decodeJson({ body } as never, schema);

  it("null leaves non-pointer fields at their zero value and pointer fields unset", () => {
    expect(decode({ name: null, count: null, note: null, tags: null })).toEqual({
      name: "",
      count: 0,
      note: undefined,
      tags: undefined,
    });
  });

  it("an empty array is kept (non-nil slice)", () => {
    expect(decode({ tags: [] }).tags).toEqual([]);
  });

  it("matches keys case-insensitively, but still rejects unknown ones", () => {
    expect(decode({ Name: "x", COUNT: 2 })).toMatchObject({ name: "x", count: 2 });
    expect(() => decode({ other: 1 })).toThrow('invalid JSON body: json: unknown field "other"');
  });

  it("rejects fractional ints and wrong types", () => {
    expect(() => decode({ count: 1.5 })).toThrow(/invalid JSON body/);
    expect(() => decode({ name: 5 })).toThrow(/invalid JSON body/);
  });
});

describe("module helpers", () => {
  it("slugify matches the Go lead-source code generator", () => {
    expect(slugify("  Referral Partner #1 ")).toBe("referral_partner_1");
    expect(slugify("Walk-in")).toBe("walkin");
    expect(slugify("!!!")).toBe("source");
  });

  it("encodeValue stores strings as text and everything else as its JSON", () => {
    expect(encodeValue("hi")).toEqual({ text: "hi", json: '"hi"' });
    expect(encodeValue(5)).toEqual({ text: "5", json: "5" });
    expect(encodeValue(null)).toEqual({ text: null, json: "null" });
    expect(encodeValue({ b: true, a: ["x"] })).toEqual({ text: '{"a":["x"],"b":true}', json: '{"a":["x"],"b":true}' });
  });
});

describe("reference data routes", () => {
  const app = (f = fakeDb()) => createApp({ config: config(), db: f.db });

  it("require authentication before permissions", async () => {
    const res = await request(app()).get("/api/v1/settings");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("authentication required");
  });

  it("settings need settings:view or settings:manage", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsView);
    const res = await request(app(f)).get("/api/v1/settings").set("Authorization", bearer());
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: "forbidden", message: "insufficient permissions" });
  });

  it("settings defaults only expose the prefill keys, sorted", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadsCreate);
    const row = (key: string, value: string) => ({ key, value, valueType: "string", updatedBy: null, updatedAt: new Date(0) });
    f.queue([
      row("crm.default_lead_source", "Website"),
      row("organization.name", "Secret Co"),
      row("crm.default_deal_currency", "AUD"),
    ]);
    const res = await request(app(f)).get("/api/v1/settings/defaults").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ "crm.default_deal_currency": "AUD", "crm.default_lead_source": "Website" });
    expect(Object.keys(res.body.data)).toEqual(["crm.default_deal_currency", "crm.default_lead_source"]);
  });

  it("unknown setting keys are rejected before anything is written", async () => {
    const f = fakeDb();
    queueAuth(f, P.SettingsManage);
    const res = await request(app(f))
      .put("/api/v1/settings")
      .set("Authorization", bearer())
      .send({ settings: { "organization.name": "x", "bogus.key": "y" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("unknown setting key: bogus.key");
    expect(f.queries.some((q) => q.sql.includes("organization_settings"))).toBe(false);
  });

  it("audit logs return null data and sorted raw meta when empty", async () => {
    const f = fakeDb();
    queueAuth(f, P.AuditView);
    f.queue([{ total: 0 }], []);
    const res = await request(app(f)).get("/api/v1/audit-logs?limit=500&offset=x").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.meta).toEqual({ limit: 500, offset: 0, total: 0 });
    expect(Object.keys(res.body.meta)).toEqual(["limit", "offset", "total"]);
    // The query itself uses the clamped limit.
    expect(f.queries.at(-1)!.parameters).toContain(25);
  });

  it("lead source create validates the name", async () => {
    const f = fakeDb();
    queueAuth(f, P.LeadSourcesManage);
    const res = await request(app(f)).post("/api/v1/lead-sources").set("Authorization", bearer()).send({ name: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("source name is required");
  });

  it("custom field values for an unknown entity are not found", async () => {
    const f = fakeDb();
    queueAuth(f, P.CustomFieldsView);
    const res = await request(app(f))
      .get("/api/v1/custom-fields/values/bogus/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
      .set("Authorization", bearer());
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("record not found");
  });

  it("pipeline stage reorder requires stage ids", async () => {
    const f = fakeDb();
    queueAuth(f, P.PipelinesManage);
    const pipeline = { id: "p1", name: "Sales", description: "", kind: "sales", isDefault: true, isActive: true, createdAt: new Date(0), updatedAt: new Date(0) };
    f.queue([pipeline], []);
    const res = await request(app(f))
      .post("/api/v1/pipelines/p1/stages/reorder")
      .set("Authorization", bearer())
      .send({ stageIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("stageIds required");
  });

  it("routes are strict like Go's mux: trailing slashes and case fall through", async () => {
    const f = fakeDb();
    for (const path of ["/api/v1/pipelines/", "/api/v1/Pipelines"]) {
      const res = await request(app(f)).get(path).set("Authorization", bearer());
      expect(res.status).toBe(404);
      expect(res.text).toBe("404 page not found\n");
    }
  });
});
