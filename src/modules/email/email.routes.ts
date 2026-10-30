import type { Request, Response, Router } from "express";
import { z } from "zod";
import { atoi, queryParam } from "../../lib/query.js";
import { readBody } from "../../lib/raw-body.js";
import { pathParam, requestMetaFirstHopWithPort } from "../../lib/request-meta.js";
import { created, ok } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { bool, decodeJson, optionalBool, optionalString, str, stringArray } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";
import { accountJson, messageJson, threadJson, type Message, type Thread } from "./email.repository.js";
import type { EmailService } from "./email.service.js";

const PUBSUB_BODY_LIMIT = 1 << 20;

const associateSchema = z.strictObject({ leadId: optionalString(), customerId: optionalString(), dealId: optionalString() });
const patchThreadSchema = z.strictObject({ starred: optionalBool(), archived: optionalBool() });

const composeSchema = z.strictObject({
  accountId: str(),
  to: stringArray(),
  cc: stringArray(),
  bcc: stringArray(),
  subject: str(),
  bodyHtml: str(),
  bodyText: str(),
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
  inReplyTo: optionalString(),
  threadId: optionalString(),
  scheduledAt: optionalString(),
  send: bool(),
});

const draftSchema = z.strictObject({
  to: stringArray(),
  cc: stringArray(),
  bcc: stringArray(),
  subject: optionalString(),
  bodyHtml: optionalString(),
  bodyText: optionalString(),
});

const previewSchema = z.strictObject({
  subject: str(),
  bodyHtml: str(),
  bodyText: str(),
  leadId: optionalString(),
  customerId: optionalString(),
});

const templateSchema = z.strictObject({
  name: str(),
  subject: str(),
  bodyHtml: str(),
  category: str(),
  variables: stringArray(),
  isActive: optionalBool(),
  teamId: optionalString(),
});

const threadOrNull = (t: Thread | null) => (t ? threadJson(t) : null);
const messageOrNull = (m: Message | null) => (m ? messageJson(m) : null);

/** Go's json.NewDecoder(r.Body).Decode with the error ignored: redirectTo when it decodes as a string. */
async function lenientRedirectTo(req: Request): Promise<string> {
  const { body } = await readBody(req, Number.MAX_SAFE_INTEGER, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  let out = "";
  for (const [k, v] of Object.entries(parsed)) if (k.toLowerCase() === "redirectto" && typeof v === "string") out = v;
  return out;
}

const htmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!);

/** http.Redirect with 302 for a GET. */
function goRedirect(res: Response, location: string): void {
  res.status(302).setHeader("Location", location);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<a href="${htmlEscape(location)}">Found</a>.\n\n`);
}

export function emailRouter(service: EmailService, guard: Guard): Router {
  const router = createRouter();

  router.get("/api/v1/email/health", ...guard(P.EmailView, P.EmailConfigure, P.EmailSend), async (_req, res) => {
    ok(res, await service.health());
  });

  router.get("/api/v1/email/accounts", ...guard(P.EmailView, P.EmailSend), async (req, res) => {
    const items = await service.listAccounts(claimsOf(req).userId);
    const integration = await service.health();
    ok(res, { accounts: items.map(accountJson), integration });
  });

  router.get("/api/v1/email/team/mailboxes", ...guard(P.EmailView, P.EmailManage), async (req, res) => {
    const data = await service.listTeamMailboxes(claimsOf(req));
    ok(res, {
      overview: data.overview,
      people: data.people.map((p) => ({
        userId: p.userId,
        fullName: p.fullName,
        email: p.email,
        mailbox: p.mailbox ? accountJson(p.mailbox) : null,
      })),
    });
  });

  const inviteSchema = z.strictObject({
    invitedUserId: str(),
    emailAddress: optionalString(),
    provider: optionalString(),
  });

  router.post("/api/v1/email/invites", ...guard(P.EmailManage, P.EmailView), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, inviteSchema);
    const createdInvite = await service.createConnectionInvite(
      claimsOf(req),
      in_.invitedUserId,
      in_.emailAddress ?? "",
      in_.provider ?? "imap",
    );
    created(res, { url: createdInvite.url, expiresAt: createdInvite.expiresAt });
  });

  router.get("/api/v1/email/invites/:token", ...guard(P.EmailSend, P.EmailView), async (req, res) => {
    const inv = await service.peekInvite(claimsOf(req), pathParam(req, "token"));
    if (!inv) {
      ok(res, { invite: null });
      return;
    }
    ok(res, { invite: inv });
  });

  const imapConnectSchema = z.strictObject({
    emailAddress: str(),
    password: str(),
    inviteToken: optionalString(),
  });

  router.post("/api/v1/email/imap/test", ...guard(P.EmailSend, P.EmailView), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, imapConnectSchema);
    const folders = await service.testImapConnection(in_.emailAddress, in_.password);
    ok(res, { ok: true, inbox: folders.inbox, sent: folders.sent || null });
  });

  router.post("/api/v1/email/imap/connect", ...guard(P.EmailSend, P.EmailView), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, imapConnectSchema);
    const acc = await service.connectImap(
      claimsOf(req),
      { emailAddress: in_.emailAddress, password: in_.password, inviteToken: in_.inviteToken },
      requestMetaFirstHopWithPort(req),
    );
    created(res, accountJson(acc));
  });

  router.post("/api/v1/email/google/connect", ...guard(P.EmailSend, P.EmailView), async (req, res) => {
    const redirectTo = await lenientRedirectTo(req);
    ok(res, { url: await service.startConnect(claimsOf(req), redirectTo) });
  });

  router.get("/api/v1/email/google/callback", async (req, res) => {
    const loc = await service.oauthCallback(queryParam(req, "code"), queryParam(req, "state"), queryParam(req, "error"));
    goRedirect(res, loc || "/");
  });

  router.post("/api/v1/email/accounts/:id/disconnect", ...guard(P.EmailSend, P.EmailView), async (req, res) => {
    await service.disconnect(claimsOf(req), pathParam(req, "id"), requestMetaFirstHopWithPort(req));
    ok(res, { disconnected: true });
  });

  router.post("/api/v1/email/sync/:accountId", ...guard(P.EmailView, P.EmailSend), async (req, res) => {
    await service.syncAccountFor(claimsOf(req), pathParam(req, "accountId"));
    ok(res, { synced: true });
  });

  router.post("/api/v1/webhooks/google/pubsub", async (req, res) => {
    const { body } = await readBody(req, PUBSUB_BODY_LIMIT, true);
    await service.handlePubSub(body);
    ok(res, { ok: true });
  });

  router.get("/api/v1/email/threads", ...guard(P.EmailView), async (req, res) => {
    const q = (k: string) => queryParam(req, k);
    const limit = atoi(q("limit"));
    const offset = atoi(q("offset"));
    const { items, total, counts } = await service.listThreads(claimsOf(req), {
      folder: q("folder"),
      q: q("q"),
      leadId: q("leadId"),
      customerId: q("customerId"),
      ownerUserId: q("salesExecutiveId"),
      direction: q("direction"),
      hasAttach: q("hasAttachments"),
      unread: q("unread"),
      dateFrom: q("dateFrom"),
      dateTo: q("dateTo"),
      limit,
      offset,
    });
    ok(res, { counts, limit: limit <= 0 ? 40 : limit, offset, threads: items.map(threadJson), total });
  });

  router.get("/api/v1/email/threads/:id", ...guard(P.EmailView), async (req, res) => {
    const d = await service.getThread(claimsOf(req), pathParam(req, "id"));
    ok(res, { thread: threadJson(d.thread), messages: d.messages.map(messageJson) });
  });

  router.patch("/api/v1/email/threads/:id", ...guard(P.EmailView, P.EmailSend), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, patchThreadSchema);
    ok(res, threadOrNull(await service.patchThread(claimsOf(req), pathParam(req, "id"), in_.starred, in_.archived)));
  });

  router.post("/api/v1/email/threads/:id/associate", ...guard(P.EmailManage, P.EmailSend, P.EmailView), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, associateSchema);
    ok(res, threadOrNull(await service.associate(claimsOf(req), pathParam(req, "id"), in_)));
  });

  router.post("/api/v1/email/messages", ...guard(P.EmailSend), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, composeSchema);
    created(res, messageOrNull(await service.compose(claimsOf(req), in_, requestMetaFirstHopWithPort(req))));
  });

  router.patch("/api/v1/email/messages/:id/draft", ...guard(P.EmailSend), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, draftSchema);
    ok(res, messageOrNull(await service.patchDraft(claimsOf(req), pathParam(req, "id"), in_)));
  });

  router.post("/api/v1/email/messages/:id/send", ...guard(P.EmailSend), async (req, res) => {
    ok(res, messageOrNull(await service.sendExisting(claimsOf(req), pathParam(req, "id"), requestMetaFirstHopWithPort(req))));
  });

  router.post("/api/v1/email/preview", ...guard(P.EmailSend, P.EmailView), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, previewSchema);
    ok(res, await service.preview(in_.subject, in_.bodyHtml, in_.bodyText, in_.leadId, in_.customerId));
  });

  router.get("/api/v1/email/templates", ...guard(P.EmailView, P.EmailManage), async (req, res) => {
    ok(res, await service.listTemplates(claimsOf(req)));
  });

  router.post("/api/v1/email/templates", ...guard(P.EmailManage), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, templateSchema);
    created(res, await service.createTemplate(claimsOf(req), in_));
  });

  router.patch("/api/v1/email/templates/:id", ...guard(P.EmailManage), jsonBody, async (req, res) => {
    const in_ = decodeJson(req, templateSchema);
    ok(res, await service.updateTemplate(pathParam(req, "id"), in_));
  });

  router.delete("/api/v1/email/templates/:id", ...guard(P.EmailManage), async (req, res) => {
    await service.deleteTemplate(pathParam(req, "id"));
    ok(res, { deleted: true });
  });

  return router;
}
