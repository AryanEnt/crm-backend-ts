import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { JwtService } from "../src/modules/auth/tokens.js";
import { config, SECRET, USER_ID, userRow as baseUserRow } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

let passwordHash = "";
beforeAll(async () => {
  passwordHash = await hashPassword("ChangeMe123!");
});

const userRow = (overrides: Record<string, unknown> = {}) => baseUserRow({ passwordHash, ...overrides });

describe("envelope and middleware", () => {
  it("health returns the Go payload shape with success first and timestamp last", async () => {
    const f = fakeDb();
    f.setRows([{ "?column?": 1 }]);
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["success", "data", "timestamp"]);
    expect(res.body.data).toMatchObject({ status: "ok", version: "0.1.0", checks: { database: "ok" } });
    expect(res.body.data.uptime).toMatch(/^\d+s$/);
  });

  it("health is 503 degraded when the database is down", async () => {
    const f = fakeDb();
    f.failWith(new Error("down"));
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toMatchObject({ status: "degraded", checks: { database: "unavailable" } });
  });

  it("echoes or generates X-Request-ID", async () => {
    const app = createApp({ config: config(), db: fakeDb().db });
    expect((await request(app).get("/api/v1/health").set("X-Request-ID", "abc")).headers["x-request-id"]).toBe("abc");
    expect((await request(app).get("/api/v1/health")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("CORS allows listed origins only and answers preflight with 204", async () => {
    const app = createApp({ config: config(), db: fakeDb().db });
    const pre = await request(app).options("/api/v1/auth/login").set("Origin", "http://10.0.0.5:3000/");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("http://10.0.0.5:3000");
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");

    const denied = await request(app).get("/api/v1/health").set("Origin", "http://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unmatched routes get Go ServeMux's plain-text 404, or 405 with Allow", async () => {
    const app = createApp({ config: config(), db: fakeDb().db });
    const res = await request(app).get("/api/v1/not-ported");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.text).toBe("404 page not found\n");

    const wrongMethod = await request(app).delete("/api/v1/users/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, HEAD, PATCH");
    expect(wrongMethod.text).toBe("Method Not Allowed\n");
  });

  it("a JSON null body decodes to zero values, like Go", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db }))
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("null");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("email and password are required");
  });
});

describe("auth", () => {
  it("login without a body is a validation error, like Go's EOF", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db })).post("/api/v1/auth/login");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "validation_error", message: "invalid JSON body: EOF" });
  });

  it("login rejects unknown fields and malformed JSON", async () => {
    const app = createApp({ config: config(), db: fakeDb().db });
    const unknown = await request(app).post("/api/v1/auth/login").send({ email: "a", password: "b", extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe('invalid JSON body: json: unknown field "extra"');

    const malformed = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("validation_error");
  });

  it("login requires email and password", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db }))
      .post("/api/v1/auth/login")
      .send({ email: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("email and password are required");
  });

  it("unknown user and wrong password are the same 401", async () => {
    const f = fakeDb();
    const app = createApp({ config: config(), db: f.db });
    f.queue([]);
    const noUser = await request(app).post("/api/v1/auth/login").send({ email: "x@y.z", password: "pw" });
    expect(noUser.status).toBe(401);
    expect(noUser.body.error).toEqual({ code: "unauthorized", message: "invalid email or password" });

    f.queue([userRow()]);
    const badPw = await request(app).post("/api/v1/auth/login").send({ email: "admin@crm.local", password: "nope" });
    expect(badPw.body.error.message).toBe("invalid email or password");
  });

  it("deactivated accounts cannot log in", async () => {
    const f = fakeDb();
    f.queue([userRow({ isActive: false })]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/auth/login")
      .send({ email: "admin@crm.local", password: "ChangeMe123!" });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("account is deactivated");
  });

  it("successful login returns tokens, session user and cookies", async () => {
    const f = fakeDb();
    f.queue(
      [userRow()], // find user by email
      [], // insert refresh session
      [
        { code: "leads:view", scope: "organization" },
        { code: "users:manage", scope: "organization" },
      ], // permission grants
      [{ teamId: "t-1" }], // team ids
      [], // touch last login
    );
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/auth/login")
      .set("User-Agent", "vitest")
      .send({ email: " Admin@CRM.local ", password: "ChangeMe123!" });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d)).toEqual(["user", "accessToken", "refreshToken", "accessExpiresAt", "refreshExpiresAt"]);
    expect(d.accessExpiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(d.user).toMatchObject({
      id: USER_ID,
      email: "admin@crm.local",
      roleCode: "super_admin",
      timezone: "UTC",
      teamIds: ["t-1"],
    });
    expect(d.user.permissions).toEqual(expect.arrayContaining(["leads:view", "users:manage", "users:delete"]));
    expect(d.user.permissionScopes["users:view"]).toBe("organization");
    const scopeKeys = Object.keys(d.user.permissionScopes);
    expect(scopeKeys).toEqual([...scopeKeys].sort());
    expect(new JwtService(SECRET).parseAccessToken(d.accessToken).uid).toBe(USER_ID);

    expect(f.queries[0]!.parameters).toEqual(["admin@crm.local"]);
    expect(f.queries[1]!.sql).toContain('insert into "refresh_sessions"');
    expect(f.queries[1]!.parameters).toContain("vitest");

    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.find((c) => c.startsWith("crm_access_token="))).toMatch(/Path=\/;.*HttpOnly/);
    expect(cookies.find((c) => c.startsWith("crm_refresh_token="))).toMatch(/Path=\/api\/v1\/auth/);
  });

  it("production cookies are Secure and SameSite=None", async () => {
    const f = fakeDb();
    f.queue([userRow()], [], [], [], []);
    const res = await request(createApp({ config: config({ appEnv: "production" }), db: f.db }))
      .post("/api/v1/auth/login")
      .send({ email: "admin@crm.local", password: "ChangeMe123!" });
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.every((c) => /Secure/.test(c) && /SameSite=None/.test(c))).toBe(true);
    // Go serializes an empty team list as null.
    expect(res.body.data.user.teamIds).toBeNull();
    expect(res.body.data.user.permissions).toEqual([]);
  });

  it("me requires a valid token", async () => {
    const app = createApp({ config: config(), db: fakeDb().db });
    const none = await request(app).get("/api/v1/auth/me");
    expect(none.status).toBe(401);
    expect(none.body.error.message).toBe("authentication required");

    const bad = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer nope");
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("invalid or expired session");
  });

  it("me accepts the access cookie as well as the Bearer header", async () => {
    const f = fakeDb();
    const token = new JwtService(SECRET).issueAccessToken(USER_ID, "admin@crm.local", "super_admin").token;
    const sessionQueries = () => f.queue([userRow()], [], [], [], [userRow()], [], []);
    const app = createApp({ config: config(), db: f.db });

    sessionQueries();
    const viaCookie = await request(app).get("/api/v1/auth/me").set("Cookie", `crm_access_token=${token}`);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.data.id).toBe(USER_ID);

    sessionQueries();
    const viaHeader = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(viaHeader.status).toBe(200);
  });

  it("refresh without a cookie is 401 and clears cookies", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db })).post("/api/v1/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("refresh token required");
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.find((c) => c.startsWith("crm_refresh_token=;"))).toMatch(/Max-Age=0;.*Path=\/api\/v1\/auth/);
    expect(cookies.find((c) => c.startsWith("crm_access_token=;"))).toMatch(/Max-Age=0;.*Path=\//);
  });

  it("logout always succeeds", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db })).post("/api/v1/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ loggedOut: true });
  });

  it("change-password validates before touching the database", async () => {
    const f = fakeDb();
    const token = new JwtService(SECRET).issueAccessToken(USER_ID, "admin@crm.local", "super_admin").token;
    f.queue([userRow()], [], [], []);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "ChangeMe123!", newPassword: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("password must be at least 8 characters");
  });

  it("profile update rejects invalid timezones", async () => {
    const f = fakeDb();
    const token = new JwtService(SECRET).issueAccessToken(USER_ID, "admin@crm.local", "super_admin").token;
    f.queue([userRow()], [], [], [], [userRow()]);
    const res = await request(createApp({ config: config(), db: f.db }))
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ timezone: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("invalid IANA timezone");
  });
});

describe("forwarding to the Go backend", () => {
  let go: Server;
  let goUrl = "";
  const seen: { method?: string; url?: string; body: string; requestId?: string }[] = [];

  beforeAll(async () => {
    go = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body, requestId: req.headers["x-request-id"] as string });
        res.setHeader("Access-Control-Allow-Origin", "http://go-should-not-leak");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { from: "go" }, timestamp: "t" }));
      });
    });
    await new Promise<void>((r) => go.listen(0, "127.0.0.1", r));
    goUrl = `http://127.0.0.1:${(go.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => go.close(() => r())));

  it("forwards unported routes with method, path, query and body intact", async () => {
    const app = createApp({ config: config({ goBackendUrl: goUrl }), db: fakeDb().db });
    const res = await request(app)
      .post("/api/v1/not-ported?excludeId=1")
      .set("Origin", "http://localhost:3000")
      .set("X-Request-ID", "req-42")
      .send({ name: "John" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ from: "go" });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: "POST", url: "/api/v1/not-ported?excludeId=1", requestId: "req-42" });
    expect(JSON.parse(last.body)).toEqual({ name: "John" });
  });

  it("ported routes are not forwarded", async () => {
    const before = seen.length;
    const app = createApp({ config: config({ goBackendUrl: goUrl }), db: fakeDb().db });
    await request(app).get("/api/v1/auth/me");
    await request(app).get("/api/v1/leads");
    expect(seen.length).toBe(before);
  });

  it("returns a JSON 502 when the Go backend is unreachable", async () => {
    const app = createApp({ config: config({ goBackendUrl: "http://127.0.0.1:1" }), db: fakeDb().db });
    const res = await request(app).get("/api/v1/not-ported");
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, error: { code: "upstream_unavailable" } });
  });
});
