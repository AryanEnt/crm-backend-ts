import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { logger } from "../../logger.js";
import { NotificationsService } from "./notifications.service.js";
import { SLA_NOTIFICATION_TYPE, slaDedupeKey, slaExceededCopy, slaLimitDays, daysFromHours } from "./sla-copy.js";

/** Postgres advisory lock key for the SLA scan; distinct from other workers. */
export const SLA_SCAN_LOCK = 850_015;

export interface SlaBreachRow {
  leadId: string;
  leadName: string;
  stageId: string;
  stageName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  teamLeadUserId: string | null;
  slaHours: number;
  hoursInStage: number;
  stageEnteredAt: Date;
}

function settingTrue(raw: string | undefined): boolean {
  const v = (raw ?? "true").trim().toLowerCase();
  return v === "true" || v === "1" || v === "t" || v === "yes";
}

export function parseScanMinutes(raw: string | undefined, fallback = 15): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/**
 * Open leads whose time in the current stage is at or past the stage SLA.
 * Matches pipeline card red (`hours / slaHours >= 1`) and ignores closed/archived leads.
 */
export async function findSlaBreaches(db: Database, limit = 200): Promise<SlaBreachRow[]> {
  const r = await sql<SlaBreachRow>`
    SELECT
      l.id::text AS "leadId",
      l.full_name AS "leadName",
      l.stage_id::text AS "stageId",
      ps.name AS "stageName",
      l.owner_user_id::text AS "ownerUserId",
      ou.full_name AS "ownerName",
      t.team_lead_user_id::text AS "teamLeadUserId",
      ps.sla_hours AS "slaHours",
      EXTRACT(EPOCH FROM (NOW() - COALESCE(l.stage_entered_at, l.updated_at))) / 3600.0 AS "hoursInStage",
      COALESCE(l.stage_entered_at, l.updated_at) AS "stageEnteredAt"
    FROM leads l
    INNER JOIN pipeline_stages ps ON ps.id = l.stage_id
    LEFT JOIN users ou ON ou.id = l.owner_user_id
    LEFT JOIN teams t ON t.id = l.team_id
    WHERE l.is_archived = FALSE
      AND l.status NOT IN ('won', 'lost', 'converted', 'archived', 'unqualified')
      AND COALESCE(ps.is_won, FALSE) = FALSE
      AND COALESCE(ps.is_lost, FALSE) = FALSE
      AND ps.sla_hours IS NOT NULL
      AND ps.sla_hours > 0
      AND l.stage_id IS NOT NULL
      AND EXTRACT(EPOCH FROM (NOW() - COALESCE(l.stage_entered_at, l.updated_at))) / 3600.0 >= ps.sla_hours
    ORDER BY COALESCE(l.stage_entered_at, l.updated_at) ASC
    LIMIT ${limit}`.execute(db);
  return r.rows;
}

export async function notifyTeamLeadEnabled(db: Database): Promise<boolean> {
  const r = await sql<{ value: string }>`
    SELECT value FROM organization_settings WHERE key = 'notifications.sla_notify_team_lead'`.execute(db);
  return settingTrue(r.rows[0]?.value);
}

export async function slaScanMinutes(db: Database): Promise<number> {
  const r = await sql<{ value: string }>`
    SELECT value FROM organization_settings WHERE key = 'notifications.sla_scan_minutes'`.execute(db);
  return parseScanMinutes(r.rows[0]?.value);
}

function recipients(row: SlaBreachRow, includeTeamLead: boolean): string[] {
  const ids: string[] = [];
  if (row.ownerUserId) ids.push(row.ownerUserId);
  if (includeTeamLead && row.teamLeadUserId && row.teamLeadUserId !== row.ownerUserId) {
    ids.push(row.teamLeadUserId);
  }
  return [...new Set(ids)];
}

/** Delivers one inbox item per recipient for each current SLA breach. Failures on one lead do not stop the scan. */
export async function scanSlaBreaches(db: Database, inbox: NotificationsService): Promise<{ considered: number; created: number }> {
  const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${SLA_SCAN_LOCK}) AS ok`.execute(db);
  if (!lock.rows[0]?.ok) return { considered: 0, created: 0 };
  try {
    const [breaches, notifyTl] = await Promise.all([findSlaBreaches(db), notifyTeamLeadEnabled(db)]);
    let created = 0;
    for (const row of breaches) {
      try {
        const copy = slaExceededCopy({
          leadName: row.leadName,
          stageName: row.stageName,
          hoursInStage: Number(row.hoursInStage),
          slaHours: Number(row.slaHours),
          ownerName: row.ownerName ?? "",
        });
        const entered = new Date(row.stageEnteredAt);
        const dedupeKey = slaDedupeKey(row.leadId, row.stageId, entered);
        const payload = {
          leadId: row.leadId,
          leadName: row.leadName,
          stageId: row.stageId,
          stageName: row.stageName,
          ownerUserId: row.ownerUserId,
          ownerName: row.ownerName,
          hoursInStage: Number(row.hoursInStage),
          slaHours: Number(row.slaHours),
          daysInStage: daysFromHours(Number(row.hoursInStage)),
          slaDays: slaLimitDays(Number(row.slaHours)),
        };
        for (const recipientUserId of recipients(row, notifyTl)) {
          const inserted = await inbox.insertIfNew({
            recipientUserId,
            type: SLA_NOTIFICATION_TYPE,
            title: copy.title,
            body: copy.body,
            leadId: row.leadId,
            payload,
            dedupeKey,
          });
          if (inserted) created += 1;
        }
      } catch (err) {
        logger.warn({ leadId: row.leadId, error: err instanceof Error ? err.message : String(err) }, "sla notification failed");
      }
    }
    logger.info({ considered: breaches.length, created }, "sla scan finished");
    return { considered: breaches.length, created };
  } finally {
    await sql`SELECT pg_advisory_unlock(${SLA_SCAN_LOCK})`.execute(db).catch(() => undefined);
  }
}
