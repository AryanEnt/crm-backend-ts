import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { goMapOrNull } from "../../lib/go-json.js";
import { internal } from "../../lib/request-meta.js";

export const NOTIFICATION_TYPES = ["lead_sla_exceeded"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface InAppNotification {
  id: string;
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  leadId: string | null;
  payload: Record<string, unknown> | null;
  dedupeKey: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListFilter {
  unread: boolean;
  type: string;
  createdFrom: string;
  createdTo: string;
  limit: number;
  offset: number;
}

export interface InsertNotification {
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  leadId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

const COLS = sql`
  id::text AS "id", recipient_user_id::text AS "recipientUserId", type, title, body,
  lead_id::text AS "leadId", payload, dedupe_key AS "dedupeKey", read_at AS "readAt", created_at AS "createdAt"`;

type Row = Omit<InAppNotification, "payload"> & { payload: unknown };

const toNotification = (r: Row): InAppNotification => ({ ...r, payload: goMapOrNull(r.payload) });

function clampPage(limit: number, offset: number): { limit: number; offset: number } {
  let lim = limit;
  if (lim <= 0 || lim > 100) lim = 25;
  const off = offset < 0 ? 0 : offset;
  return { limit: lim, offset: off };
}

export function validNotificationType(type: string): boolean {
  return type === "" || (NOTIFICATION_TYPES as readonly string[]).includes(type);
}

export class NotificationsService {
  constructor(private readonly db: Database) {}

  async list(recipientUserId: string, f: NotificationListFilter): Promise<{ items: InAppNotification[]; total: number; limit: number; offset: number }> {
    const { limit, offset } = clampPage(f.limit, f.offset);
    const type = f.type.trim();
    const from = f.createdFrom.trim();
    const to = f.createdTo.trim();
    const whereParts = [sql`recipient_user_id = ${recipientUserId}::uuid`];
    if (f.unread) whereParts.push(sql`read_at IS NULL`);
    if (type !== "") whereParts.push(sql`type = ${type}`);
    if (from !== "") whereParts.push(sql`created_at >= ${from}::timestamptz`);
    if (to !== "") whereParts.push(sql`created_at < ${to}::timestamptz`);
    const where = sql.join(whereParts, sql` AND `);
    try {
      const total = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM in_app_notifications WHERE ${where}`.execute(this.db);
      const rows = await sql<Row>`
        SELECT ${COLS}
        FROM in_app_notifications
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
      return { items: rows.rows.map(toNotification), total: total.rows[0]?.n ?? 0, limit, offset };
    } catch (err) {
      throw AppError.internal("list notifications", err);
    }
  }

  async unreadCount(recipientUserId: string): Promise<number> {
    try {
      const r = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM in_app_notifications
        WHERE recipient_user_id = ${recipientUserId}::uuid AND read_at IS NULL`.execute(this.db);
      return r.rows[0]?.n ?? 0;
    } catch (err) {
      throw AppError.internal("count unread notifications", err);
    }
  }

  async markRead(recipientUserId: string, id: string, read: boolean): Promise<InAppNotification> {
    try {
      const r = await sql<Row>`
        UPDATE in_app_notifications
        SET read_at = ${read ? sql`COALESCE(read_at, NOW())` : sql`NULL`}
        WHERE id = ${id}::uuid AND recipient_user_id = ${recipientUserId}::uuid
        RETURNING ${COLS}`.execute(this.db);
      const row = r.rows[0];
      if (!row) throw AppError.notFound("notification not found");
      return toNotification(row);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.internal("update notification", err);
    }
  }

  async markAllRead(recipientUserId: string): Promise<number> {
    try {
      const r = await sql<{ n: number }>`
        WITH updated AS (
          UPDATE in_app_notifications
          SET read_at = NOW()
          WHERE recipient_user_id = ${recipientUserId}::uuid AND read_at IS NULL
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM updated`.execute(this.db);
      return r.rows[0]?.n ?? 0;
    } catch (err) {
      throw AppError.internal("mark notifications read", err);
    }
  }

  /**
   * Inserts one inbox row. Unique (recipient, dedupe_key) makes concurrent scans a no-op.
   * Returns whether a row was created.
   */
  async insertIfNew(in_: InsertNotification): Promise<boolean> {
    const r = await internal("insert notification", () =>
      sql<{ id: string }>`
        INSERT INTO in_app_notifications
          (recipient_user_id, type, title, body, lead_id, payload, dedupe_key)
        VALUES (
          ${in_.recipientUserId}::uuid, ${in_.type}, ${in_.title}, ${in_.body},
          ${in_.leadId}::uuid, ${JSON.stringify(in_.payload)}::jsonb, ${in_.dedupeKey}
        )
        ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
        RETURNING id::text AS id`.execute(this.db),
    );
    return (r.rows[0]?.id ?? "") !== "";
  }
}
