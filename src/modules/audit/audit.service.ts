import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { goSortKeys } from "../../lib/go-json.js";
import type { RequestMeta } from "../../lib/request-meta.js";
import { logger } from "../../logger.js";

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorName?: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
}

export interface AuditListFilter {
  search: string;
  limit: number;
  offset: number;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  /**
   * Writes an audit log row. Never throws: every Go caller discards the error
   * (`_ = s.audit.Record(...)`), so a failed audit write must not fail the request.
   */
  async record(
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> | null,
    meta: RequestMeta,
  ): Promise<void> {
    try {
      await this.db
        .insertInto("audit_logs")
        .values({
          id: randomUUID(),
          actor_user_id: actorUserId,
          action,
          resource_type: resourceType,
          resource_id: resourceId,
          metadata: JSON.stringify(metadata ?? {}),
          ip_address: meta.ip,
          user_agent: meta.userAgent,
        })
        .execute();
    } catch (err) {
      logger.warn({ err, action }, "audit record failed");
    }
  }

  /** Returns null items when there are none: the Go handler encodes a nil slice as null. */
  async list(f: AuditListFilter): Promise<{ items: AuditEntry[] | null; total: number }> {
    let { limit, offset } = f;
    if (limit <= 0 || limit > 100) limit = 25;
    if (offset < 0) offset = 0;

    const search = sql`(${f.search} = '' OR a.action ILIKE '%' || ${f.search} || '%' OR a.resource_type ILIKE '%' || ${f.search} || '%'
      OR COALESCE(u.email, '') ILIKE '%' || ${f.search} || '%' OR COALESCE(u.full_name, '') ILIKE '%' || ${f.search} || '%')`;

    const count = await sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${search}`.execute(this.db);

    const rows = await sql<{
      id: string;
      actorUserId: string | null;
      actorName: string | null;
      actorEmail: string | null;
      action: string;
      resourceType: string;
      resourceId: string | null;
      metadata: unknown;
      ipAddress: string;
      userAgent: string;
      createdAt: Date;
    }>`
      SELECT a.id::text AS "id", a.actor_user_id::text AS "actorUserId", u.full_name AS "actorName",
             u.email AS "actorEmail", a.action, a.resource_type AS "resourceType", a.resource_id AS "resourceId",
             a.metadata, a.ip_address AS "ipAddress", a.user_agent AS "userAgent", a.created_at AS "createdAt"
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${search}
      ORDER BY a.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`.execute(this.db);

    const items = rows.rows.map(
      (r): AuditEntry => ({
        id: r.id,
        actorUserId: r.actorUserId,
        // omitempty pointers in Go: omitted when NULL.
        ...(r.actorName !== null && { actorName: r.actorName }),
        ...(r.actorEmail !== null && { actorEmail: r.actorEmail }),
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: asObject(r.metadata),
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        createdAt: r.createdAt,
      }),
    );
    return { items: items.length > 0 ? items : null, total: count.rows[0]?.total ?? 0 };
  }
}

/** jsonb decoded into a Go map[string]any: anything that is not an object becomes {}; keys sorted. */
export function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? goSortKeys(v as Record<string, unknown>) : {};
}
