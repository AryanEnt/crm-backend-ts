import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import type { RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";

export interface LeadSource {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  position: number;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLeadSourceInput {
  name: string;
  description: string;
  isActive?: boolean | undefined;
  position?: number | undefined;
}

export interface UpdateLeadSourceInput {
  name?: string | undefined;
  description?: string | undefined;
  isActive?: boolean | undefined;
  position?: number | undefined;
}

/** Leads plus customers whose free-text source matches the name, case-insensitively. */
const usage = (nameColumn: string) => sql<number>`
  (SELECT COUNT(*)::int FROM leads l WHERE lower(l.source) = lower(${sql.raw(nameColumn)}))
  + (SELECT COUNT(*)::int FROM customers c WHERE lower(c.source) = lower(${sql.raw(nameColumn)}))`;

const columns = (table: string) => sql`
  ${sql.raw(table)}.id::text AS "id", ${sql.raw(table)}.code, ${sql.raw(table)}.name, ${sql.raw(table)}.description,
  ${sql.raw(table)}.is_active AS "isActive", ${sql.raw(table)}.position,
  ${usage(`${table}.name`)} AS "usageCount",
  ${sql.raw(table)}.created_at AS "createdAt", ${sql.raw(table)}.updated_at AS "updatedAt"`;

export function slugify(name: string): string {
  const s = name.trim().toLowerCase().replaceAll(" ", "_");
  const out = [...s].filter((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_").join("");
  return out === "" ? "source" : out;
}

export class LeadSourcesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(activeOnly: boolean, q: string): Promise<LeadSource[]> {
    const search = q.trim();
    try {
      const r = await sql<LeadSource>`
        SELECT ${columns("ls")}
        FROM lead_sources ls
        WHERE (${activeOnly}::bool = false OR ls.is_active = true)
          AND (${search} = '' OR ls.name ILIKE '%'||${search}||'%' OR ls.code ILIKE '%'||${search}||'%')
        ORDER BY ls.position, ls.name`.execute(this.db);
      return r.rows;
    } catch (err) {
      throw AppError.internal("failed to list lead sources", err);
    }
  }

  async create(actorId: string, in_: CreateLeadSourceInput, meta: RequestMeta): Promise<LeadSource> {
    const name = in_.name.trim();
    if (name === "") throw AppError.validation("source name is required");
    const code = slugify(name);

    let item: LeadSource;
    try {
      const r = await sql<LeadSource>`
        INSERT INTO lead_sources (code, name, description, is_active, position, created_by, updated_by)
        VALUES (${code}, ${name}, ${in_.description.trim()}, ${in_.isActive ?? true}, ${in_.position ?? 100},
          ${actorId}::uuid, ${actorId}::uuid)
        RETURNING id::text AS "id", code, name, description, is_active AS "isActive", position, 0 AS "usageCount",
          created_at AS "createdAt", updated_at AS "updatedAt"`.execute(this.db);
      item = r.rows[0]!;
    } catch (err) {
      if (err instanceof Error && err.message.includes("unique")) {
        throw AppError.conflict("a lead source with this name already exists");
      }
      throw AppError.internal("failed to create lead source", err);
    }
    await this.audit.record(actorId, "lead_source.created", "lead_source", item.id, { name: item.name, code: item.code }, meta);
    return item;
  }

  async update(actorId: string, id: string, in_: UpdateLeadSourceInput, meta: RequestMeta): Promise<LeadSource> {
    const cur = await this.get(id);
    let name = cur.name;
    if (in_.name !== undefined) {
      name = in_.name.trim();
      if (name === "") throw AppError.validation("source name is required");
    }
    const description = in_.description !== undefined ? in_.description.trim() : cur.description;
    const isActive = in_.isActive ?? cur.isActive;
    const position = in_.position ?? cur.position;

    let item: LeadSource;
    try {
      const r = await sql<LeadSource>`
        UPDATE lead_sources SET name=${name}, description=${description}, is_active=${isActive}, position=${position},
          updated_by=${actorId}::uuid
        WHERE id=${id}::uuid
        RETURNING ${columns("lead_sources")}`.execute(this.db);
      item = r.rows[0]!;
      if (!item) throw new Error("no rows in result set");
    } catch (err) {
      throw AppError.internal("failed to update lead source", err);
    }
    await this.audit.record(actorId, "lead_source.updated", "lead_source", item.id, { name: item.name, isActive: item.isActive }, meta);
    return item;
  }

  async delete(actorId: string, id: string, meta: RequestMeta): Promise<void> {
    const cur = await this.get(id);
    if (cur.usageCount > 0) {
      throw AppError.validation("cannot delete a lead source in use; deactivate it instead");
    }
    try {
      await sql`DELETE FROM lead_sources WHERE id=${id}::uuid`.execute(this.db);
    } catch (err) {
      throw AppError.internal("failed to delete lead source", err);
    }
    await this.audit.record(actorId, "lead_source.deleted", "lead_source", id, { name: cur.name }, meta);
  }

  private async get(id: string): Promise<LeadSource> {
    try {
      const r = await sql<LeadSource>`SELECT ${columns("lead_sources")} FROM lead_sources WHERE id=${id}::uuid`.execute(this.db);
      if (r.rows[0]) return r.rows[0];
    } catch {
      // Go maps every error, including an invalid uuid, to not found.
    }
    throw AppError.notFound("lead source not found");
  }
}
