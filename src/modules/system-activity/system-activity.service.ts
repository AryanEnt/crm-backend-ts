import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goMapOrNull } from "../../lib/go-json.js";

export interface SystemEvent {
  id: string;
  eventType: string;
  title: string;
  description: string;
  actorUserId: string | null;
  actorName: string | null;
  teamId: string | null;
  teamName: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  result: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SystemEventInput {
  eventType: string;
  title: string;
  description?: string;
  actorUserId?: string;
  teamId?: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemEventFilter {
  q: string;
  eventType: string;
  entityType: string;
  result: string;
  actorUserId: string;
  limit: number;
  offset: number;
}

const eventSelect = sql`
  SELECT e.id::text AS "id", e.event_type AS "eventType", e.title, e.description,
    e.actor_user_id::text AS "actorUserId", u.full_name AS "actorName", e.team_id::text AS "teamId", t.name AS "teamName",
    e.entity_type AS "entityType", e.entity_id::text AS "entityId", e.entity_label AS "entityLabel", e.result,
    e.metadata, e.created_at AS "createdAt"
  FROM system_activity_events e
  LEFT JOIN users u ON u.id = e.actor_user_id
  LEFT JOIN teams t ON t.id = e.team_id`;

type EventRow = Omit<SystemEvent, "metadata"> & { metadata: unknown };

const toEvent = (r: EventRow): SystemEvent => ({ ...r, metadata: goMapOrNull(r.metadata) });

export class SystemActivityService {
  constructor(private readonly db: Database) {}

  /** Fire-and-forget like the Go service: failures are ignored. */
  async record(in_: SystemEventInput): Promise<void> {
    try {
      await sql`
        INSERT INTO system_activity_events
          (event_type, title, description, actor_user_id, team_id, entity_type, entity_id, entity_label, result, metadata)
        VALUES (${in_.eventType}, ${in_.title}, ${in_.description ?? ""},
          NULLIF(${in_.actorUserId ?? ""}, '')::uuid, NULLIF(${in_.teamId ?? ""}, '')::uuid, ${in_.entityType ?? ""},
          NULLIF(${in_.entityId ?? ""}, '')::uuid, ${in_.entityLabel ?? ""}, ${in_.result || "success"},
          ${JSON.stringify(in_.metadata ?? null)}::jsonb)`.execute(this.db);
    } catch {
      // Go: `_, _ = s.pool.Exec(...)`.
    }
  }

  async list(f: SystemEventFilter): Promise<{ items: SystemEvent[]; total: number; limit: number }> {
    let limit = f.limit;
    if (limit <= 0 || limit > 100) limit = 50;
    const q = f.q.trim();
    const where = sql`
      (${q} = '' OR e.title ILIKE '%'||${q}||'%' OR e.description ILIKE '%'||${q}||'%' OR e.entity_label ILIKE '%'||${q}||'%')
      AND (${f.eventType} = '' OR e.event_type = ${f.eventType})
      AND (${f.entityType} = '' OR e.entity_type = ${f.entityType})
      AND (${f.result} = '' OR e.result = ${f.result})
      AND (${f.actorUserId} = '' OR e.actor_user_id::text = ${f.actorUserId})`;

    // Go ignores a failed count (total stays 0).
    const total = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM system_activity_events e WHERE ${where}`
      .execute(this.db)
      .then((r) => r.rows[0]?.total ?? 0)
      .catch(() => 0);

    // Go never checks rows.Err(), so execution errors (e.g. a negative OFFSET) yield an empty list.
    const rows = await sql<EventRow>`${eventSelect} WHERE ${where} ORDER BY e.created_at DESC LIMIT ${limit} OFFSET ${f.offset}`
      .execute(this.db)
      .then((r) => r.rows)
      .catch((): EventRow[] => []);
    return { items: rows.map(toEvent), total, limit };
  }

  async get(id: string): Promise<SystemEvent> {
    try {
      const r = await sql<EventRow>`${eventSelect} WHERE e.id = ${id}::uuid`.execute(this.db);
      const row = r.rows[0];
      if (row) return toEvent(row);
    } catch {
      // Go maps every error, including an invalid uuid, to not found.
    }
    throw AppError.notFound("event not found");
  }
}
