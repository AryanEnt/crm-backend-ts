import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { InvalidMultipartError, parseMultipart, type MultipartForm } from "../../lib/multipart.js";
import { atoi, queryParam } from "../../lib/query.js";
import { pathParam, requestMetaFirstHop } from "../../lib/request-meta.js";
import { created, ok, sendJson } from "../../lib/response.js";
import { createRouter } from "../../lib/router.js";
import { decodeJson, optionalString, str, stringArray } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { claimsOf } from "../auth/auth.middleware.js";
import { inScope, type Guard } from "../auth/guard.js";
import type { Claims } from "../auth/types.js";
import { resolve } from "../datascope/datascope.js";
import { Records, requireRecord } from "../datascope/record.js";
import { expandImplies, P, Role } from "../permissions/permissions.js";
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
  viewerUserIds: stringArray(),
});

const updateSchema = z.strictObject({
  name: optionalString(),
  type: optionalString(),
  category: optionalString(),
  expiryDate: optionalString(),
  notes: optionalString(),
  status: optionalString(),
  viewerUserIds: stringArray(),
});

/** Multipart may send viewerUserIds as JSON array or comma-separated UUIDs. */
function parseViewerUserIds(form: MultipartForm): string[] | undefined {
  const raw = form.value("viewerUserIds").trim();
  if (raw === "") return undefined;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed.map((v) => String(v).trim()).filter((v) => v !== "");
    } catch {
      throw AppError.validation("invalid viewerUserIds");
    }
  }
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

const rejectSchema = z.strictObject({ reason: str() });

function isScreenshotType(type: string, category: string): boolean {
  return type.trim().toLowerCase() === "screenshot" || category.trim().toLowerCase() === "screenshot";
}

function hasPerm(claims: Claims, ...codes: string[]): boolean {
  return expandImplies(claims.permissions).hasAny(...codes);
}

/** 404s when a document would be attached to a lead, customer or deal the caller can't see. */
async function requireParents(
  db: Database,
  claims: Claims,
  ids: { leadId?: string; customerId?: string; dealId?: string },
  ...perms: string[]
) {
  const parents = [
    [ids.leadId, Records.Leads],
    [ids.customerId, Records.Customers],
    [ids.dealId, Records.Deals],
  ] as const;
  for (const [id, rec] of parents) {
    if (id === undefined || id.trim() === "") continue;
    await requireRecord(db, claims, rec, id.trim(), ...perms);
  }
}

/** SE may upload screenshots onto leads they can edit; TL/admin use documents:create. */
async function assertCanUploadNew(
  db: Database,
  claims: Claims,
  input: { type: string; category: string; leadId?: string; customerId?: string; dealId?: string },
) {
  if (hasPerm(claims, P.DocumentsCreate)) {
    await requireParents(db, claims, input, P.DocumentsCreate);
    return;
  }
  const leadId = input.leadId?.trim() ?? "";
  if (
    claims.roleCode === Role.SalesExecutive &&
    isScreenshotType(input.type, input.category) &&
    leadId !== "" &&
    !input.customerId &&
    !input.dealId
  ) {
    await requireRecord(db, claims, Records.Leads, leadId, P.LeadsEdit, P.LeadsView);
    return;
  }
  throw AppError.forbidden("insufficient permissions");
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
      excludeScreenshots: q("excludeScreenshots") === "1" || q("excludeScreenshots") === "true",
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
    created(res, await service.request(claims, input, requestMetaFirstHop(req)));
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
      if (!hasPerm(claims, P.DocumentsCreate)) throw AppError.forbidden("insufficient permissions");
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
      viewerUserIds: parseViewerUserIds(form),
    };
    await assertCanUploadNew(db, claims, input);
    created(res, await service.uploadNew(claims, input, upload, meta));
  };

  // Auth only — create vs SE lead-screenshot is decided in handleUpload.
  router.post("/api/v1/documents/upload", ...guard(), upload);

  router.get("/api/v1/documents/:id", ...guard(...view), inScope(db, Records.Documents, view), async (req, res) => {
    ok(res, await service.get(pathParam(req, "id")));
  });

  router.patch("/api/v1/documents/:id", ...guard(...edit), inScope(db, Records.Documents, edit), jsonBody, async (req, res) => {
    const input = decodeJson(req, updateSchema);
    ok(res, await service.update(claimsOf(req), pathParam(req, "id"), input, requestMetaFirstHop(req)));
  });

  router.delete("/api/v1/documents/:id", ...guard(), async (req, res) => {
    const claims = claimsOf(req);
    const id = pathParam(req, "id");
    if (hasPerm(claims, P.DocumentsDelete)) {
      await requireRecord(db, claims, Records.Documents, id, P.DocumentsDelete);
    } else if (claims.roleCode === Role.SalesExecutive) {
      // SE may remove screenshots on leads they can see.
      await requireRecord(db, claims, Records.Documents, id, P.DocumentsView);
      const doc = await service.get(id);
      if (!isScreenshotType(doc.type, doc.category) || !doc.leadId) {
        throw AppError.forbidden("insufficient permissions");
      }
      await requireRecord(db, claims, Records.Leads, doc.leadId, P.LeadsEdit, P.LeadsView);
    } else {
      throw AppError.forbidden("insufficient permissions");
    }
    await service.delete(claims.userId, id, requestMetaFirstHop(req));
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
