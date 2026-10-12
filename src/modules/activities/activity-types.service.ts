import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, isUniqueViolation, type RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";

export interface ActivityType {
  id: string;
  code: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isSystem: boolean;
  isActive: boolean;
  allowsExternal: boolean;
  position: number;
  requiresDatetime: boolean;
  requiresDuration: boolean;
  requiresOutcome: boolean;
  requiresNotes: boolean;
}

export interface CreateTypeInput {
  name: string;
  code: string;
  description: string;
  color: string;
  icon: string;
  isActive?: boolean | undefined;
  position?: number | undefined;
  requiresDatetime: boolean;
  requiresDuration: boolean;
  requiresOutcome: boolean;
  requiresNotes: boolean;
}

export interface UpdateTypeInput {
  name?: string | undefined;
  description?: string | undefined;
  color?: string | undefined;
  icon?: string | undefined;
  isActive?: boolean | undefined;
  position?: number | undefined;
  requiresDatetime?: boolean | undefined;
  requiresDuration?: boolean | undefined;
  requiresOutcome?: boolean | undefined;
  requiresNotes?: boolean | undefined;
}

const typeColumns = sql`id::text AS "id", code, name, description, color, icon, is_system AS "isSystem",
  is_active AS "isActive", allows_external AS "allowsExternal", position,
  COALESCE(requires_datetime,false) AS "requiresDatetime", COALESCE(requires_duration,false) AS "requiresDuration",
  COALESCE(requires_outcome,false) AS "requiresOutcome", COALESCE(requires_notes,false) AS "requiresNotes"`;

/** Lowercase, spaces to underscores, then only [a-z0-9_]. */
export function slugifyTypeCode(name: string): string {
  const out = [...name.trim().toLowerCase().replaceAll(" ", "_")].filter((ch) => /^[a-z0-9_]$/.test(ch)).join("");
  return out === "" ? "activity_type" : out;
}

export class ActivityTypesRepository {
  constructor(private readonly db: Database) {}

  async list(includeInactive: boolean): Promise<ActivityType[]> {
    const r = await sql<ActivityType>`
      SELECT ${typeColumns} FROM activity_types
      WHERE (${includeInactive}::bool OR is_active = TRUE)
      ORDER BY position, name`.execute(this.db);
    return r.rows;
  }

  async byCode(code: string): Promise<ActivityType | null> {
    const r = await sql<ActivityType>`SELECT ${typeColumns} FROM activity_types WHERE code=${code}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async byId(id: string): Promise<ActivityType | null> {
    const r = await sql<ActivityType>`SELECT ${typeColumns} FROM activity_types WHERE id=${id}::uuid`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async create(in_: CreateTypeInput): Promise<ActivityType> {
    const name = in_.name.trim();
    if (name === "") throw AppError.validation("name is required");
    const code = slugifyTypeCode(in_.code.trim() === "" ? name : in_.code.trim());
    const color = in_.color.trim() || "slate";
    const icon = in_.icon.trim() || "circle";
    try {
      const r = await sql<ActivityType>`
        INSERT INTO activity_types (code, name, description, color, icon, is_system, is_active, allows_external, position,
          requires_datetime, requires_duration, requires_outcome, requires_notes)
        VALUES (${code}, ${name}, ${in_.description.trim()}, ${color}, ${icon}, FALSE, ${in_.isActive ?? true}, FALSE,
          ${in_.position ?? 100}, ${in_.requiresDatetime}, ${in_.requiresDuration}, ${in_.requiresOutcome}, ${in_.requiresNotes})
        RETURNING ${typeColumns}`.execute(this.db);
      return r.rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict("activity type code already exists");
      throw err;
    }
  }

  async update(id: string, cur: ActivityType, in_: UpdateTypeInput): Promise<ActivityType> {
    let name = cur.name;
    if (in_.name !== undefined) {
      name = in_.name.trim();
      if (name === "") throw AppError.validation("name is required");
    }
    const r = await sql<ActivityType>`
      UPDATE activity_types SET
        name=${name}, description=${in_.description !== undefined ? in_.description.trim() : cur.description},
        color=${in_.color?.trim() || cur.color}, icon=${in_.icon?.trim() || cur.icon},
        is_active=${in_.isActive ?? cur.isActive}, position=${in_.position ?? cur.position},
        requires_datetime=${in_.requiresDatetime ?? cur.requiresDatetime},
        requires_duration=${in_.requiresDuration ?? cur.requiresDuration},
        requires_outcome=${in_.requiresOutcome ?? cur.requiresOutcome},
        requires_notes=${in_.requiresNotes ?? cur.requiresNotes}
      WHERE id=${id}::uuid
      RETURNING ${typeColumns}`.execute(this.db);
    if (!r.rows[0]) throw AppError.notFound("activity type not found");
    return r.rows[0];
  }

  async delete(id: string): Promise<void> {
    const cur = await this.byId(id);
    if (!cur) throw AppError.notFound("activity type not found");
    const usage = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM activities WHERE kind=${cur.code}`.execute(this.db);
    if ((usage.rows[0]?.n ?? 0) > 0) {
      throw AppError.validation("cannot delete activity type in use; deactivate it instead");
    }
    const r = await sql`DELETE FROM activity_types WHERE id=${id}::uuid AND is_system=FALSE`.execute(this.db);
    if (Number(r.numAffectedRows ?? 0) === 0) {
      if (cur.isSystem) throw AppError.validation("system activity types cannot be deleted; deactivate instead");
      throw AppError.notFound("activity type not found");
    }
  }
}

export class ActivityTypesService {
  readonly repo: ActivityTypesRepository;

  constructor(
    db: Database,
    private readonly audit: AuditService,
  ) {
    this.repo = new ActivityTypesRepository(db);
  }

  async listActive(): Promise<ActivityType[]> {
    return internal("failed to list activity types", () => this.repo.list(false));
  }

  async listAll(): Promise<ActivityType[]> {
    return internal("failed to list activity types", () => this.repo.list(true));
  }

  async create(actorId: string, in_: CreateTypeInput, meta: RequestMeta): Promise<ActivityType> {
    const t = await internal("failed to create activity type", () => this.repo.create(in_));
    await this.audit.record(actorId, "activity_type.created", "activity_type", t.id, { code: t.code, name: t.name }, meta);
    return t;
  }

  async update(actorId: string, id: string, in_: UpdateTypeInput, meta: RequestMeta): Promise<ActivityType> {
    const cur = await internal("failed to load activity type", () => this.repo.byId(id));
    if (!cur) throw AppError.notFound("activity type not found");
    const t = await internal("failed to update activity type", () => this.repo.update(id, cur, in_));
    await this.audit.record(
      actorId,
      "activity_type.updated",
      "activity_type",
      id,
      { code: t.code, name: t.name, isActive: t.isActive },
      meta,
    );
    return t;
  }

  async delete(actorId: string, id: string, meta: RequestMeta): Promise<void> {
    const cur = await internal("failed to load activity type", () => this.repo.byId(id));
    if (!cur) throw AppError.notFound("activity type not found");
    await internal("failed to delete activity type", () => this.repo.delete(id));
    await this.audit.record(actorId, "activity_type.deleted", "activity_type", id, { code: cur.code, name: cur.name }, meta);
  }
}
