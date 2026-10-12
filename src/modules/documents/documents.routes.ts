import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { InvalidMultipartError, parseMultipart, type MultipartForm } from "../../lib/multipart.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMetaFirstHop } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import type { Claims } from "../auth/types.js";
import { resolve } from "../datascope/datascope.js";
import { Records, requireRecord } from "../datascope/record.js";
import { P } from "../permissions/permissions.js";
import { goPathBase, type DocumentsService } from "./documents.service.js";
import { inlineContentType } from "./preview.js";

const requestSchema = z.strictObject({
  name: str(),
  type: str(),
  category: str(),
  leadId: optionalString(),
  customerId: optionalString(),
  dealId: optionalString(),
  expiryDate: optionalString(),
  notes: str(),
  status: str(),
});

const updateSchema = z.strictObject({
  name: optionalString(),
  type: optionalString(),
  category: optionalString(),
  expiryDate: optionalString(),
  notes: optionalString(),
  status: optionalString(),
});

const rejectSchema = z.strictObject({ reason: str() });

/** 404s when a document would be attached to a lead, customer or deal the caller can't see. */
async function requireParents(db: Database, claims: Claims, ids: { leadId?: string; customerId?: string; dealId?: string }) {
  const parents = [
    [ids.leadId, Records.Leads],
    [ids.customerId, Records.Customers],
    [ids.dealId, Records.Deals],
  ] as const;
  for (const [id, rec] of parents) {
    if (id === undefined || id.trim() === "") continue;
    await requireRecord(db, claims, rec, id.trim(), P.DocumentsCreate);
  }
}

const orUndefined = (v: string): string | undefined => (v === "" ? undefined : v);

/** Go writes header values as raw UTF-8 bytes, with CR/LF replaced by spaces; Node sends strings as latin1. */
const rawHeader = (v: string): string => Buffer.from(v.replace(/[\r\n]/g, " "), "utf8").toString("latin1");

export function documentsRouter(service: DocumentsService, db: Database, guard: Guard): Router {
  const router = createRouter();
  const view = [P.DocumentsView];
  const edit = [P.DocumentsEdit];
  const del = [P.DocumentsDelete];
  const create = [P.DocumentsCreate];

  router.get("/api/v1/documents", ...guard(...view), async (req, res) => {
    const q = (k: string) => queryParam(req, k);
    let limit = atoi(q("limit"));
    const offset = atoi(q("offset"));
    const claims = claimsOf(req);
    const scope = resolve(claims, P.DocumentsView, "");
    const { items, total } = await service.list({
      scope,
      viewer: claims,
      customerId: q("customerId"),
      dealId: q("dealId"),
      leadId: q("leadId"),
      status: q("status"),
      type: q("type"),
      q: q("q"),
      limit,
      offset,
    });
    if (limit <= 0) limit = 50;
    sendJson(res, 200, {
      success: true,
      data: items,
      meta: { total, limit, offset, hasMore: offset + items.length < total },
    });
  });

  router.post("/api/v1/documents/request", ...guard(...create), jsonBody, async (req, res) => {
    const input = decodeJson(req, requestSchema);
    const claims = claimsOf(req);
    await requireParents(db, claims, input);
    created(res, await service.request(claims.userId, input, requestMetaFirstHop(req)));
  });

  const upload = async (req: Request, res: Response) => {
    let form: MultipartForm;
    try {
      form = await parseMultipart(req);
    } catch (err) {
      if (err instanceof InvalidMultipartError) throw AppError.validation("invalid multipart form");
      throw err;
    }
    try {
      await handleUpload(req, res, form);
    } finally {
      await form.cleanup();
    }
  };

  const handleUpload = async (req: Request, res: Response, form: MultipartForm) => {
    const claims = claimsOf(req);
    const file = form.file("file");
    if (!file) throw AppError.validation("file is required");
    const meta = requestMetaFirstHop(req);
    const upload = { filename: file.filename, mimeType: file.mimeType || "application/octet-stream", open: file.open };

    const docId = form.value("documentId").trim() || pathParam(req, "id");
    if (docId !== "") {
      await requireRecord(db, claims, Records.Documents, docId, P.DocumentsCreate);
      ok(res, await service.uploadToExisting(claims.userId, docId, upload, meta));
      return;
    }

    const input = {
      name: form.value("name") || file.filename,
      type: form.value("type") || form.value("category"),
      category: form.value("category"),
      leadId: orUndefined(form.value("leadId")),
      customerId: orUndefined(form.value("customerId")),
      dealId: orUndefined(form.value("dealId")),
      expiryDate: orUndefined(form.value("expiryDate")),
      notes: form.value("notes"),
    };
    await requireParents(db, claims, input);
    created(res, await service.uploadNew(claims.userId, input, upload, meta));
  };

  router.post("/api/v1/documents/upload", ...guard(...create), upload);

  router.get("/api/v1/documents/:id", ...guard(...view), inScope(db, Records.Documents, view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/documents/:id", ...guard(...edit), inScope(db, Records.Documents, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req).userId, pathParam(req, "id"), input, requestMetaFirstHop(req)));
  });

  router.delete("/api/v1/documents/:id", ...guard(...del), inScope(db, Records.Documents, del), async (req, res) => {
    await service.delete(claimsOf(req).userId, pathParam(req, "id"), requestMetaFirstHop(req));
    ok(res, { deleted: true });
  });

  router.get("/api/v1/documents/:id/download", ...guard(...view), inScope(db, Records.Documents, view), async (req, res) => {
    const { body, doc } = await service.open(pathParam(req, "id"));
    // ?inline=1 asks to view the file in the browser; only safe types are shown, everything else still downloads.
    const inline = queryParam(req, "inline") === "1" ? inlineContentType(doc.mimeType, doc.name) : null;
    res.status(200);
    res.setHeader("Content-Type", rawHeader(inline ?? (doc.mimeType || "application/octet-stream")));
    res.setHeader("Content-Disposition", rawHeader(`${inline ? "inline" : "attachment"}; filename="${goPathBase(doc.name)}"`));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (doc.sizeBytes > 0) res.setHeader("Content-Length", String(doc.sizeBytes));
    await new Promise<void>((done) => {
      body.on("error", () => {
        res.destroy();
        done();
      });
      res.on("close", () => {
        body.destroy();
        done();
      });
      body.pipe(res);
    });
  });

  router.post("/api/v1/documents/:id/upload", ...guard(...create), inScope(db, Records.Documents, create), upload);

  router.post("/api/v1/documents/:id/verify", ...guard(...edit), inScope(db, Records.Documents, edit), async (req, res) => {
    ok(res, await service.verify(claimsOf(req).userId, pathParam(req, "id"), requestMetaFirstHop(req)));
  });

  router.post("/api/v1/documents/:id/reject", ...guard(...edit), inScope(db, Records.Documents, edit), jsonBody, async (req, res) => {
    const { reason } = decodeJson(req, rejectSchema);
    ok(res, await service.reject(claimsOf(req).userId, pathParam(req, "id"), reason, requestMetaFirstHop(req)));
  });

  return router;
}
