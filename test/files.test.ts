import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InvalidMultipartError, parseMultipart } from "../src/lib/multipart.js";
import { clientIp, requestMetaFirstHop } from "../src/lib/request-meta.js";
import { goPathBase } from "../src/modules/documents/documents.service.js";
import { P } from "../src/modules/permissions/permissions.js";
import { LocalStore, newObjectKey } from "../src/modules/storage/storage.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const root = mkdtempSync(path.join(tmpdir(), "crm-store-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("storage", () => {
  it("object keys use a safe base name and a strictly increasing stamp", () => {
    const a = newObjectKey("/documents/leads/1/", "../x/a..b.txt");
    const b = newObjectKey("documents", "");
    expect(a).toMatch(/^documents\/leads\/1\/\d+_a_b\.txt$/);
    expect(b).toMatch(/^documents\/\d+_file$/);
    const stamp = (k: string) => BigInt(k.split("/").at(-1)!.split("_")[0]!);
    expect(stamp(b) > stamp(a)).toBe(true);
  });

  it("keys cannot escape the root", async () => {
    const store = new LocalStore(root);
    await store.put("../../escape.txt", Readable.from([Buffer.from("hi")]), "");
    expect(readFileSync(path.join(root, "escape.txt"), "utf8")).toBe("hi");
    expect(await store.exists("/../escape.txt")).toBe(true);
    await store.delete("escape.txt");
    expect(await store.exists("escape.txt")).toBe(false);
  });

  it("goPathBase matches Go's path.Base", () => {
    expect(goPathBase("")).toBe(".");
    expect(goPathBase("///")).toBe("/");
    expect(goPathBase("documents/leads/1/123_a.txt/")).toBe("123_a.txt");
  });
});

describe("multipart", () => {
  const app = express();
  app.post("/echo", async (req, res) => {
    try {
      const form = await parseMultipart(req);
      const f = form.file("file");
      res.json({ filename: f?.filename, size: f?.size, name: form.value("name"), q: form.value("q"), blank: form.value("blank") });
      await form.cleanup();
    } catch (err) {
      res.status(400).json({ invalid: err instanceof InvalidMultipartError });
    }
  });

  it("decodes UTF-8 filenames, falls back to the query, and treats empty-filename parts as values", async () => {
    const res = await request(app)
      .post("/echo?q=fromquery&name=ignored")
      .field("name", "fromform")
      .attach("blank", Buffer.from("plain"), { filename: "" })
      .attach("file", Buffer.from("hello"), "ünï.txt");
    expect(res.body).toEqual({ filename: "ünï.txt", size: 5, name: "fromform", q: "fromquery", blank: "plain" });
  });

  it("rejects non-multipart bodies", async () => {
    const res = await request(app).post("/echo").type("form").send("name=x");
    expect(res.body).toEqual({ invalid: true });
  });
});

describe("client IP", () => {
  const req = (xff: string | undefined, remoteAddress: string) =>
    ({ get: (h: string) => (h === "X-Forwarded-For" ? xff : undefined), socket: { remoteAddress, remotePort: 5000 } }) as unknown as Request;

  it("unmaps IPv4 and brackets IPv6 like Go's RemoteAddr", () => {
    expect(clientIp(req(undefined, "::ffff:10.0.0.5"))).toBe("10.0.0.5:5000");
    expect(clientIp(req(undefined, "::1"))).toBe("[::1]:5000");
    expect(clientIp(req("1.1.1.1, 2.2.2.2", "::1"))).toBe("1.1.1.1, 2.2.2.2");
  });

  it("documents record the first forwarded hop, else the host without port", () => {
    expect(requestMetaFirstHop(req(" 1.1.1.1 , 2.2.2.2", "::1")).ip).toBe("1.1.1.1");
    expect(requestMetaFirstHop(req(undefined, "::ffff:10.0.0.5")).ip).toBe("10.0.0.5");
  });
});

describe("files and referrals routes validate before touching data", () => {
  const app = (f: ReturnType<typeof fakeDb>) => createApp({ config: config(), db: f.db, store: new LocalStore(root) });

  it.each([
    ["/api/v1/documents/upload", (r: request.Test) => r.send({ name: "x" }), "invalid multipart form"],
    ["/api/v1/documents/upload", (r: request.Test) => r.field("name", "x"), "file is required"],
  ] as const)("POST %s -> %s", async (url, body, message) => {
    const f = fakeDb();
    queueAuth(f, P.DocumentsCreate);
    const res = await body(request(app(f)).post(url).set("Authorization", bearer()));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message });
    expect(f.queries.length).toBe(4);
  });

  it.each([
    [P.LeadsView, "/api/v1/timeline", "customerId, dealId, or leadId is required"],
    [P.LeadsView, "/api/v1/referrals/subject", "leadId or customerId is required"],
  ] as const)("GET %s %s -> 400", async (perm, url, message) => {
    const f = fakeDb();
    queueAuth(f, perm);
    const res = await request(app(f)).get(url).set("Authorization", bearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message });
  });

  it("timeline types are static and responses use Go's content type", async () => {
    const f = fakeDb();
    queueAuth(f, P.DealsView);
    const res = await request(app(f)).get("/api/v1/timeline/types").set("Authorization", bearer());
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.text.endsWith("}\n")).toBe(true);
    expect(res.body.data).toHaveLength(17);
    expect(res.body.data[0]).toEqual({ code: expect.any(String), label: expect.any(String) });
    expect(f.queries.length).toBe(4);
  });
});
