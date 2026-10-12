import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { goParseQuery, truncateBytes } from "../src/lib/go-strings.js";
import { MetaWhatsAppProvider, TwilioVoiceProvider, type Form } from "../src/modules/communications/providers.js";
import { TokenBox } from "../src/modules/email/crypto.js";
import type { EmailService } from "../src/modules/email/email.service.js";
import { createEmailWorker } from "../src/modules/email/email.worker.js";
import {
  collectBodies,
  decodeGmailBody,
  GmailApiError,
  GmailClient,
  goEncodeValues,
  googleErrorLogFields,
} from "../src/modules/email/gmail.js";
import {
  applyVars,
  buildRfc822,
  findUnresolved,
  parseAddress,
  parseAddressList,
  stripTags,
  uniqueEmails,
} from "../src/modules/email/mime.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("go string helpers", () => {
  it("truncateBytes cuts on bytes like s[:n]", () => {
    expect(truncateBytes("hello", 10)).toBe("hello");
    expect(truncateBytes("héllo", 2)).toBe("h\uFFFD");
  });

  it("goParseQuery mirrors url.ParseQuery errors and decoding", () => {
    expect(goParseQuery("a=1+2&b=%41&a=3").values).toEqual(
      new Map([
        ["a", ["1 2", "3"]],
        ["b", ["A"]],
      ]),
    );
    expect(goParseQuery("a=1;b=2").error).toBe(true);
    expect(goParseQuery("a=%zz").error).toBe(true);
    expect(goParseQuery("").error).toBe(false);
  });
});

describe("TokenBox", () => {
  it("decrypts a ciphertext produced by the Go backend", () => {
    const box = new TokenBox("  vector-secret  ");
    expect(box.decrypt("F3q6fS+MQ4IU1qU81hxgFZsc72j/TYv8NXuiYBepd/uKpqzM9DybUVWpErA=")).toBe("ya29.token-value");
  });

  it("round-trips, passes empty values through and rejects a wrong key", () => {
    const box = new TokenBox("k");
    const enc = box.encrypt("secret");
    expect(enc).not.toContain("secret");
    expect(box.decrypt(enc)).toBe("secret");
    expect(box.encrypt("")).toBe("");
    expect(box.decrypt("  ")).toBe("");
    expect(() => new TokenBox("other").decrypt(enc)).toThrow("message authentication failed");
    expect(() => box.decrypt("not base64!")).toThrow();
  });
});

describe("email text helpers", () => {
  it("applies known non-empty variables and reports the rest once, nil when none", () => {
    const vars = { first_name: "Asha", email: "" };
    expect(applyVars("Hi {{ first_name }}, {{email}} {{x}}", vars)).toBe("Hi Asha, {{email}} {{x}}");
    expect(findUnresolved("{{email}} {{x}} {{ email }}")).toEqual(["email", "x"]);
    expect(findUnresolved("nothing here")).toBeNull();
  });

  it("strips tags and de-duplicates addresses, empty (never null) when none remain", () => {
    expect(stripTags("<p>Hello <b>there</b></p>")).toBe("Hello  there");
    expect(uniqueEmails([" A@x.com", "a@x.com", "", "b@y.com"])).toEqual(["a@x.com", "b@y.com"]);
    expect(uniqueEmails([])).toEqual([]);
    expect(uniqueEmails(undefined)).toEqual([]);
  });

  it("parses RFC 5322 addresses with a lowercase fallback", () => {
    expect(parseAddress('"Doe, Jane" <Jane@Example.com>')).toEqual({ name: "Doe, Jane", addr: "jane@example.com" });
    expect(parseAddress("=?UTF-8?B?SsO8cmdlbg==?= <j@x.io>")).toEqual({ name: "Jürgen", addr: "j@x.io" });
    expect(parseAddress("Not An Address")).toEqual({ name: "", addr: "not an address" });
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual(["jane@x.com", "bob@y.com"]);
    expect(parseAddressList("")).toEqual([]);
  });

  it("builds the raw message Gmail sends", () => {
    const raw = buildRfc822("Asha", "asha@x.com", {
      toAddresses: ["a@b.com", "c@d.com"],
      ccAddresses: [],
      bccAddresses: ["e@f.com"],
      subject: "Hi",
      bodyHtml: "",
      bodyText: "plain",
    });
    expect(raw).toBe(
      "From: Asha <asha@x.com>\r\nTo: a@b.com, c@d.com\r\nBcc: e@f.com\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n" +
        "Content-Type: text/plain; charset=UTF-8\r\n\r\nplain",
    );
  });
});

describe("gmail helpers", () => {
  it("encodes OAuth values sorted and query-escaped like url.Values", () => {
    expect(goEncodeValues({ scope: "a b", client_id: "x*y", state: "s-_" })).toBe("client_id=x%2Ay&scope=a+b&state=s-_");
  });

  it("requests offline Gmail access and the scopes needed for profile, read and send", () => {
    const url = new URL(new GmailClient("id", "secret", "http://cb").authUrl("state"));
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(scopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ]),
    );
  });

  it("decodes padded and unpadded URL-safe bodies, empty when invalid", () => {
    expect(decodeGmailBody(Buffer.from("hi?>").toString("base64url"))).toBe("hi?>");
    expect(decodeGmailBody("aGk=")).toBe("hi");
    expect(decodeGmailBody("a+b/")).toBe("");
  });

  it("collects the first html/text bodies and attachments depth-first", () => {
    const part = (mimeType: string, data: string, filename = "", attachmentId = "") => ({
      mimeType,
      filename,
      headers: [],
      body: { size: 3, data: Buffer.from(data).toString("base64url"), attachmentId },
      parts: [],
    });
    const out = collectBodies({
      ...part("multipart/mixed", ""),
      body: { size: 0, data: "", attachmentId: "" },
      parts: [part("text/plain", "plain"), part("text/html", "<b>x</b>"), part("application/pdf", "", "a.pdf", "att-1")],
    });
    expect(out.text).toBe("plain");
    expect(out.html).toBe("<b>x</b>");
    expect(out.attachments).toEqual([{ filename: "a.pdf", mimeType: "application/pdf", size: 3, providerId: "att-1" }]);
  });

  it("decodes historyId whether Gmail sends it as a string or a number", async () => {
    const client = new GmailClient("id", "secret", "http://cb");
    const profile = async (historyId: unknown) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ emailAddress: "a@x.com", historyId })));
      try {
        return await client.gmailProfile("tok");
      } finally {
        vi.unstubAllGlobals();
      }
    };
    expect((await profile("12345")).historyId).toBe(12345);
    expect((await profile(678)).historyId).toBe(678);
    await expect(profile("12a")).rejects.toThrow(/uint64/);
  });

  it("reports Gmail HTTP errors with sanitized status and provider details", async () => {
    const client = new GmailClient("client-secret-value", "another-secret", "http://cb");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Rejected access_token=ya29.secret-value code=4/secret-code",
              errors: [{ reason: "accessNotConfigured" }],
            },
          }),
          { status: 403 },
        ),
    );
    try {
      let caught: unknown;
      try {
        await client.gmailProfile("ya29.secret-value");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GmailApiError);
      expect(caught).toMatchObject({
        operation: "GET /gmail/v1/users/me/profile",
        status: 403,
        googleError: {
          code: 403,
          status: "PERMISSION_DENIED",
          reasons: ["accessNotConfigured"],
          message: "Rejected access_token=[REDACTED] code=[REDACTED]",
        },
      });
      const fields = googleErrorLogFields(caught, "gmail.users.getProfile");
      expect(fields).toMatchObject({
        operation: "GET /gmail/v1/users/me/profile",
        httpStatus: 403,
        googleError: { reasons: ["accessNotConfigured"] },
      });
      expect(JSON.stringify(fields)).not.toMatch(/ya29\.secret-value|secret-code|another-secret|client-secret-value/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records OAuth token endpoint status and sanitized errors without request credentials", async () => {
    const client = new GmailClient("client-id", "client-secret-value", "http://cb");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "code=4/secret-code" }), { status: 400 }),
    );
    try {
      let caught: unknown;
      try {
        await client.exchangeCode("4/secret-code");
      } catch (err) {
        caught = err;
      }
      expect(googleErrorLogFields(caught, "oauth.token.exchange")).toMatchObject({
        operation: "oauth.token.exchange",
        httpStatus: 400,
        googleError: { message: "code=[REDACTED]", reasons: ["invalid_grant"] },
      });
      expect(JSON.stringify(googleErrorLogFields(caught, "oauth.token.exchange"))).not.toMatch(/secret-code|client-secret-value/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("email worker", () => {
  it("keeps at most one pending run per ticker while busy, like a Go ticker", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const renewWatches = vi.fn(() => new Promise<void>((r) => (release = r)));
      const sendDueScheduled = vi.fn(async () => undefined);
      const worker = createEmailWorker({ renewWatches, sendDueScheduled } as unknown as EmailService);
      worker.start();
      await vi.advanceTimersByTimeAsync(5 * 30_000);
      expect(renewWatches).toHaveBeenCalledTimes(1);
      expect(sendDueScheduled).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sendDueScheduled).toHaveBeenCalledTimes(1);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("communication providers", () => {
  it("validates Meta's X-Hub-Signature-256", () => {
    const meta = new MetaWhatsAppProvider();
    const body = Buffer.from('{"entry":[]}');
    const sig = createHmac("sha256", "app-secret").update(body).digest("hex");
    expect(meta.validateSignature("app-secret", body, `sha256=${sig}`)).toBe(true);
    expect(meta.validateSignature("app-secret", body, `sha256=${sig.toUpperCase()}`)).toBe(true);
    expect(meta.validateSignature("app-secret", body, "sha256=00")).toBe(false);
    expect(meta.validateSignature("", body, `sha256=${sig}`)).toBe(false);
  });

  it("validates Twilio's X-Twilio-Signature over the URL and sorted params", () => {
    const twilio = new TwilioVoiceProvider();
    const url = "https://api.example.com/api/v1/webhooks/twilio/voice/status?x=1";
    const form: Form = new Map([
      ["CallStatus", ["completed"]],
      ["CallSid", ["CA1"]],
    ]);
    const sig = createHmac("sha1", "tok").update(`${url}CallSidCA1CallStatuscompleted`).digest("base64");
    expect(twilio.validateSignature("tok", url, form, sig)).toBe(true);
    expect(twilio.validateSignature("tok", url, form, "bad")).toBe(false);
    expect(() => twilio.parseStatusCallback(new Map())).toThrow("missing CallSid");
  });
});

describe("communications and email routes", () => {
  it("Meta verification answers 403 plain text when no account matches", async () => {
    const f = fakeDb();
    const res = await request(createApp({ config: config(), db: f.db })).get(
      "/api/v1/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=t&hub.challenge=c",
    );
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.text).toBe("forbidden\n");
  });

  it("Twilio status rejects a malformed query as invalid form", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db }))
      .post("/api/v1/webhooks/twilio/voice/status?a=%zz")
      .type("form")
      .send("CallSid=CA1");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validation_error", message: "invalid form" });
  });

  it("Pub/Sub acknowledges malformed envelopes without touching the database", async () => {
    const f = fakeDb();
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/webhooks/google/pubsub")
      .set("Content-Type", "application/json")
      .send('{"message":{"data":"!!"}}');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
    expect(f.queries).toHaveLength(0);
  });

  it("Pub/Sub ignores an envelope whose messageId is not a string, like json.Unmarshal", async () => {
    const f = fakeDb();
    const data = Buffer.from(JSON.stringify({ emailAddress: "a@x.com", historyId: "1" })).toString("base64");
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/webhooks/google/pubsub")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ message: { data, messageId: 5 } }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
    expect(f.queries).toHaveLength(0);
  });

  it("OAuth callback redirects like http.Redirect", async () => {
    const res = await request(createApp({ config: config(), db: fakeDb().db })).get(
      "/api/v1/email/google/callback?error=access_denied",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/settings/email?gmail=denied");
    expect(res.text).toBe('<a href="http://localhost:3000/settings/email?gmail=denied">Found</a>.\n\n');
  });

  it("connect fails validation when Google OAuth is not configured", async () => {
    const f = fakeDb();
    queueAuth(f, "email:send");
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/email/google/connect")
      .set("Authorization", bearer())
      .send("not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ message: "Gmail integration is not configured" });
  });

  it("health reports the unconfigured integration", async () => {
    const f = fakeDb();
    queueAuth(f, "email:view");
    const res = await request(createApp({ config: config(), db: f.db })).get("/api/v1/email/health").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      configured: false,
      oauthConfigured: false,
      gmailApiEnabled: false,
      pubSubConfigured: false,
      pushSyncHealthy: false,
      connectedAccounts: 0,
      needsAttention: 0,
      message: "Gmail integration is not configured",
    });
  });
});
