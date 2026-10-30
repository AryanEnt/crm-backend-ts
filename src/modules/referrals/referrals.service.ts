import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { parseDateOnly } from "../../lib/go-time.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { optionalString, str } from "../../lib/validate.js";
import type { AuditService } from "../audit/audit.service.js";

export interface Referral {
  id: string;
  leadId: string | null;
  customerId: string | null;
  referrerTypeId: string;
  referrerTypeCode: string;
  referrerTypeName: string;
  referrerUserId: string | null;
  referrerUserName: string | null;
  referrerCustomerId: string | null;
  referrerCustomerName: string | null;
  referrerPartnerId: string | null;
  referrerPartnerName: string | null;
  referrerName: string;
  referrerDisplayName: string;
  relationshipId: string | null;
  relationshipCode: string | null;
  relationshipName: string | null;
  referralDate: string;
  referralSource: string;
  notes: string;
  statusId: string;
  statusCode: string;
  statusName: string;
  isConverted: boolean;
  referralCode: string | null;
  createdByUserId: string | null;
  referredName?: string;
  ownerUserId?: string;
  ownerName?: string;
  teamId?: string;
  pipelineId?: string;
  pipelineName?: string;
  stageId?: string;
  stageName?: string;
  potentialValue?: number;
  subjectKind?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Nested `referral` payload on lead/customer create (Go referrals.Input). */
export const referralInputSchema = z.strictObject({
  referrerTypeCode: str(),
  referrerUserId: optionalString(),
  referrerCustomerId: optionalString(),
  referrerPartnerId: optionalString(),
  referrerName: str(),
  relationshipCode: optionalString(),
  referralDate: optionalString(),
  referralSource: str(),
  notes: str(),
  referralCode: optionalString(),
  statusCode: str(),
});

export type ReferralInput = z.output<typeof referralInputSchema>;

/** PATCH /referrals/:id (Go referrals.UpdateInput): every field optional. */
export const referralUpdateSchema = z.strictObject({
  referrerTypeCode: optionalString(),
  referrerUserId: optionalString(),
  referrerCustomerId: optionalString(),
  referrerPartnerId: optionalString(),
  referrerName: optionalString(),
  relationshipCode: optionalString(),
  referralDate: optionalString(),
  referralSource: optionalString(),
  notes: optionalString(),
  referralCode: optionalString(),
  statusCode: optionalString(),
  leadId: optionalString(),
  customerId: optionalString(),
});

export type ReferralUpdate = z.output<typeof referralUpdateSchema>;

export const partnerInputSchema = z.strictObject({
  name: str(),
  email: optionalString(),
  phone: optionalString(),
  company: str(),
  notes: str(),
});

export type PartnerInput = z.output<typeof partnerInputSchema>;

export interface CatalogItem {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  isConverted?: boolean;
}

export interface Partner {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string;
  notes: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferrerUser {
  id: string;
  fullName: string;
  email: string;
  roleName: string;
}

export interface ReferralListFilter {
  search: string;
  ownerUserId: string;
  teamId: string;
  pipelineId: string;
  referrerTypeCode: string;
  referrerUserId: string;
  referrerCustomerId: string;
  referrerPartnerId: string;
  referrerName: string;
  statusCode: string;
  dateFrom: string;
  dateTo: string;
  /**
   * Visibility without referrals:manage:
   * - Sales Executive: referrals they added (`created_by` in scopeCreatedByIds)
   * - Team Lead: created by a team member, or linked lead/customer on their team
   */
  scopeCreatedByIds: string[];
  scopeTeamIds: string[];
  unscoped: boolean;
  sort: string;
  order: string;
  limit: number;
  offset: number;
}

export interface ReferralSummary {
  totalReferrals: number;
  activeReferrals: number;
  convertedReferrals: number;
  unconvertedReferrals: number;
  referralPipelineValue: number;
}

export interface ReferrerProfile {
  referrerKey: string;
  referrerTypeCode: string;
  referrerTypeName: string;
  referrerUserId: string | null;
  referrerCustomerId: string | null;
  referrerPartnerId: string | null;
  referrerDisplayName: string;
  totalReferrals: number;
  activeReferrals: number;
  convertedReferrals: number;
  history: Referral[] | null;
}

interface CatalogRow {
  id: string;
  code: string;
}

const partnerSelect = sql`
  SELECT id::text AS "id", name, email, phone, company, notes, is_active AS "isActive",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM referral_partners`;

/** Joins shared by the list count and summary (no display-only joins). */
const listFrom = sql`
  FROM referrals r
  JOIN referral_referrer_types rt ON rt.id = r.referrer_type_id
  JOIN referral_statuses rs ON rs.id = r.status_id
  LEFT JOIN leads l ON l.id = r.lead_id
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN users ru ON ru.id = r.referrer_user_id
  LEFT JOIN customers rc ON rc.id = r.referrer_customer_id
  LEFT JOIN referral_partners rp ON rp.id = r.referrer_partner_id`;

/** Go sorts by an unaliased potential_value and fails as ambiguous; TS sorts by the value it selects. */
const SORT_COLUMNS: Record<string, string> = {
  referrer: `"referrerDisplayName"`,
  referred: `"referredName"`,
  status: "rs.name",
  value: `"potentialValue"`,
  createdAt: "r.created_at",
};

function listWhere(f: ReferralListFilter) {
  const parts = [sql`TRUE`];
  const referrerName = sql`COALESCE(ru.full_name, rc.full_name, rp.name, r.referrer_name, '')`;
  if (f.search !== "") {
    parts.push(sql`(
      COALESCE(c.full_name, l.full_name, '') ILIKE '%' || ${f.search} || '%'
      OR ${referrerName} ILIKE '%' || ${f.search} || '%'
      OR COALESCE(r.referral_code, '') ILIKE '%' || ${f.search} || '%'
    )`);
  }
  if (f.ownerUserId !== "") parts.push(sql`COALESCE(c.owner_user_id, l.owner_user_id)::text = ${f.ownerUserId}`);
  if (f.teamId !== "") parts.push(sql`COALESCE(c.team_id, l.team_id)::text = ${f.teamId}`);
  if (f.pipelineId !== "") parts.push(sql`COALESCE(c.pipeline_id, l.pipeline_id)::text = ${f.pipelineId}`);
  if (f.referrerTypeCode !== "") parts.push(sql`rt.code = ${f.referrerTypeCode}`);
  if (f.referrerUserId !== "") parts.push(sql`r.referrer_user_id::text = ${f.referrerUserId}`);
  if (f.referrerCustomerId !== "") parts.push(sql`r.referrer_customer_id::text = ${f.referrerCustomerId}`);
  if (f.referrerPartnerId !== "") parts.push(sql`r.referrer_partner_id::text = ${f.referrerPartnerId}`);
  if (f.referrerName !== "") parts.push(sql`${referrerName} ILIKE '%' || ${f.referrerName} || '%'`);
  if (f.statusCode !== "") parts.push(sql`rs.code = ${f.statusCode}`);
  if (f.dateFrom !== "") parts.push(sql`r.referral_date >= ${f.dateFrom}::date`);
  if (f.dateTo !== "") parts.push(sql`r.referral_date <= ${f.dateTo}::date`);
  if (!f.unscoped) {
    const scope = [];
    if (f.scopeCreatedByIds.length > 0) {
      scope.push(sql`r.created_by_user_id = ANY(${f.scopeCreatedByIds}::uuid[])`);
    }
    if (f.scopeTeamIds.length > 0) {
      scope.push(sql`COALESCE(c.team_id, l.team_id) = ANY(${f.scopeTeamIds}::uuid[])`);
    }
    parts.push(scope.length > 0 ? sql`(${sql.join(scope, sql` OR `)})` : sql`FALSE`);
  }
  return sql.join(parts, sql` AND `);
}

/** Whether a loaded referral is visible under the same rules as the list filter. */
export function referralVisible(ref: Referral, f: Pick<ReferralListFilter, "unscoped" | "scopeCreatedByIds" | "scopeTeamIds">): boolean {
  if (f.unscoped) return true;
  if (f.scopeCreatedByIds.length > 0 && ref.createdByUserId && f.scopeCreatedByIds.includes(ref.createdByUserId)) {
    return true;
  }
  if (f.scopeTeamIds.length > 0 && ref.teamId && f.scopeTeamIds.includes(ref.teamId)) {
    return true;
  }
  return false;
}

/** Go omitempty on CatalogItem.isConverted: only present when true. */
function toCatalogItem(r: CatalogItem & { isConverted: boolean }): CatalogItem {
  const { isConverted, ...rest } = r;
  return isConverted ? { ...rest, isConverted } : rest;
}

interface CreateRow {
  leadId: string | null;
  customerId: string | null;
  referrerTypeId: string;
  referrerUserId: string | undefined;
  referrerCustomerId: string | undefined;
  referrerPartnerId: string | undefined;
  referrerName: string;
  relationshipId: string | null;
  referralDate: string;
  referralSource: string;
  notes: string;
  statusId: string;
  referralCode: string | undefined;
  createdByUserId: string;
}

type ReferralRow = Omit<
  Referral,
  | "referredName"
  | "ownerUserId"
  | "ownerName"
  | "teamId"
  | "pipelineId"
  | "pipelineName"
  | "stageId"
  | "stageName"
  | "potentialValue"
  | "subjectKind"
> & {
  referredName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  potentialValue: number | null;
  subjectKind: string;
};

const referralSelect = sql`
  SELECT
    r.id::text AS "id", r.lead_id::text AS "leadId", r.customer_id::text AS "customerId",
    r.referrer_type_id::text AS "referrerTypeId", rt.code AS "referrerTypeCode", rt.name AS "referrerTypeName",
    r.referrer_user_id::text AS "referrerUserId", ru.full_name AS "referrerUserName",
    r.referrer_customer_id::text AS "referrerCustomerId", rc.full_name AS "referrerCustomerName",
    r.referrer_partner_id::text AS "referrerPartnerId", rp.name AS "referrerPartnerName",
    r.referrer_name AS "referrerName",
    COALESCE(NULLIF(trim(r.referrer_name), ''), ru.full_name, rc.full_name, rp.name, 'Unknown') AS "referrerDisplayName",
    r.relationship_id::text AS "relationshipId", rr.code AS "relationshipCode", rr.name AS "relationshipName",
    to_char(r.referral_date, 'YYYY-MM-DD') AS "referralDate",
    r.referral_source AS "referralSource", r.notes,
    r.status_id::text AS "statusId", rs.code AS "statusCode", rs.name AS "statusName", rs.is_converted AS "isConverted",
    r.referral_code AS "referralCode", r.created_by_user_id::text AS "createdByUserId",
    COALESCE(c.full_name, l.full_name) AS "referredName",
    COALESCE(c.owner_user_id, l.owner_user_id)::text AS "ownerUserId",
    COALESCE(ou.full_name, ol.full_name) AS "ownerName",
    COALESCE(c.team_id, l.team_id)::text AS "teamId",
    COALESCE(c.pipeline_id, l.pipeline_id)::text AS "pipelineId",
    COALESCE(cp.name, lp.name) AS "pipelineName",
    COALESCE(c.stage_id, l.stage_id)::text AS "stageId",
    COALESCE(cs.name, ls.name) AS "stageName",
    COALESCE(c.potential_value, l.potential_value) AS "potentialValue",
    CASE WHEN r.customer_id IS NOT NULL THEN 'customer' WHEN r.lead_id IS NOT NULL THEN 'lead' ELSE '' END AS "subjectKind",
    r.created_at AS "createdAt", r.updated_at AS "updatedAt"
  FROM referrals r
  JOIN referral_referrer_types rt ON rt.id = r.referrer_type_id
  JOIN referral_statuses rs ON rs.id = r.status_id
  LEFT JOIN referral_relationships rr ON rr.id = r.relationship_id
  LEFT JOIN users ru ON ru.id = r.referrer_user_id
  LEFT JOIN customers rc ON rc.id = r.referrer_customer_id
  LEFT JOIN referral_partners rp ON rp.id = r.referrer_partner_id
  LEFT JOIN leads l ON l.id = r.lead_id
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN users ol ON ol.id = l.owner_user_id
  LEFT JOIN users ou ON ou.id = c.owner_user_id
  LEFT JOIN pipelines lp ON lp.id = l.pipeline_id
  LEFT JOIN pipelines cp ON cp.id = c.pipeline_id
  LEFT JOIN pipeline_stages ls ON ls.id = l.stage_id
  LEFT JOIN pipeline_stages cs ON cs.id = c.stage_id`;

/** Go omitempty: the denormalized subject fields are dropped when NULL/empty. */
function toReferral(r: ReferralRow): Referral {
  const out: Referral = {
    id: r.id,
    leadId: r.leadId,
    customerId: r.customerId,
    referrerTypeId: r.referrerTypeId,
    referrerTypeCode: r.referrerTypeCode,
    referrerTypeName: r.referrerTypeName,
    referrerUserId: r.referrerUserId,
    referrerUserName: r.referrerUserName,
    referrerCustomerId: r.referrerCustomerId,
    referrerCustomerName: r.referrerCustomerName,
    referrerPartnerId: r.referrerPartnerId,
    referrerPartnerName: r.referrerPartnerName,
    referrerName: r.referrerName,
    referrerDisplayName: r.referrerDisplayName,
    relationshipId: r.relationshipId,
    relationshipCode: r.relationshipCode,
    relationshipName: r.relationshipName,
    referralDate: r.referralDate,
    referralSource: r.referralSource,
    notes: r.notes,
    statusId: r.statusId,
    statusCode: r.statusCode,
    statusName: r.statusName,
    isConverted: r.isConverted,
    referralCode: r.referralCode,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  const optional = {
    referredName: r.referredName,
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerName,
    teamId: r.teamId,
    pipelineId: r.pipelineId,
    pipelineName: r.pipelineName,
    stageId: r.stageId,
    stageName: r.stageName,
    potentialValue: r.potentialValue,
    subjectKind: r.subjectKind === "" ? null : r.subjectKind,
  };
  const { createdAt, updatedAt, ...head } = out;
  const tail = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== null));
  return { ...head, ...tail, createdAt, updatedAt } as Referral;
}

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";
const blankStrict = (v: string | undefined): boolean => v === undefined || v === "";
const nilUuid = (v: string | undefined | null): string | null => (v === null || blank(v) ? null : v!);

export function isReferralSource(source: string): boolean {
  return source.trim().toLowerCase() === "referral";
}

export function validateReferral(in_: ReferralInput): void {
  if (in_.referrerTypeCode.trim() === "") throw AppError.validation("referrer type is required");
  const hasLink =
    !blank(in_.referrerUserId) || !blank(in_.referrerCustomerId) || !blank(in_.referrerPartnerId) || in_.referrerName.trim() !== "";
  if (!hasLink) throw AppError.validation("referred by is required");
}

export class ReferralsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async one(where: ReturnType<typeof sql>): Promise<Referral | null> {
    const r = await sql<ReferralRow>`${referralSelect} WHERE ${where}`.execute(this.db);
    return r.rows[0] ? toReferral(r.rows[0]) : null;
  }

  async meta(): Promise<{ referrerTypes: CatalogItem[] | null; relationships: CatalogItem[] | null; statuses: CatalogItem[] | null }> {
    return internal("failed to load referral catalogs", async () => {
      const load = async (table: string, converted: boolean) => {
        const r = await sql<CatalogItem & { isConverted: boolean }>`
          SELECT id::text AS "id", code, name, description, is_active AS "isActive", sort_order AS "sortOrder",
            ${converted ? sql`is_converted` : sql`FALSE`} AS "isConverted"
          FROM ${sql.table(table)}
          WHERE is_active = TRUE
          ORDER BY sort_order, name`.execute(this.db);
        return r.rows.length > 0 ? r.rows.map(toCatalogItem) : null;
      };
      const referrerTypes = await load("referral_referrer_types", false);
      const relationships = await load("referral_relationships", false);
      const statuses = await load("referral_statuses", true);
      return { referrerTypes, relationships, statuses };
    });
  }

  async get(
    id: string,
    access?: Pick<ReferralListFilter, "unscoped" | "scopeCreatedByIds" | "scopeTeamIds">,
  ): Promise<Referral> {
    const ref = await internal("failed to load referral", () => this.one(sql`r.id = ${id}`));
    if (!ref) throw AppError.notFound("referral not found");
    if (access && !referralVisible(ref, access)) throw AppError.notFound("referral not found");
    return ref;
  }

  private async listRaw(f: ReferralListFilter): Promise<{ items: Referral[] | null; total: number }> {
    const limit = f.limit <= 0 || f.limit > 100 ? 50 : f.limit;
    const offset = Math.max(f.offset, 0);
    const where = listWhere(f);
    const count = await sql<{ total: number }>`SELECT COUNT(*) AS total ${listFrom} WHERE ${where}`.execute(this.db);
    const sortCol = Object.hasOwn(SORT_COLUMNS, f.sort) ? SORT_COLUMNS[f.sort]! : "r.referral_date";
    const order = f.order.toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = await sql<ReferralRow>`
      ${referralSelect}
      WHERE ${where}
      ORDER BY ${sql.raw(`${sortCol} ${order}`)} NULLS LAST
      LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: rows.rows.length > 0 ? rows.rows.map(toReferral) : null, total: count.rows[0]?.total ?? 0 };
  }

  async list(f: ReferralListFilter): Promise<{ items: Referral[] | null; total: number }> {
    return internal("failed to list referrals", () => this.listRaw(f));
  }

  async summary(f: ReferralListFilter): Promise<ReferralSummary> {
    return internal("failed to load referral summary", async () => {
      const r = await sql<ReferralSummary>`
        SELECT
          COUNT(*)::int AS "totalReferrals",
          COUNT(*) FILTER (WHERE rs.code = 'active')::int AS "activeReferrals",
          COUNT(*) FILTER (WHERE rs.is_converted = TRUE)::int AS "convertedReferrals",
          COUNT(*) FILTER (WHERE rs.code = 'unconverted' OR (rs.is_converted = FALSE AND rs.code <> 'cancelled' AND rs.code <> 'active'))::int AS "unconvertedReferrals",
          COALESCE(SUM(COALESCE(c.potential_value, l.potential_value)) FILTER (
            WHERE rs.is_converted = FALSE AND rs.code <> 'cancelled'
          ), 0)::float8 AS "referralPipelineValue"
        ${listFrom}
        WHERE ${listWhere(f)}`.execute(this.db);
      return r.rows[0]!;
    });
  }

  async referrerProfile(typ: string, id: string): Promise<ReferrerProfile> {
    const f: ReferralListFilter = {
      search: "",
      ownerUserId: "",
      teamId: "",
      pipelineId: "",
      referrerTypeCode: "",
      referrerUserId: typ === "user" ? id : "",
      referrerCustomerId: typ === "customer" ? id : "",
      referrerPartnerId: typ === "partner" ? id : "",
      referrerName: "",
      statusCode: "",
      dateFrom: "",
      dateTo: "",
      scopeCreatedByIds: [],
      scopeTeamIds: [],
      unscoped: true,
      sort: "",
      order: "",
      limit: 100,
      offset: 0,
    };
    if (typ !== "user" && typ !== "customer" && typ !== "partner") throw AppError.validation("invalid referrer type");
    let items: Referral[] | null;
    try {
      items = (await this.listRaw(f)).items;
    } catch (err) {
      throw AppError.validation(err instanceof Error ? err.message : String(err));
    }
    // Go fills these from the first row with a non-empty display name, else the last row.
    const first = items?.find((i) => i.referrerDisplayName !== "") ?? items?.at(-1);
    return {
      referrerKey: `${typ}:${id}`,
      referrerTypeCode: first?.referrerTypeCode ?? "",
      referrerTypeName: first?.referrerTypeName ?? "",
      referrerUserId: first?.referrerUserId ?? null,
      referrerCustomerId: first?.referrerCustomerId ?? null,
      referrerPartnerId: first?.referrerPartnerId ?? null,
      referrerDisplayName: first?.referrerDisplayName ?? "",
      totalReferrals: items?.length ?? 0,
      activeReferrals: items?.filter((i) => i.statusCode === "active").length ?? 0,
      convertedReferrals: items?.filter((i) => i.isConverted).length ?? 0,
      history: items,
    };
  }

  async listPartners(q: string): Promise<Partner[] | null> {
    return internal("failed to list partners", async () => {
      const r = await sql<Partner>`
        ${partnerSelect}
        WHERE is_active = TRUE
          AND (${q} = '' OR name ILIKE '%' || ${q} || '%' OR COALESCE(company,'') ILIKE '%' || ${q} || '%')
        ORDER BY name
        LIMIT 50`.execute(this.db);
      return r.rows.length > 0 ? r.rows : null;
    });
  }

  async listReferrerUsers(qRaw: string): Promise<ReferrerUser[]> {
    const q = qRaw.trim();
    return internal("failed to list referrer users", async () => {
      const r = await sql<ReferrerUser>`
        SELECT u.id::text AS "id", u.full_name AS "fullName", u.email, r.name AS "roleName"
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = TRUE
          AND (${q} = '' OR u.full_name ILIKE '%' || ${q} || '%' OR u.email ILIKE '%' || ${q} || '%')
        ORDER BY u.full_name
        LIMIT 20`.execute(this.db);
      return r.rows;
    });
  }

  async createPartner(actorId: string, in_: PartnerInput, meta: RequestMeta): Promise<Partner> {
    if (in_.name.trim() === "") throw AppError.validation("partner name is required");
    const p = await internal("failed to create partner", async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO referral_partners (id, name, email, phone, company, notes)
        VALUES (${id}, ${in_.name.trim()}, ${blank(in_.email) ? null : in_.email!.trim().toLowerCase()},
          ${blank(in_.phone) ? null : in_.phone!.trim()}, ${in_.company}, ${in_.notes})`.execute(this.db);
      const r = await sql<Partner>`${partnerSelect} WHERE id = ${id}`.execute(this.db);
      if (!r.rows[0]) throw new Error("created partner not found");
      return r.rows[0];
    });
    await this.audit.record(actorId, "referral_partner.created", "referral_partner", p.id, { name: p.name }, meta);
    return p;
  }

  /** POST /referrals. Go does not check that the caller can see the lead or customer. */
  async createFor(
    actorId: string,
    leadId: string | undefined,
    customerId: string | undefined,
    in_: ReferralInput,
    meta: RequestMeta,
  ): Promise<Referral> {
    if (blankStrict(leadId) && blankStrict(customerId)) throw AppError.validation("leadId or customerId is required");
    validateReferral(in_);
    const ref = await this.create(await this.resolveInput(in_, nilUuid(leadId), nilUuid(customerId), actorId));
    await this.audit.record(
      actorId,
      "referral.created",
      "referral",
      ref.id,
      { leadId: leadId ?? null, customerId: customerId ?? null, referrerType: ref.referrerTypeCode },
      meta,
    );
    return ref;
  }

  async update(actorId: string, id: string, in_: ReferralUpdate, meta: RequestMeta): Promise<Referral> {
    const current = await this.get(id);
    const merged: ReferralInput = {
      referrerTypeCode: in_.referrerTypeCode ?? current.referrerTypeCode,
      referrerUserId: in_.referrerUserId ?? current.referrerUserId ?? undefined,
      referrerCustomerId: in_.referrerCustomerId ?? current.referrerCustomerId ?? undefined,
      referrerPartnerId: in_.referrerPartnerId ?? current.referrerPartnerId ?? undefined,
      referrerName: in_.referrerName ?? current.referrerName,
      relationshipCode: in_.relationshipCode ?? current.relationshipCode ?? undefined,
      referralDate: in_.referralDate ?? current.referralDate,
      referralSource: in_.referralSource ?? current.referralSource,
      notes: in_.notes ?? current.notes,
      referralCode: in_.referralCode ?? current.referralCode ?? undefined,
      statusCode: in_.statusCode ?? current.statusCode,
    };
    validateReferral(merged);
    const leadId = in_.leadId !== undefined ? nilUuid(in_.leadId) : current.leadId;
    const customerId = in_.customerId !== undefined ? nilUuid(in_.customerId) : current.customerId;
    const row = await this.resolveInput(merged, leadId, customerId, actorId);
    const ref = await internal("failed to update referral", async () => {
      await sql`
        UPDATE referrals SET
          lead_id = ${row.leadId}, customer_id = ${row.customerId}, referrer_type_id = ${row.referrerTypeId},
          referrer_user_id = ${nilUuid(row.referrerUserId)}, referrer_customer_id = ${nilUuid(row.referrerCustomerId)},
          referrer_partner_id = ${nilUuid(row.referrerPartnerId)}, referrer_name = ${row.referrerName},
          relationship_id = ${row.relationshipId}, referral_date = ${row.referralDate}, referral_source = ${row.referralSource},
          notes = ${row.notes}, status_id = ${row.statusId},
          referral_code = ${blank(row.referralCode) ? null : row.referralCode!.trim()}
        WHERE id = ${id}`.execute(this.db);
      const updated = await this.one(sql`r.id = ${id}`);
      if (!updated) throw new Error("updated referral not found");
      return updated;
    });

    if (current.statusCode !== ref.statusCode) {
      await this.audit.record(
        actorId,
        "referral.status_changed",
        "referral",
        id,
        { fromStatus: current.statusCode, toStatus: ref.statusCode },
        meta,
      );
    }
    if (current.referrerDisplayName !== ref.referrerDisplayName) {
      await this.audit.record(
        actorId,
        "referral.referrer_changed",
        "referral",
        id,
        { from: current.referrerDisplayName, to: ref.referrerDisplayName },
        meta,
      );
    }
    await this.audit.record(actorId, "referral.updated", "referral", id, { referrerType: ref.referrerTypeCode }, meta);
    return ref;
  }

  async getForLead(leadId: string): Promise<Referral | null> {
    return internal("failed to load referral", () => this.one(sql`r.lead_id = ${leadId}`));
  }

  async getForCustomer(customerId: string): Promise<Referral | null> {
    return internal("failed to load referral", () => this.one(sql`r.customer_id = ${customerId}`));
  }

  async upsertForLead(actorId: string, leadId: string, in_: ReferralInput, meta: RequestMeta): Promise<Referral> {
    const existing = await this.getForLead(leadId);
    if (existing) {
      const { statusCode: _status, ...rest } = in_;
      return this.update(actorId, existing.id, rest, meta);
    }
    return this.attachToLead(actorId, leadId, in_, meta);
  }

  async attachToLead(actorId: string, leadId: string, in_: ReferralInput, meta: RequestMeta): Promise<Referral> {
    validateReferral(in_);
    const ref = await this.create(await this.resolveInput(in_, leadId, null, actorId));
    await this.audit.record(
      actorId,
      "referral.created",
      "referral",
      ref.id,
      { leadId, referrerType: ref.referrerTypeCode, referrer: ref.referrerDisplayName },
      meta,
    );
    return ref;
  }

  async attachToCustomer(actorId: string, customerId: string, in_: ReferralInput, meta: RequestMeta): Promise<Referral> {
    validateReferral(in_);
    const ref = await this.create(await this.resolveInput(in_, null, customerId, actorId));
    await this.audit.record(
      actorId,
      "referral.created",
      "referral",
      ref.id,
      { customerId, referrerType: ref.referrerTypeCode, referrer: ref.referrerDisplayName },
      meta,
    );
    return ref;
  }

  /** Links the customer to the lead's referral (if any) and marks it converted. */
  async markLeadConverted(actorId: string, leadId: string, customerId: string, meta: RequestMeta): Promise<void> {
    let status: CatalogRow | null;
    try {
      status = await this.catalog("referral_statuses", "converted");
    } catch (err) {
      throw AppError.internal("converted status missing", err);
    }
    if (!status) throw AppError.internal("converted status missing");
    const existing = await this.getForLead(leadId);
    if (!existing) return;
    await internal("failed to update referral on convert", () =>
      sql`UPDATE referrals SET customer_id = ${customerId}, status_id = ${status.id} WHERE lead_id = ${leadId}`.execute(this.db),
    );
    await this.audit.record(
      actorId,
      "referral.status_changed",
      "referral",
      existing.id,
      { fromStatus: existing.statusCode, toStatus: "converted", customerId },
      meta,
    );
  }

  private async catalog(table: "referral_referrer_types" | "referral_relationships" | "referral_statuses", code: string) {
    const r = await sql<CatalogRow>`
      SELECT id::text AS "id", code FROM ${sql.table(table)} WHERE lower(code) = lower(${code})`.execute(this.db);
    return r.rows[0] ?? null;
  }

  /** A lookup failure reads the same as a missing row (Go: `err != nil || typ == nil`). */
  private async lookup(table: Parameters<ReferralsService["catalog"]>[0], code: string): Promise<CatalogRow | null> {
    return this.catalog(table, code).catch(() => null);
  }

  private async resolveInput(
    in_: ReferralInput,
    leadId: string | null,
    customerId: string | null,
    actorId: string,
  ): Promise<CreateRow> {
    const typ = await this.lookup("referral_referrer_types", in_.referrerTypeCode);
    if (!typ) throw AppError.validation("invalid referrer type");

    const status = await this.lookup("referral_statuses", in_.statusCode || "active");
    if (!status) throw AppError.validation("invalid referral status");

    let relationshipId: string | null = null;
    if (!blank(in_.relationshipCode)) {
      const rel = await this.lookup("referral_relationships", in_.relationshipCode!);
      if (!rel) throw AppError.validation("invalid referral relationship");
      relationshipId = rel.id;
    }

    let referralDate = new Date().toISOString().slice(0, 10);
    if (!blank(in_.referralDate)) {
      const parsed = parseDateOnly(in_.referralDate!.trim());
      if (!parsed) throw AppError.validation("invalid referral date (use YYYY-MM-DD)");
      referralDate = parsed.toISOString().slice(0, 10);
    }

    // Clear links that conflict with the referrer type.
    let { referrerUserId, referrerCustomerId, referrerPartnerId } = in_;
    const nameGiven = in_.referrerName.trim() !== "";
    switch (typ.code) {
      case "existing_customer":
        referrerUserId = undefined;
        referrerPartnerId = undefined;
        if (blank(referrerCustomerId) && !nameGiven) {
          throw AppError.validation("referrer customer is required for Existing Customer type");
        }
        break;
      case "sales_executive":
      case "employee":
        referrerCustomerId = undefined;
        referrerPartnerId = undefined;
        if (blank(referrerUserId) && !nameGiven) {
          throw AppError.validation("referrer user is required for this referrer type");
        }
        break;
      case "partner":
      case "agent":
        referrerUserId = undefined;
        referrerCustomerId = undefined;
        break;
    }

    return {
      leadId,
      customerId,
      referrerTypeId: typ.id,
      referrerUserId,
      referrerCustomerId,
      referrerPartnerId,
      referrerName: in_.referrerName.trim(),
      relationshipId,
      referralDate,
      referralSource: in_.referralSource.trim(),
      notes: in_.notes,
      statusId: status.id,
      referralCode: in_.referralCode,
      createdByUserId: actorId,
    };
  }

  private async create(row: CreateRow): Promise<Referral> {
    return internal("failed to create referral", async () => {
      const id = randomUUID();
      await sql`
        INSERT INTO referrals (
          id, lead_id, customer_id, referrer_type_id,
          referrer_user_id, referrer_customer_id, referrer_partner_id, referrer_name,
          relationship_id, referral_date, referral_source, notes, status_id, referral_code, created_by_user_id
        ) VALUES (
          ${id}, ${row.leadId}, ${row.customerId}, ${row.referrerTypeId},
          ${nilUuid(row.referrerUserId)}, ${nilUuid(row.referrerCustomerId)}, ${nilUuid(row.referrerPartnerId)}, ${row.referrerName},
          ${row.relationshipId}, ${row.referralDate}, ${row.referralSource}, ${row.notes}, ${row.statusId},
          ${blank(row.referralCode) ? null : row.referralCode!.trim()}, ${nilUuid(row.createdByUserId)}
        )`.execute(this.db);
      const ref = await this.one(sql`r.id = ${id}`);
      if (!ref) throw new Error("created referral not found");
      return ref;
    });
  }
}
