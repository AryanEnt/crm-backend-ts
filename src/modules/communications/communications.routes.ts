import type { Request, Response, Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { goParseQuery } from "../../lib/go-strings.js";
import { atoi, queryParam } from "../../lib/query.js";
import { readBody } from "../../lib/raw-body.js";
import { requestMeta } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { bool, decodeJson, optionalBool, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import type { CommunicationsService } from "./communications.service.js";
import type { Form } from "./providers.js";

const TWILIO_STATUS_PATH = "/api/v1/webhooks/twilio/voice/status";
const META_BODY_LIMIT = 2 << 20;
const MAX_FORM_SIZE = 10 << 20;

const links = {
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
};

const createAccountSchema = z.strictObject({
  provider: str(),
  name: str(),
  displayIdentifier: str(),
  externalAccountId: str(),
  credentials: z
    .record(z.string(), str())
    .nullish()
    .transform((v) => v ?? undefined),
  ownerUserId: optionalString(),
  teamId: optionalString(),
  allowRecordings: bool(),
  isActive: optionalBool(),
});

const connectWhatsAppSchema = z.strictObject({
  name: str(),
  displayIdentifier: str(),
  externalAccountId: str(),
  accessToken: str(),
  appSecret: str(),
  verifyToken: str(),
  graphApiVersion: str(),
});

const embeddedSignupSchema = z.strictObject({
  code: str(),
  phoneNumberId: str(),
  wabaId: str(),
  displayPhoneNumber: str(),
});

const sendWhatsAppSchema = z.strictObject({ accountId: str(), to: str(), body: str(), mediaUrl: str(), ...links });
const placeCallSchema = z.strictObject({ accountId: str(), to: str(), ...links });
const callPermissionSchema = z.strictObject({ accountId: str(), to: str(), body: str(), ...links });
const initiateWaCallSchema = z.strictObject({
  accountId: str(),
  to: str(),
  sdp: str(),
  sdpType: str(),
  ...links,
});
const waCallSignalSchema = z.strictObject({ sdp: str(), sdpType: str() });
const emptyBodySchema = z.strictObject({});

/** http.Error: plain text with a trailing newline and nosniff. */
function httpError(res: Response, status: number, text: string): void {
  res.status(status).setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(`${text}\n`);
}

/** The raw query string as Go's r.URL.RawQuery. */
function rawQuery(req: Request): string {
  const i = req.originalUrl.indexOf("?");
  return i < 0 ? "" : req.originalUrl.slice(i + 1);
}

/** Go's r.ParseForm for a POST: the urlencoded body as PostForm; null when Go would fail. */
async function parsePostForm(req: Request): Promise<Form | null> {
  if (goParseQuery(rawQuery(req)).error) return null;
  const mediaType = (req.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    req.resume();
    return new Map();
  }
  const { body, tooLarge } = await readBody(req, MAX_FORM_SIZE, false);
  if (tooLarge) return null;
  const parsed = goParseQuery(body.toString());
  return parsed.error ? null : parsed.values;
}

export function communicationsRouter(service: CommunicationsService, guard: Guard): Router {
  const router = createRouter();
  const page = (req: Request) => [atoi(queryParam(req, "limit")), atoi(queryParam(req, "offset"))] as const;
  const listed = (res: Response, items: unknown[], total: number, limit: number, offset: number) =>
    sendJson(res, 200, { success: true, data: items, meta: { total, limit: limit <= 0 ? 50 : limit, offset } });

  router.get(
    "/api/v1/communications/accounts",
    ...guard(P.CommunicationsView, P.CommunicationsSend, P.CommunicationsManage),
    async (req, res) => {
      ok(res, await service.listAccounts(queryParam(req, "provider")));
    },
  );

  router.post("/api/v1/communications/accounts", ...guard(P.CommunicationsManage), jsonBody, async (req, res) => {
    const input = decodeJson(req, createAccountSchema);
    created(res, await service.createAccount(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get(
    "/api/v1/communications/whatsapp/connect-config",
    ...guard(P.CommunicationsView, P.CommunicationsSend, P.CommunicationsManage),
    async (_req, res) => {
      ok(res, service.whatsappConnectConfig());
    },
  );

  // One-click Embedded Signup (platform Meta app in env; SE only authorizes their number).
  router.post(
    "/api/v1/communications/whatsapp/embedded-signup",
    ...guard(P.CommunicationsSend, P.CommunicationsManage),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, embeddedSignupSchema);
      created(res, await service.completeEmbeddedSignup(claimsOf(req).userId, input, requestMeta(req)));
    },
  );

  // Manual credentials connect (fallback when Embedded Signup env is not set).
  router.post(
    "/api/v1/communications/whatsapp/connect",
    ...guard(P.CommunicationsSend, P.CommunicationsManage),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, connectWhatsAppSchema);
      created(res, await service.connectWhatsApp(claimsOf(req).userId, input, requestMeta(req)));
    },
  );

  router.post(
    "/api/v1/communications/accounts/:id/disconnect",
    ...guard(P.CommunicationsSend, P.CommunicationsManage),
    jsonBody,
    async (req, res) => {
      decodeJson(req, emptyBodySchema);
      const claims = claimsOf(req);
      const canManage = claims.permissions.includes(P.CommunicationsManage);
      ok(
        res,
        await service.disconnectAccount(claims.userId, String(req.params.id ?? ""), canManage, requestMeta(req)),
      );
    },
  );

  router.get(
    "/api/v1/communications/whatsapp/conversations",
    ...guard(P.CommunicationsView, P.CommunicationsSend),
    async (req, res) => {
      const [limit, offset] = page(req);
      const { items, total } = await service.listWhatsAppConversations(queryParam(req, "q"), limit, offset);
      listed(res, items, total, limit, offset);
    },
  );

  router.get(
    "/api/v1/communications/whatsapp/messages",
    ...guard(P.CommunicationsView, P.CommunicationsSend),
    async (req, res) => {
      const [limit, offset] = page(req);
      const q = (k: string) => queryParam(req, k);
      const { items, total } = await service.listWhatsApp(
        q("customerId"),
        q("dealId"),
        q("leadId"),
        q("conversationKey"),
        limit,
        offset,
      );
      listed(res, items, total, limit, offset);
    },
  );

  router.post("/api/v1/communications/whatsapp/send", ...guard(P.CommunicationsSend), jsonBody, async (req, res) => {
    const input = decodeJson(req, sendWhatsAppSchema);
    created(res, await service.sendWhatsApp(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get("/api/v1/communications/twilio/calls", ...guard(P.CommunicationsView, P.CommunicationsSend), async (req, res) => {
    const [limit, offset] = page(req);
    const q = (k: string) => queryParam(req, k);
    const { items, total } = await service.listCalls(q("customerId"), q("dealId"), q("leadId"), limit, offset);
    listed(res, items, total, limit, offset);
  });

  router.post("/api/v1/communications/twilio/calls", ...guard(P.CommunicationsSend), jsonBody, async (req, res) => {
    const input = decodeJson(req, placeCallSchema);
    created(res, await service.placeCall(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.get(
    "/api/v1/communications/whatsapp/calls",
    ...guard(P.CommunicationsView, P.CommunicationsSend),
    async (req, res) => {
      const [limit, offset] = page(req);
      const q = (k: string) => queryParam(req, k);
      const active = q("active") === "1" || q("active") === "true";
      const { items, total } = await service.listWhatsAppCalls(
        q("customerId"),
        q("dealId"),
        q("leadId"),
        q("status"),
        active,
        limit,
        offset,
      );
      listed(res, items, total, limit, offset);
    },
  );

  router.get(
    "/api/v1/communications/whatsapp/calls/:id",
    ...guard(P.CommunicationsView, P.CommunicationsSend),
    async (req, res) => {
      ok(res, await service.getWhatsAppCall(String(req.params.id ?? "")));
    },
  );

  router.post(
    "/api/v1/communications/whatsapp/call-permission",
    ...guard(P.CommunicationsSend),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, callPermissionSchema);
      created(res, await service.requestCallPermission(claimsOf(req).userId, input, requestMeta(req)));
    },
  );

  router.post("/api/v1/communications/whatsapp/calls", ...guard(P.CommunicationsSend), jsonBody, async (req, res) => {
    const input = decodeJson(req, initiateWaCallSchema);
    created(res, await service.initiateWhatsAppCall(claimsOf(req).userId, input, requestMeta(req)));
  });

  router.post(
    "/api/v1/communications/whatsapp/calls/:id/pre-accept",
    ...guard(P.CommunicationsSend),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, waCallSignalSchema);
      ok(res, await service.preAcceptWhatsAppCall(claimsOf(req).userId, String(req.params.id ?? ""), input, requestMeta(req)));
    },
  );

  router.post(
    "/api/v1/communications/whatsapp/calls/:id/accept",
    ...guard(P.CommunicationsSend),
    jsonBody,
    async (req, res) => {
      const input = decodeJson(req, waCallSignalSchema);
      ok(res, await service.acceptWhatsAppCall(claimsOf(req).userId, String(req.params.id ?? ""), input, requestMeta(req)));
    },
  );

  router.post(
    "/api/v1/communications/whatsapp/calls/:id/reject",
    ...guard(P.CommunicationsSend),
    jsonBody,
    async (req, res) => {
      decodeJson(req, emptyBodySchema);
      ok(res, await service.rejectWhatsAppCall(claimsOf(req).userId, String(req.params.id ?? ""), requestMeta(req)));
    },
  );

  router.post(
    "/api/v1/communications/whatsapp/calls/:id/terminate",
    ...guard(P.CommunicationsSend),
    jsonBody,
    async (req, res) => {
      decodeJson(req, emptyBodySchema);
      ok(res, await service.terminateWhatsAppCall(claimsOf(req).userId, String(req.params.id ?? ""), requestMeta(req)));
    },
  );

  // Provider webhooks: public, authenticity validated per provider (no JWT).
  router.get("/api/v1/webhooks/meta/whatsapp", async (req, res) => {
    const out = await service.verifyMetaWhatsApp(queryParam(req, "hub.mode"), queryParam(req, "hub.verify_token"), queryParam(req, "hub.challenge"));
    if (out === null) {
      httpError(res, 403, "forbidden");
      return;
    }
    res.status(200).setHeader("Content-Type", "text/plain");
    res.end(out);
  });

  router.post("/api/v1/webhooks/meta/whatsapp", async (req, res) => {
    const { body } = await readBody(req, META_BODY_LIMIT, true);
    await service.handleMetaWhatsAppWebhook(req.get("X-Hub-Signature-256") ?? "", body);
    res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`{"success":true}`);
  });

  router.post(TWILIO_STATUS_PATH, async (req, res) => {
    const form = await parsePostForm(req);
    if (form === null) throw AppError.validation("invalid form");
    const query = rawQuery(req);
    await service.handleTwilioStatus(req.get("X-Twilio-Signature") ?? "", query === "" ? TWILIO_STATUS_PATH : `${TWILIO_STATUS_PATH}?${query}`, form);
    res.status(200).setHeader("Content-Type", "text/xml; charset=utf-8");
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  });

  return router;
}
