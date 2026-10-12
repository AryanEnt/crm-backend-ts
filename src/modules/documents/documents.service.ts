import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { parseOptionalTime } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";
import type { Claims } from "../auth/types.js";
import type { AutomationEmitter } from "../automation/emitter.js";
import { and, type Predicate, type Visibility } from "../datascope/datascope.js";
import { appendRecordScope, Records } from "../datascope/record.js";
import { newObjectKey, type Store } from "../storage/storage.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";

export const DocumentStatus = {
  Requested: "requested",
  Uploaded: "uploaded",
  Verified: "verified",
  Rejected: "rejected",
  Missing: "missing",
  Expired: "expired",
} as const;

const VALID_STATUSES = new Set<string>(Object.values(DocumentStatus));

/** Go documents.Document, in struct field order. */
export interface DocumentRecord {
  id: string;
  name: string;
  type: string;
  category: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  fileKey: string;
  storageProvider: string;
  notes: string;
  rejectedReason: string;
  leadId: string | null;
  leadName: string | null;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  requestedDate: Date | null;
  uploadedDate: Date | null;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentListFilter {
  customerId: string;
  dealId: string;
  leadId: string;
  status: string;
  type: string;
  q: string;
  limit: number;
  offset: number;
  scope: Visibility;
  viewer: Claims;
}

export interface RequestDocumentInput {
  name: string;
  type: string;
  category: string;
  leadId: string | undefined;
  customerId: string | undefined;
  dealId: string | undefined;
  expiryDate: string | undefined;
  notes: string;
  status: string;
}

export interface UpdateDocumentInput {
  name: string | undefined;
  type: string | undefined;
  category: string | undefined;
  expiryDate: string | undefined;
  notes: string | undefined;
  status: string | undefined;
}

export interface NewUpload {
  name: string;
  type: string;
  category: string;
  leadId: string | undefined;
  customerId: string | undefined;
  dealId: string | undefined;
  expiryDate: string | undefined;
  notes: string;
}

export interface FileUpload {
  filename: string;
  mimeType: string;
  open(): Readable;
}

const docSelect = sql`
  SELECT d.id::text AS "id", d.name, d.doc_type AS "type", d.category, d.status, d.mime_type AS "mimeType",
    d.size_bytes AS "sizeBytes", d.file_key AS "fileKey", d.storage_provider AS "storageProvider", d.notes,
    d.rejected_reason AS "rejectedReason",
    d.lead_id::text AS "leadId", lead.full_name AS "leadName", d.customer_id::text AS "customerId", c.full_name AS "customerName",
    d.deal_id::text AS "dealId", deal.title AS "dealTitle",
    d.uploaded_by::text AS "uploadedBy", ub.full_name AS "uploadedByName",
    d.verified_by::text AS "verifiedBy", vb.full_name AS "verifiedByName",
    d.requested_at AS "requestedDate", d.uploaded_at AS "uploadedDate", d.expires_at AS "expiryDate",
    d.verified_at AS "verifiedAt", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM documents d
  LEFT JOIN leads lead ON lead.id = d.lead_id
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN deals deal ON deal.id = d.deal_id
  LEFT JOIN users ub ON ub.id = d.uploaded_by
  LEFT JOIN users vb ON vb.id = d.verified_by`;

const blankToNull = (v: string | undefined | null): string | null => (v === undefined || v === null || v.trim() === "" ? null : v);

function parseExpiry(v: string | undefined): Date | null {
  try {
    return parseOptionalTime(v);
  } catch {
    throw AppError.validation("invalid expiryDate");
  }
}

/** Storage prefix: the customer, else the deal, else the lead the file belongs to. */
function storagePrefix(customerId: string | null | undefined, dealId: string | null | undefined, leadId: string | null | undefined): string {
  if (customerId) return `documents/customers/${customerId}`;
  if (dealId) return `documents/deals/${dealId}`;
  if (leadId) return `documents/leads/${leadId}`;
  return "documents";
}

function isScreenshot(type: string, category: string): boolean {
  return type.trim().toLowerCase() === "screenshot" || category.trim().toLowerCase() === "screenshot";
}

function screenshotPrefix(customerId: string | null | undefined, dealId: string | null | undefined, leadId: string | null | undefined): string {
  if (leadId) return `screenshots/leads/${leadId}`;
  if (customerId) return `screenshots/customers/${customerId}`;
  if (dealId) return `screenshots/deals/${dealId}`;
  return "screenshots";
}

export class DocumentsRepository {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<DocumentRecord | null> {
    const r = await sql<DocumentRecord>`${docSelect} WHERE d.id = ${id}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async list(f: DocumentListFilter): Promise<{ items: DocumentRecord[]; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 50 : f.limit;
    let where: Predicate[] = [sql`1=1`];
    if (f.customerId !== "") where.push(sql`d.customer_id::text = ${f.customerId}`);
    if (f.dealId !== "") where.push(sql`d.deal_id::text = ${f.dealId}`);
    if (f.leadId !== "") where.push(sql`d.lead_id::text = ${f.leadId}`);
    if (f.status !== "") where.push(sql`d.status = ${f.status}`);
    if (f.type !== "") where.push(sql`d.doc_type = ${f.type}`);
    if (f.q !== "") {
      const like = `%${f.q.toLowerCase()}%`;
      where.push(sql`(lower(d.name) LIKE ${like} OR lower(d.doc_type) LIKE ${like})`);
    }
    where = appendRecordScope(Records.Documents, where, f.scope, f.viewer);
    const count = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM documents d WHERE ${and(where)}`.execute(this.db);
    const rows = await sql<DocumentRecord>`
      ${docSelect}
      WHERE ${and(where)}
      ORDER BY COALESCE(d.uploaded_at, d.requested_at, d.created_at) DESC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return { items: rows.rows, total: count.rows[0]?.total ?? 0 };
  }

  async insertRequested(in_: RequestDocumentInput, expires: Date | null, status: string): Promise<DocumentRecord | null> {
    const id = randomUUID();
    let docType = in_.type.trim();
    if (docType === "") docType = in_.category.trim();
    let category = in_.category.trim();
    if (category === "") category = docType;
    await sql`
      INSERT INTO documents (
        id, name, category, doc_type, status, requested_at, expires_at, notes, lead_id, customer_id, deal_id
      ) VALUES (
        ${id}, ${in_.name.trim()}, ${category}, ${docType}, ${status}, ${new Date()}, ${expires}, ${in_.notes},
        ${blankToNull(in_.leadId)}, ${blankToNull(in_.customerId)}, ${blankToNull(in_.dealId)}
      )`.execute(this.db);
    return this.get(id);
  }

  async createUploaded(
    in_: NewUpload,
    actorId: string,
    file: { key: string; provider: string; mime: string; size: number },
    expires: Date | null,
  ): Promise<DocumentRecord | null> {
    const id = randomUUID();
    const docType = in_.type === "" ? in_.category : in_.type;
    const category = in_.category === "" ? docType : in_.category;
    await sql`
      INSERT INTO documents (
        id, name, category, doc_type, status, file_key, storage_provider, mime_type, size_bytes,
        uploaded_by, uploaded_at, expires_at, notes, lead_id, customer_id, deal_id
      ) VALUES (
        ${id}, ${in_.name}, ${category}, ${docType}, 'uploaded', ${file.key}, ${file.provider}, ${file.mime}, ${file.size},
        ${blankToNull(actorId)}, ${new Date()}, ${expires}, ${in_.notes},
        ${blankToNull(in_.leadId)}, ${blankToNull(in_.customerId)}, ${blankToNull(in_.dealId)}
      )`.execute(this.db);
    return this.get(id);
  }

  async markUploaded(
    id: string,
    actorId: string,
    file: { key: string; provider: string; mime: string; size: number },
  ): Promise<DocumentRecord | null> {
    await sql`
      UPDATE documents SET
        file_key = ${file.key}, storage_provider = ${file.provider}, mime_type = ${file.mime}, size_bytes = ${file.size},
        uploaded_by = ${blankToNull(actorId)}, uploaded_at = ${new Date()}, status = 'uploaded',
        rejected_reason = '', verified_by = NULL, verified_at = NULL
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async verify(id: string, actorId: string): Promise<DocumentRecord | null> {
    await sql`
      UPDATE documents SET status = 'verified', verified_by = ${actorId}, verified_at = ${new Date()}, rejected_reason = ''
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async reject(id: string, actorId: string, reason: string): Promise<DocumentRecord | null> {
    await sql`
      UPDATE documents SET status = 'rejected', verified_by = ${actorId}, verified_at = ${new Date()}, rejected_reason = ${reason}
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async updateMeta(id: string, cur: DocumentRecord, in_: UpdateDocumentInput, expires: Date | null, setExpires: boolean) {
    await sql`
      UPDATE documents SET
        name = ${in_.name !== undefined ? in_.name.trim() : cur.name},
        doc_type = ${in_.type !== undefined ? in_.type.trim() : cur.type},
        category = ${in_.category !== undefined ? in_.category.trim() : cur.category},
        notes = ${in_.notes ?? cur.notes},
        status = ${in_.status !== undefined ? in_.status.trim() : cur.status},
        expires_at = ${setExpires ? expires : cur.expiryDate}
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM documents WHERE id = ${id}`.execute(this.db);
  }

  async refreshExpired(): Promise<void> {
    await sql`
      UPDATE documents SET status = 'expired'
      WHERE expires_at IS NOT NULL AND expires_at < NOW()
        AND status IN ('uploaded','verified','requested')`.execute(this.db);
  }
}

export class DocumentsService {
  readonly repo: DocumentsRepository;

  constructor(
    db: Database,
    private readonly store: Store,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    private readonly hooks: AutomationEmitter,
    private readonly screenshots: Store | null = null,
  ) {
    this.repo = new DocumentsRepository(db);
  }

  private destination(type: string, category: string, customerId?: string | null, dealId?: string | null, leadId?: string | null): { store: Store; prefix: string } {
    if (!isScreenshot(type, category)) {
      return { store: this.store, prefix: storagePrefix(customerId, dealId, leadId) };
    }
    if (!this.screenshots) throw AppError.validation("screenshot storage is not configured");
    return { store: this.screenshots, prefix: screenshotPrefix(customerId, dealId, leadId) };
  }

  private storeOf(provider: string): Store {
    if (provider.trim().toLowerCase() !== "r2") return this.store;
    if (!this.screenshots) throw AppError.validation("screenshot storage is not configured");
    return this.screenshots;
  }

  private async refreshExpired(): Promise<void> {
    await this.repo.refreshExpired().catch(() => undefined);
  }

  async list(f: DocumentListFilter): Promise<{ items: DocumentRecord[]; total: number }> {
    await this.refreshExpired();
    return internal("failed to list documents", () => this.repo.list(f));
  }

  async get(id: string): Promise<DocumentRecord> {
    await this.refreshExpired();
    const d = await internal("failed to load document", () => this.repo.get(id));
    if (!d) throw AppError.notFound("document not found");
    return d;
  }

  async request(actorId: string, in_: RequestDocumentInput, meta: RequestMeta): Promise<DocumentRecord> {
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    if (!blankToNull(in_.leadId) && !blankToNull(in_.customerId) && !blankToNull(in_.dealId)) {
      throw AppError.validation("document must belong to a lead, customer, or deal");
    }
    const status = in_.status === DocumentStatus.Missing ? DocumentStatus.Missing : DocumentStatus.Requested;
    const expires = parseExpiry(in_.expiryDate);
    const d = await internal("failed to request document", async () => {
      const row = await this.repo.insertRequested(in_, expires, status);
      if (!row) throw new Error("inserted document not found");
      return row;
    });
    await this.audit.record(actorId, "document.requested", "document", d.id, { name: d.name, type: d.type, status: d.status }, meta);
    await this.emit(actorId, TimelineEvent.DocumentRequested, "Document requested", `${d.name} (${d.type})`, d);
    return d;
  }

  async uploadNew(actorId: string, in_: NewUpload, file: FileUpload, meta: RequestMeta): Promise<DocumentRecord> {
    const input = { ...in_, name: in_.name.trim() === "" ? file.filename : in_.name };
    if (input.name.trim() === "") throw AppError.validation("name is required");
    if (!blankToNull(input.leadId) && !blankToNull(input.customerId) && !blankToNull(input.dealId)) {
      throw AppError.validation("document must belong to a lead, customer, or deal");
    }
    const expires = parseExpiry(input.expiryDate);
    const dest = this.destination(input.type, input.category, input.customerId, input.dealId, input.leadId);
    const stored = await this.put(dest.store, dest.prefix, file);
    let d: DocumentRecord;
    try {
      const row = await this.repo.createUploaded(input, actorId, stored, expires);
      if (!row) throw new Error("inserted document not found");
      d = row;
    } catch (err) {
      await dest.store.delete(stored.key).catch(() => undefined);
      throw AppError.internal("failed to save document", err);
    }
    await this.audit.record(actorId, "document.uploaded", "document", d.id, { name: d.name, type: d.type, size: d.sizeBytes }, meta);
    await this.afterUpload(actorId, d);
    return d;
  }

  async uploadToExisting(actorId: string, id: string, file: FileUpload, meta: RequestMeta): Promise<DocumentRecord> {
    const current = await this.get(id);
    const dest = this.destination(current.type, current.category, current.customerId, current.dealId, current.leadId);
    const stored = await this.put(dest.store, dest.prefix, file);
    let d: DocumentRecord;
    try {
      const row = await this.repo.markUploaded(id, actorId, stored);
      if (!row) throw new Error("updated document not found");
      d = row;
    } catch (err) {
      await dest.store.delete(stored.key).catch(() => undefined);
      throw AppError.internal("failed to update document", err);
    }
    if (current.fileKey !== "" && current.fileKey !== stored.key) {
      try {
        await this.storeOf(current.storageProvider).delete(current.fileKey);
      } catch {
        // Best-effort, as in Go: an unavailable store or failed delete leaves the old object.
      }
    }
    await this.audit.record(actorId, "document.uploaded", "document", d.id, { name: d.name, type: d.type }, meta);
    await this.afterUpload(actorId, d);
    return d;
  }

  private async put(store: Store, prefix: string, file: FileUpload) {
    const key = newObjectKey(prefix, file.filename);
    try {
      const m = await store.put(key, file.open(), file.mimeType);
      return { key: m.key, provider: m.provider, mime: file.mimeType, size: m.size };
    } catch (err) {
      throw AppError.internal("failed to store file", err);
    }
  }

  private async afterUpload(actorId: string, d: DocumentRecord): Promise<void> {
    await this.emit(actorId, TimelineEvent.DocumentUploaded, "Document uploaded", d.name, d);
    await this.hooks.emit("document.uploaded", "document", d.id, {
      name: d.name,
      leadId: d.leadId,
      dealId: d.dealId,
      customerId: d.customerId,
    });
  }

  async open(id: string): Promise<{ body: Readable; doc: DocumentRecord }> {
    const d = await this.get(id);
    if (d.fileKey === "") throw AppError.validation("document has no uploaded file");
    try {
      const { body } = await this.storeOf(d.storageProvider).open(d.fileKey);
      return { body, doc: d };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.internal("failed to open file", err);
    }
  }

  async verify(actorId: string, id: string, meta: RequestMeta): Promise<DocumentRecord> {
    const current = await this.get(id);
    if (current.status !== DocumentStatus.Uploaded && current.status !== DocumentStatus.Rejected) {
      throw AppError.validation("only uploaded or rejected documents can be verified");
    }
    if (current.fileKey === "") throw AppError.validation("cannot verify a document without a file");
    const d = await this.mutate("failed to verify document", () => this.repo.verify(id, actorId));
    await this.audit.record(actorId, "document.verified", "document", id, { name: d.name }, meta);
    await this.emit(actorId, TimelineEvent.DocumentVerified, "Document verified", d.name, d);
    return d;
  }

  async reject(actorId: string, id: string, reasonRaw: string, meta: RequestMeta): Promise<DocumentRecord> {
    const current = await this.get(id);
    if (current.status !== DocumentStatus.Uploaded && current.status !== DocumentStatus.Verified) {
      throw AppError.validation("only uploaded or verified documents can be rejected");
    }
    const reason = reasonRaw.trim();
    if (reason === "") throw AppError.validation("rejection reason is required");
    const d = await this.mutate("failed to reject document", () => this.repo.reject(id, actorId, reason));
    await this.audit.record(actorId, "document.rejected", "document", id, { name: d.name, reason }, meta);
    await this.emit(actorId, TimelineEvent.DocumentRejected, "Document rejected", `${d.name}: ${reason}`, d);
    return d;
  }

  async update(actorId: string, id: string, in_: UpdateDocumentInput, meta: RequestMeta): Promise<DocumentRecord> {
    const current = await this.get(id);
    let expires: Date | null = null;
    const setExpires = in_.expiryDate !== undefined;
    if (setExpires) expires = parseExpiry(in_.expiryDate);
    if (in_.status !== undefined && !VALID_STATUSES.has(in_.status)) throw AppError.validation("invalid status");
    const d = await this.mutate("failed to update document", () => this.repo.updateMeta(id, current, in_, expires, setExpires));
    await this.audit.record(actorId, "document.updated", "document", id, { name: d.name, status: d.status }, meta);
    return d;
  }

  async delete(actorId: string, id: string, meta: RequestMeta): Promise<void> {
    const d = await this.get(id);
    await internal("failed to delete document", () => this.repo.delete(id));
    if (d.fileKey !== "") {
      try {
        await this.storeOf(d.storageProvider).delete(d.fileKey);
      } catch {
        // The document row is already gone; object cleanup is best-effort.
      }
    }
    await this.audit.record(actorId, "document.deleted", "document", id, { name: d.name }, meta);
  }

  private async mutate(message: string, fn: () => Promise<DocumentRecord | null>): Promise<DocumentRecord> {
    return internal(message, async () => {
      const d = await fn();
      if (!d) throw new Error("document not found after update");
      return d;
    });
  }

  private async emit(actorId: string, eventType: string, title: string, body: string, d: DocumentRecord): Promise<void> {
    await this.timeline.record({
      eventType,
      title,
      body,
      actorUserId: actorId,
      source: "crm",
      leadId: d.leadId,
      customerId: d.customerId,
      dealId: d.dealId,
      documentId: d.id,
      metadata: { documentId: d.id, name: d.name, type: d.type, status: d.status },
    });
  }
}

/** Go path.Base: the last slash-separated element ("." for an empty string). */
export function goPathBase(p: string): string {
  if (p === "") return ".";
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return path.posix.basename(trimmed);
}
