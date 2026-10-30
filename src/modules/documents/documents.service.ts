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
import { Role } from "../permissions/permissions.js";
import { newObjectKey, type Store } from "../storage/storage.js";
import { TimelineEvent, type TimelineService } from "../timeline/timeline.service.js";
import { isUuid } from "../../lib/uuid.js";

export const DocumentStatus = {
  Requested: "requested",
  Uploaded: "uploaded",
  Verified: "verified",
  Rejected: "rejected",
  Missing: "missing",
  Expired: "expired",
} as const;

export const ShareScope = {
  AllTeams: "all_teams",
  SelectedTeams: "selected_teams",
  AllTeamSes: "all_team_ses",
  SelectedSes: "selected_ses",
  None: "none",
} as const;

export type ShareScopeCode = (typeof ShareScope)[keyof typeof ShareScope];

const VALID_STATUSES = new Set<string>(Object.values(DocumentStatus));
const VALID_SHARE_SCOPES = new Set<string>(Object.values(ShareScope));

export interface DocumentSharePlan {
  shareScope: ShareScopeCode;
  teamIds: string[];
  userIds: string[];
}

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
  description: string;
  originalFilename: string;
  shareScope: ShareScopeCode | string;
  rejectedReason: string;
  leadId: string | null;
  leadName: string | null;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedByRole: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  requestedDate: Date | null;
  uploadedDate: Date | null;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Selected SE user IDs (and legacy viewers). */
  viewerUserIds: string[];
  sharedUserIds: string[];
  sharedTeamIds: string[];
  sharedTeamNames: string[];
}

export interface DocumentListFilter {
  customerId: string;
  dealId: string;
  leadId: string;
  status: string;
  type: string;
  q: string;
  uploadedBy: string;
  uploadedByRole: string;
  shareScope: string;
  teamId: string;
  createdFrom: string;
  createdTo: string;
  /** When true, hide lead screenshots from the Documents library list. */
  excludeScreenshots: boolean;
  limit: number;
  offset: number;
  scope: Visibility;
  viewer: Claims;
}

export interface ShareInput {
  shareScope: string | undefined;
  teamIds: string[] | undefined;
  viewerUserIds: string[] | undefined;
}

export interface RequestDocumentInput extends ShareInput {
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

export interface UpdateDocumentInput extends ShareInput {
  name: string | undefined;
  type: string | undefined;
  category: string | undefined;
  expiryDate: string | undefined;
  notes: string | undefined;
  status: string | undefined;
}

export interface NewUpload extends ShareInput {
  name: string;
  type: string;
  category: string;
  leadId: string | undefined;
  customerId: string | undefined;
  dealId: string | undefined;
  expiryDate: string | undefined;
  notes: string;
  originalFilename?: string;
}

export interface FileUpload {
  filename: string;
  mimeType: string;
  open(): Readable;
}

const docSelect = sql`
  SELECT d.id::text AS "id", d.name, d.doc_type AS "type", d.category, d.status, d.mime_type AS "mimeType",
    d.size_bytes AS "sizeBytes", d.file_key AS "fileKey", d.storage_provider AS "storageProvider", d.notes,
    d.notes AS "description", d.original_filename AS "originalFilename", d.share_scope AS "shareScope",
    d.rejected_reason AS "rejectedReason",
    d.lead_id::text AS "leadId", lead.full_name AS "leadName", d.customer_id::text AS "customerId", c.full_name AS "customerName",
    d.deal_id::text AS "dealId", deal.title AS "dealTitle",
    d.uploaded_by::text AS "uploadedBy", ub.full_name AS "uploadedByName", ubr.code AS "uploadedByRole",
    d.verified_by::text AS "verifiedBy", vb.full_name AS "verifiedByName",
    d.requested_at AS "requestedDate", d.uploaded_at AS "uploadedDate", d.expires_at AS "expiryDate",
    d.verified_at AS "verifiedAt", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
    COALESCE((
      SELECT array_agg(x ORDER BY x)
      FROM (
        SELECT ds.user_id::text AS x FROM document_shares ds
        WHERE ds.document_id = d.id AND ds.target_type = 'user' AND ds.user_id IS NOT NULL
        UNION
        SELECT dv.user_id::text AS x FROM document_viewers dv WHERE dv.document_id = d.id
      ) u
    ), '{}'::text[]) AS "viewerUserIds",
    COALESCE((
      SELECT array_agg(ds.user_id::text ORDER BY ds.user_id)
      FROM document_shares ds
      WHERE ds.document_id = d.id AND ds.target_type = 'user' AND ds.user_id IS NOT NULL
    ), '{}'::text[]) AS "sharedUserIds",
    COALESCE((
      SELECT array_agg(ds.team_id::text ORDER BY ds.team_id)
      FROM document_shares ds
      WHERE ds.document_id = d.id AND ds.target_type = 'team' AND ds.team_id IS NOT NULL
    ), '{}'::text[]) AS "sharedTeamIds",
    COALESCE((
      SELECT array_agg(t.name ORDER BY t.name)
      FROM document_shares ds
      JOIN teams t ON t.id = ds.team_id
      WHERE ds.document_id = d.id AND ds.target_type = 'team'
    ), '{}'::text[]) AS "sharedTeamNames"
  FROM documents d
  LEFT JOIN leads lead ON lead.id = d.lead_id
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN deals deal ON deal.id = d.deal_id
  LEFT JOIN users ub ON ub.id = d.uploaded_by
  LEFT JOIN roles ubr ON ubr.id = ub.role_id
  LEFT JOIN users vb ON vb.id = d.verified_by`;

const blankToNull = (v: string | undefined | null): string | null => (v === undefined || v === null || v.trim() === "" ? null : v);

function asTextArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function normalizeDoc(row: DocumentRecord): DocumentRecord {
  const viewerUserIds = asTextArray(row.viewerUserIds);
  const sharedUserIds = asTextArray(row.sharedUserIds);
  const sharedTeamIds = asTextArray(row.sharedTeamIds);
  const sharedTeamNames = asTextArray(row.sharedTeamNames);
  return {
    ...row,
    description: row.description ?? row.notes ?? "",
    originalFilename: row.originalFilename ?? "",
    shareScope: row.shareScope || ShareScope.None,
    viewerUserIds,
    sharedUserIds: sharedUserIds.length > 0 ? sharedUserIds : viewerUserIds,
    sharedTeamIds,
    sharedTeamNames,
  };
}

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
    const row = r.rows[0];
    if (!row) return null;
    return normalizeDoc(row);
  }

  async list(f: DocumentListFilter): Promise<{ items: DocumentRecord[]; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 50 : f.limit;
    let where: Predicate[] = [sql`1=1`];
    if (f.customerId !== "") where.push(sql`d.customer_id::text = ${f.customerId}`);
    if (f.dealId !== "") where.push(sql`d.deal_id::text = ${f.dealId}`);
    if (f.leadId !== "") where.push(sql`d.lead_id::text = ${f.leadId}`);
    if (f.status !== "") where.push(sql`d.status = ${f.status}`);
    if (f.type !== "") where.push(sql`d.doc_type = ${f.type}`);
    if (f.shareScope !== "") where.push(sql`d.share_scope = ${f.shareScope}`);
    if (f.excludeScreenshots) {
      where.push(sql`lower(d.doc_type) <> 'screenshot' AND lower(d.category) <> 'screenshot'`);
    }
    if (f.q !== "") {
      const like = `%${f.q.toLowerCase()}%`;
      where.push(sql`(
        lower(d.name) LIKE ${like}
        OR lower(d.doc_type) LIKE ${like}
        OR lower(d.original_filename) LIKE ${like}
      )`);
    }
    if (f.uploadedBy !== "") where.push(sql`d.uploaded_by::text = ${f.uploadedBy}`);
    if (f.uploadedByRole !== "") {
      where.push(sql`EXISTS (
        SELECT 1 FROM users ubf
        JOIN roles ubfr ON ubfr.id = ubf.role_id
        WHERE ubf.id = d.uploaded_by AND ubfr.code = ${f.uploadedByRole}
      )`);
    }
    if (f.teamId !== "") {
      where.push(sql`(
        EXISTS (
          SELECT 1 FROM document_shares ds
          WHERE ds.document_id = d.id AND ds.target_type = 'team' AND ds.team_id::text = ${f.teamId}
        )
        OR (
          d.share_scope = ${ShareScope.AllTeams}
          AND EXISTS (SELECT 1 FROM teams t WHERE t.id::text = ${f.teamId} AND t.is_active = TRUE)
        )
      )`);
    }
    if (f.createdFrom !== "") {
      try {
        const from = parseOptionalTime(f.createdFrom);
        if (from) where.push(sql`d.created_at >= ${from}`);
      } catch {
        throw AppError.validation("invalid createdFrom");
      }
    }
    if (f.createdTo !== "") {
      try {
        const to = parseOptionalTime(f.createdTo);
        if (to) where.push(sql`d.created_at <= ${to}`);
      } catch {
        throw AppError.validation("invalid createdTo");
      }
    }
    where = appendRecordScope(Records.Documents, where, f.scope, f.viewer);
    const count = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM documents d WHERE ${and(where)}`.execute(this.db);
    const rows = await sql<DocumentRecord>`
      ${docSelect}
      WHERE ${and(where)}
      ORDER BY COALESCE(d.uploaded_at, d.requested_at, d.created_at) DESC
      LIMIT ${limit} OFFSET ${f.offset}`.execute(this.db);
    return {
      items: rows.rows.map(normalizeDoc),
      total: count.rows[0]?.total ?? 0,
    };
  }

  async insertRequested(
    in_: RequestDocumentInput,
    expires: Date | null,
    status: string,
    share: DocumentSharePlan,
  ): Promise<DocumentRecord | null> {
    const id = randomUUID();
    let docType = in_.type.trim();
    if (docType === "") docType = in_.category.trim();
    let category = in_.category.trim();
    if (category === "") category = docType;
    await sql`
      INSERT INTO documents (
        id, name, category, doc_type, status, requested_at, expires_at, notes,
        lead_id, customer_id, deal_id, share_scope
      ) VALUES (
        ${id}, ${in_.name.trim()}, ${category}, ${docType}, ${status}, ${new Date()}, ${expires}, ${in_.notes},
        ${blankToNull(in_.leadId)}, ${blankToNull(in_.customerId)}, ${blankToNull(in_.dealId)}, ${share.shareScope}
      )`.execute(this.db);
    return this.get(id);
  }

  async createUploaded(
    in_: NewUpload,
    actorId: string,
    file: { key: string; provider: string; mime: string; size: number },
    expires: Date | null,
    share: DocumentSharePlan,
  ): Promise<DocumentRecord | null> {
    const id = randomUUID();
    const docType = in_.type === "" ? in_.category : in_.type;
    const category = in_.category === "" ? docType : in_.category;
    const originalFilename = (in_.originalFilename ?? "").trim();
    await sql`
      INSERT INTO documents (
        id, name, category, doc_type, status, file_key, storage_provider, mime_type, size_bytes,
        uploaded_by, uploaded_at, expires_at, notes, lead_id, customer_id, deal_id,
        share_scope, original_filename
      ) VALUES (
        ${id}, ${in_.name}, ${category}, ${docType}, 'uploaded', ${file.key}, ${file.provider}, ${file.mime}, ${file.size},
        ${blankToNull(actorId)}, ${new Date()}, ${expires}, ${in_.notes},
        ${blankToNull(in_.leadId)}, ${blankToNull(in_.customerId)}, ${blankToNull(in_.dealId)},
        ${share.shareScope}, ${originalFilename}
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

  async updateMeta(
    id: string,
    cur: DocumentRecord,
    in_: UpdateDocumentInput,
    expires: Date | null,
    setExpires: boolean,
    share: DocumentSharePlan | undefined,
  ) {
    await sql`
      UPDATE documents SET
        name = ${in_.name !== undefined ? in_.name.trim() : cur.name},
        doc_type = ${in_.type !== undefined ? in_.type.trim() : cur.type},
        category = ${in_.category !== undefined ? in_.category.trim() : cur.category},
        notes = ${in_.notes ?? cur.notes},
        status = ${in_.status !== undefined ? in_.status.trim() : cur.status},
        expires_at = ${setExpires ? expires : cur.expiryDate},
        share_scope = ${share ? share.shareScope : cur.shareScope}
      WHERE id = ${id}`.execute(this.db);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM documents WHERE id = ${id}`.execute(this.db);
  }

  async replaceShares(documentId: string, share: DocumentSharePlan): Promise<void> {
    await sql`DELETE FROM document_shares WHERE document_id = ${documentId}`.execute(this.db);
    await sql`DELETE FROM document_viewers WHERE document_id = ${documentId}`.execute(this.db);
    for (const teamId of share.teamIds) {
      await sql`
        INSERT INTO document_shares (document_id, target_type, team_id)
        VALUES (${documentId}, 'team', ${teamId})`.execute(this.db);
    }
    for (const userId of share.userIds) {
      await sql`
        INSERT INTO document_shares (document_id, target_type, user_id)
        VALUES (${documentId}, 'user', ${userId})`.execute(this.db);
    }
  }

  private uniqueIds(raw: string[] | undefined, field: string): string[] {
    if (raw === undefined) return [];
    const unique: string[] = [];
    for (const id of raw) {
      const trimmed = id.trim();
      if (trimmed === "") continue;
      if (!isUuid(trimmed)) throw AppError.validation(`invalid ${field}`);
      if (!unique.includes(trimmed)) unique.push(trimmed);
    }
    return unique;
  }

  async resolveTeamIds(raw: string[] | undefined): Promise<string[]> {
    const unique = this.uniqueIds(raw, "teamIds");
    if (unique.length === 0) return [];
    const r = await sql<{ id: string }>`
      SELECT t.id::text AS id
      FROM teams t
      WHERE t.id = ANY(${unique}::uuid[])
        AND t.is_active = TRUE`.execute(this.db);
    if (r.rows.length !== unique.length) throw AppError.validation("teamIds must be active teams");
    return unique;
  }

  async resolveSeViewerIds(claims: Claims, raw: string[] | undefined): Promise<string[]> {
    const unique = this.uniqueIds(raw, "viewerUserIds");
    if (unique.length === 0) return [];
    if (claims.teamIds.length === 0) {
      throw AppError.validation("viewerUserIds must be Sales Executives on your team");
    }
    const r = await sql<{ id: string }>`
      SELECT DISTINCT u.id::text AS id
      FROM users u
      JOIN roles r ON r.id = u.role_id
      JOIN team_members tm ON tm.user_id = u.id
      WHERE u.id = ANY(${unique}::uuid[])
        AND u.is_active = TRUE
        AND r.code = ${Role.SalesExecutive}
        AND tm.team_id = ANY(${claims.teamIds}::uuid[])`.execute(this.db);
    if (r.rows.length !== unique.length) {
      throw AppError.validation("viewerUserIds must be Sales Executives on your team");
    }
    return unique;
  }

  /**
   * Resolve role-based share plan. Lead-owner SE is appended as a user share so Files stay visible.
   */
  async resolveSharePlan(claims: Claims, in_: ShareInput, leadId: string | undefined): Promise<DocumentSharePlan> {
    const rawScope = (in_.shareScope ?? "").trim();
    let scope: ShareScopeCode;
    if (rawScope === "") {
      const hasTeams = (in_.teamIds?.length ?? 0) > 0;
      const hasUsers = (in_.viewerUserIds?.length ?? 0) > 0;
      if (claims.roleCode === Role.SuperAdmin) {
        if (hasTeams) scope = ShareScope.SelectedTeams;
        else if (hasUsers) throw AppError.validation("Admin must share with teams (use shareScope all_teams or selected_teams)");
        else scope = ShareScope.None;
      } else if (claims.roleCode === Role.SalesManager) {
        if (hasUsers) scope = ShareScope.SelectedSes;
        else if (hasTeams) scope = ShareScope.AllTeamSes;
        else scope = ShareScope.None;
      } else {
        if (hasTeams || hasUsers) throw AppError.forbidden("insufficient permissions to share documents");
        scope = ShareScope.None;
      }
    } else {
      if (!VALID_SHARE_SCOPES.has(rawScope)) throw AppError.validation("invalid shareScope");
      scope = rawScope as ShareScopeCode;
    }

    let teamIds: string[] = [];
    let userIds: string[] = [];

    if (claims.roleCode === Role.SuperAdmin) {
      if (scope === ShareScope.AllTeams) {
        teamIds = [];
        userIds = [];
      } else if (scope === ShareScope.SelectedTeams) {
        teamIds = await this.resolveTeamIds(in_.teamIds);
        if (teamIds.length === 0) throw AppError.validation("select at least one team");
      } else if (scope === ShareScope.None) {
        teamIds = [];
        userIds = [];
      } else {
        throw AppError.validation("Admin may only use all_teams or selected_teams");
      }
    } else if (claims.roleCode === Role.SalesManager) {
      const myTeam = claims.teamIds[0];
      if (!myTeam) throw AppError.validation("Team Lead must belong to a team to share documents");
      if (scope === ShareScope.AllTeamSes) {
        teamIds = [myTeam];
        userIds = [];
      } else if (scope === ShareScope.SelectedSes) {
        userIds = await this.resolveSeViewerIds(claims, in_.viewerUserIds);
        if (userIds.length === 0) throw AppError.validation("select at least one Sales Executive");
        teamIds = [];
      } else if (scope === ShareScope.None) {
        teamIds = [];
        userIds = [];
      } else {
        throw AppError.validation("Team Lead may only use all_team_ses or selected_ses");
      }
    } else if (scope !== ShareScope.None) {
      throw AppError.forbidden("insufficient permissions to share documents");
    }

    const leadOwner = await this.leadOwnerSeId(leadId);
    if (leadOwner && !userIds.includes(leadOwner)) userIds = [...userIds, leadOwner];

    return { shareScope: scope, teamIds, userIds };
  }

  async leadOwnerSeId(leadId: string | undefined): Promise<string | null> {
    const id = blankToNull(leadId);
    if (!id) return null;
    const r = await sql<{ ownerId: string }>`
      SELECT l.owner_user_id::text AS "ownerId"
      FROM leads l
      JOIN users u ON u.id = l.owner_user_id
      JOIN roles r ON r.id = u.role_id
      WHERE l.id = ${id}
        AND u.is_active = TRUE
        AND r.code = ${Role.SalesExecutive}`.execute(this.db);
    return r.rows[0]?.ownerId ?? null;
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

  async request(claims: Claims, in_: RequestDocumentInput, meta: RequestMeta): Promise<DocumentRecord> {
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    const share = await this.repo.resolveSharePlan(claims, in_, in_.leadId);
    const status = in_.status === DocumentStatus.Missing ? DocumentStatus.Missing : DocumentStatus.Requested;
    const expires = parseExpiry(in_.expiryDate);
    const d = await internal("failed to request document", async () => {
      const row = await this.repo.insertRequested(in_, expires, status, share);
      if (!row) throw new Error("inserted document not found");
      await this.repo.replaceShares(row.id, share);
      return (await this.repo.get(row.id)) ?? row;
    });
    await this.audit.record(
      claims.userId,
      "document.requested",
      "document",
      d.id,
      { name: d.name, type: d.type, status: d.status, shareScope: share.shareScope, teamIds: share.teamIds, viewerUserIds: share.userIds },
      meta,
    );
    await this.emit(claims.userId, TimelineEvent.DocumentRequested, "Document requested", `${d.name} (${d.type})`, d);
    return d;
  }

  async uploadNew(claims: Claims, in_: NewUpload, file: FileUpload, meta: RequestMeta): Promise<DocumentRecord> {
    const input = {
      ...in_,
      name: in_.name.trim() === "" ? file.filename : in_.name,
      originalFilename: in_.originalFilename?.trim() || file.filename,
    };
    if (input.name.trim() === "") throw AppError.validation("name is required");
    const share = await this.repo.resolveSharePlan(claims, input, input.leadId);
    const expires = parseExpiry(input.expiryDate);
    const dest = this.destination(input.type, input.category, input.customerId, input.dealId, input.leadId);
    const stored = await this.put(dest.store, dest.prefix, file);
    let d: DocumentRecord;
    try {
      const row = await this.repo.createUploaded(input, claims.userId, stored, expires, share);
      if (!row) throw new Error("inserted document not found");
      await this.repo.replaceShares(row.id, share);
      d = (await this.repo.get(row.id)) ?? row;
    } catch (err) {
      await dest.store.delete(stored.key).catch(() => undefined);
      throw AppError.internal("failed to save document", err);
    }
    await this.audit.record(
      claims.userId,
      "document.uploaded",
      "document",
      d.id,
      { name: d.name, type: d.type, size: d.sizeBytes, shareScope: share.shareScope, teamIds: share.teamIds, viewerUserIds: share.userIds },
      meta,
    );
    await this.afterUpload(claims.userId, d);
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

  async update(claims: Claims, id: string, in_: UpdateDocumentInput, meta: RequestMeta): Promise<DocumentRecord> {
    const current = await this.get(id);
    let expires: Date | null = null;
    const setExpires = in_.expiryDate !== undefined;
    if (setExpires) expires = parseExpiry(in_.expiryDate);
    if (in_.status !== undefined && !VALID_STATUSES.has(in_.status)) throw AppError.validation("invalid status");
    const shareChanged =
      in_.shareScope !== undefined || in_.teamIds !== undefined || in_.viewerUserIds !== undefined;
    const share = shareChanged
      ? await this.repo.resolveSharePlan(
          claims,
          {
            shareScope: in_.shareScope ?? current.shareScope,
            teamIds: in_.teamIds,
            viewerUserIds: in_.viewerUserIds,
          },
          current.leadId ?? undefined,
        )
      : undefined;
    const d = await this.mutate("failed to update document", async () => {
      const row = await this.repo.updateMeta(id, current, in_, expires, setExpires, share);
      if (!row) return null;
      if (share) await this.repo.replaceShares(id, share);
      return (await this.repo.get(id)) ?? row;
    });
    await this.audit.record(
      claims.userId,
      "document.updated",
      "document",
      id,
      {
        name: d.name,
        status: d.status,
        shareScope: share?.shareScope,
        teamIds: share?.teamIds,
        viewerUserIds: share?.userIds,
      },
      meta,
    );
    return d;
  }

  /**
   * Team Leads may only delete documents they uploaded.
   * Super Admin (and other holders of documents:delete) may delete in-scope docs.
   */
  assertCanDelete(claims: Claims, doc: DocumentRecord): void {
    if (claims.roleCode === Role.SalesManager && doc.uploadedBy !== claims.userId) {
      throw AppError.forbidden("Team Leads can only delete documents they uploaded");
    }
  }

  async delete(claims: Claims, id: string, meta: RequestMeta): Promise<void> {
    const d = await this.get(id);
    this.assertCanDelete(claims, d);
    await internal("failed to delete document", () => this.repo.delete(id));
    if (d.fileKey !== "") {
      try {
        await this.storeOf(d.storageProvider).delete(d.fileKey);
      } catch {
        // The document row is already gone; object cleanup is best-effort.
      }
    }
    await this.audit.record(claims.userId, "document.deleted", "document", id, { name: d.name }, meta);
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
