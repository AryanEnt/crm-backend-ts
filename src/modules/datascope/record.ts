import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { isUuid } from "../../lib/uuid.js";
import type { Claims } from "../auth/types.js";
import type { Scope } from "../permissions/permissions.js";
import {
  NO_MATCH_ID,
  and,
  appendScope,
  widestScope,
  type Columns,
  type Predicate,
  type Visibility,
} from "./datascope.js";

/** How rows of one CRM table are owned, for single-record and batch checks. */
export interface RecordSpec {
  /** Used in the not-found error, e.g. "lead". */
  noun: string;
  /** e.g. "leads l" */
  from: string;
  /** e.g. "l" */
  alias: string;
  columns?: Columns;
  /** Replaces the owner/team predicate for tables that inherit visibility from another record. */
  where?: (where: Predicate[], v: Visibility, claims: Claims) => Predicate[];
}

/** A document is visible through the lead, customer or deal it belongs to, or to its uploader. */
function documentWhere(where: Predicate[], v: Visibility, claims: Claims): Predicate[] {
  const parents = [
    { column: "d.lead_id", from: "leads pl", alias: "pl" },
    { column: "d.customer_id", from: "customers pc", alias: "pc" },
    { column: "d.deal_id", from: "deals pd", alias: "pd" },
  ];
  const via = parents.map((p) => {
    const sub = appendScope([sql`${sql.raw(`${p.alias}.id = ${p.column}`)}`], v, {
      owner: `${p.alias}.owner_user_id`,
      team: `${p.alias}.team_id`,
    });
    return sql`EXISTS (SELECT 1 FROM ${sql.raw(p.from)} WHERE ${and(sub)})`;
  });
  via.push(sql`d.uploaded_by = ${claims.userId}::uuid`);
  return [...where, sql`(${sql.join(via, sql` OR `)})`];
}

export const Records = {
  Leads: { noun: "lead", from: "leads l", alias: "l", columns: { owner: "l.owner_user_id", team: "l.team_id" } },
  Customers: {
    noun: "customer",
    from: "customers c",
    alias: "c",
    columns: { owner: "c.owner_user_id", team: "c.team_id" },
  },
  Deals: { noun: "deal", from: "deals d", alias: "d", columns: { owner: "d.owner_user_id", team: "d.team_id" } },
  Activities: { noun: "activity", from: "activities a", alias: "a", columns: { owner: "a.owner_user_id" } },
  Documents: { noun: "document", from: "documents d", alias: "d", where: documentWhere },
} satisfies Record<string, RecordSpec>;

const notFound = (rec: RecordSpec) => AppError.notFound(`${rec.noun} not found`);

/** Adds the record's visibility predicate to a query already selecting FROM rec.from. */
export function appendRecordScope(rec: RecordSpec, where: Predicate[], v: Visibility, claims: Claims): Predicate[] {
  if (v.unscoped) return where;
  if (rec.where) return rec.where(where, v, claims);
  return appendScope(where, v, rec.columns ?? { owner: "" });
}

/** The row filter for a scope, with no extra owner narrowing. */
export function visibilityFor(claims: Claims, scope: Scope): Visibility {
  switch (scope) {
    case "organization":
      return { unscoped: true, ownerIds: [], teamIds: [] };
    case "team":
      if (claims.teamIds.length === 0) return { unscoped: false, ownerIds: [NO_MATCH_ID], teamIds: [] };
      return { unscoped: false, ownerIds: [], teamIds: [...claims.teamIds] };
    default:
      return { unscoped: false, ownerIds: [claims.userId], teamIds: [] };
  }
}

function recordVisibility(claims: Claims, perms: string[]): Visibility {
  return visibilityFor(claims, widestScope(claims, ...perms));
}

/**
 * Fails with not-found unless id exists inside the caller's widest scope across perms.
 * Out-of-scope rows look exactly like missing ones.
 */
export async function requireRecord(
  db: Database,
  claims: Claims,
  rec: RecordSpec,
  id: string,
  ...perms: string[]
): Promise<void> {
  if (!isUuid(id)) throw notFound(rec);
  const v = recordVisibility(claims, perms);
  const where = appendRecordScope(rec, [sql`${sql.raw(rec.alias)}.id = ${id}`], v, claims);
  let ok: boolean;
  try {
    const result = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM ${sql.raw(rec.from)} WHERE ${and(where)}) AS ok`.execute(db);
    ok = result.rows[0]?.ok === true;
  } catch (err) {
    throw AppError.internal("failed to check record access", err);
  }
  if (!ok) throw notFound(rec);
}

/** requireRecord for a batch: every id must be visible, or nothing happens. */
export async function requireRecords(
  db: Database,
  claims: Claims,
  rec: RecordSpec,
  ids: string[],
  ...perms: string[]
): Promise<void> {
  const unique: string[] = [];
  for (const id of ids) {
    if (!isUuid(id)) throw notFound(rec);
    if (!unique.includes(id)) unique.push(id);
  }
  if (unique.length === 0) return;
  const v = recordVisibility(claims, perms);
  const where = appendRecordScope(rec, [sql`${sql.raw(rec.alias)}.id = ANY(${unique}::uuid[])`], v, claims);
  let visible: number;
  try {
    const result = await sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql.raw(rec.from)} WHERE ${and(where)}`.execute(db);
    visible = Number(result.rows[0]?.count ?? 0);
  } catch (err) {
    throw AppError.internal("failed to check record access", err);
  }
  if (visible !== unique.length) throw notFound(rec);
}
