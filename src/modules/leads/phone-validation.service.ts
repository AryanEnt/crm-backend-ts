import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { logger } from "../../logger.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import {
  PHONE_ISSUE_STATUSES,
  PHONE_NOTIFICATION_TYPE,
  combinePhoneStatus,
  parseLeadPhone,
  phoneInputHash,
  phoneIssueCopy,
  phoneIssueDedupeKey,
  type PhoneValidationStatus,
} from "./phone-validation.js";

/** Distinct advisory lock key for phone validation scans. */
export const PHONE_VALIDATION_LOCK = 850_016;
export const PHONE_NOTIFY_LOCK = 850_017;

const REMINDER_MS = 24 * 60 * 60 * 1000;

export interface PhoneValidationFields {
  phoneValidationStatus: PhoneValidationStatus;
  phoneNormalized: string | null;
  phoneValidationMessage: string;
  phoneDuplicateLeadIds: string[];
  phoneValidatedAt: Date | null;
  phoneLastNotifiedAt: Date | null;
  phoneValidationVersion: number;
  phoneCountryCode: string;
  createdByUserId: string | null;
}

type LeadPhoneRow = {
  id: string;
  fullName: string;
  phone: string | null;
  country: string;
  phoneCountryCode: string;
  phoneValidationVersion: number | string;
  phoneInputHash: string;
  createdByUserId: string | null;
  ownerUserId: string | null;
  teamId: string | null;
};

type DupRow = { id: string };

export class PhoneValidationService {
  constructor(
    private readonly db: Database,
    private readonly inbox = new NotificationsService(db),
  ) {}

  /** Mark pending + bump version after create/update. Returns the new version for the job. */
  async markPending(
    leadId: string,
    phone: string | null,
    phoneCountryCode: string,
    country: string,
  ): Promise<{ version: number; hash: string; enqueue: boolean }> {
    const hash = phoneInputHash(phone, phoneCountryCode, country);
    const empty = !(phone ?? "").trim();
    const status: PhoneValidationStatus = empty ? "valid" : "pending";
    const r = await sql<{ version: number | string }>`
      UPDATE leads SET
        phone_country_code = ${phoneCountryCode.trim().toUpperCase()},
        phone_validation_status = ${status},
        phone_normalized = NULL,
        phone_validation_message = ${empty ? "" : "Queued for validation"},
        phone_duplicate_lead_ids = '{}'::uuid[],
        phone_validated_at = CASE WHEN ${empty}::bool THEN NOW() ELSE NULL END,
        phone_last_notified_at = NULL,
        phone_validation_version = phone_validation_version + 1,
        phone_input_hash = ${hash}
      WHERE id = ${leadId}::uuid
      RETURNING phone_validation_version AS version`.execute(this.db);
    const version = Number(r.rows[0]?.version ?? 0);
    return { version, hash, enqueue: !empty };
  }

  /** Idempotent validation for one lead; no-ops when the phone hash/version is stale. */
  async validateLead(leadId: string, expectedVersion?: number): Promise<boolean> {
    const result = await this.db.transaction().execute(async (tx) => {
      const loaded = await sql<LeadPhoneRow>`
        SELECT
          l.id::text AS "id",
          l.full_name AS "fullName",
          l.phone,
          l.country,
          l.phone_country_code AS "phoneCountryCode",
          l.phone_validation_version AS "phoneValidationVersion",
          l.phone_input_hash AS "phoneInputHash",
          l.created_by_user_id::text AS "createdByUserId",
          l.owner_user_id::text AS "ownerUserId",
          l.team_id::text AS "teamId"
        FROM leads l
        WHERE l.id = ${leadId}::uuid
        FOR UPDATE`.execute(tx);
      const lead = loaded.rows[0];
      if (!lead) return null;

      const version = Number(lead.phoneValidationVersion);
      if (expectedVersion !== undefined && expectedVersion !== version) {
        logger.info({ leadId, expectedVersion, version }, "phone validation skipped (stale version)");
        return null;
      }

      const hash = phoneInputHash(lead.phone, lead.phoneCountryCode, lead.country);
      if (hash !== lead.phoneInputHash && lead.phoneInputHash !== "") {
        logger.info({ leadId }, "phone validation skipped (hash mismatch)");
        return null;
      }

      const parsed = parseLeadPhone(lead.phone, lead.phoneCountryCode, lead.country);
      const lockKey = parsed.e164 || parsed.digits || lead.id;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`phone:${lockKey}`}))`.execute(tx);

      const duplicateIds = await this.findDuplicateLeadIds(tx, lead.id, parsed.e164, parsed.digits);
      const combined = combinePhoneStatus(parsed.kind, duplicateIds.length > 0);
      const message = combined.status === "valid" ? "" : parsed.message || combined.message;

      const applied = await sql<{ id: string }>`
        UPDATE leads SET
          phone_validation_status = ${combined.status},
          phone_normalized = ${parsed.e164},
          phone_validation_message = ${message},
          phone_duplicate_lead_ids = ${duplicateIds}::uuid[],
          phone_validated_at = NOW()
        WHERE id = ${lead.id}::uuid
          AND phone_validation_version = ${version}
          AND (phone_input_hash = ${hash} OR phone_input_hash = '')
        RETURNING id::text AS id`.execute(tx);

      if (!applied.rows[0]) {
        logger.info({ leadId }, "phone validation result discarded (concurrent update)");
        return null;
      }

      return { lead, status: combined.status };
    });

    if (!result) return false;
    if (PHONE_ISSUE_STATUSES.has(result.status)) {
      await this.notifyIssue(result.lead, result.status, true);
    }
    return true;
  }

  async processPending(limit = 50): Promise<number> {
    const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${PHONE_VALIDATION_LOCK}) AS ok`.execute(this.db);
    if (!lock.rows[0]?.ok) return 0;
    try {
      const pending = await sql<{ id: string; version: number | string }>`
        SELECT id::text AS id, phone_validation_version AS version
        FROM leads
        WHERE phone_validation_status = 'pending'
          AND is_archived = FALSE
        ORDER BY updated_at ASC
        LIMIT ${limit}`.execute(this.db);
      let n = 0;
      for (const row of pending.rows) {
        try {
          if (await this.validateLead(row.id, Number(row.version))) n += 1;
        } catch (err) {
          logger.warn(
            { leadId: row.id, error: err instanceof Error ? err.message : String(err) },
            "phone validation failed",
          );
        }
      }
      return n;
    } finally {
      await sql`SELECT pg_advisory_unlock(${PHONE_VALIDATION_LOCK})`.execute(this.db).catch(() => undefined);
    }
  }

  /** Initial + daily reminders for unresolved phone issues. */
  async processReminders(limit = 100): Promise<number> {
    const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${PHONE_NOTIFY_LOCK}) AS ok`.execute(this.db);
    if (!lock.rows[0]?.ok) return 0;
    try {
      const rows = await sql<LeadPhoneRow & { phoneValidationStatus: string; phoneLastNotifiedAt: Date | null }>`
        SELECT
          l.id::text AS "id",
          l.full_name AS "fullName",
          l.phone,
          l.country,
          l.phone_country_code AS "phoneCountryCode",
          l.phone_validation_version AS "phoneValidationVersion",
          l.phone_input_hash AS "phoneInputHash",
          l.created_by_user_id::text AS "createdByUserId",
          l.owner_user_id::text AS "ownerUserId",
          l.team_id::text AS "teamId",
          l.phone_validation_status AS "phoneValidationStatus",
          l.phone_last_notified_at AS "phoneLastNotifiedAt"
        FROM leads l
        WHERE l.is_archived = FALSE
          AND l.phone_validation_status IN ('invalid', 'duplicate', 'invalid_duplicate', 'needs_review')
          AND (
            l.phone_last_notified_at IS NULL
            OR l.phone_last_notified_at <= NOW() - INTERVAL '24 hours'
          )
        ORDER BY l.phone_last_notified_at NULLS FIRST, l.created_at ASC
        LIMIT ${limit}`.execute(this.db);

      let created = 0;
      for (const row of rows.rows) {
        try {
          if (await this.notifyIssue(row, row.phoneValidationStatus as PhoneValidationStatus, false)) {
            created += 1;
          }
        } catch (err) {
          logger.warn(
            { leadId: row.id, error: err instanceof Error ? err.message : String(err) },
            "phone issue notification failed",
          );
        }
      }
      return created;
    } finally {
      await sql`SELECT pg_advisory_unlock(${PHONE_NOTIFY_LOCK})`.execute(this.db).catch(() => undefined);
    }
  }

  private async findDuplicateLeadIds(
    db: Database,
    leadId: string,
    e164: string | null,
    digits: string,
  ): Promise<string[]> {
    if (e164) {
      const r = await sql<DupRow>`
        SELECT id::text AS id
        FROM leads
        WHERE is_archived = FALSE
          AND id <> ${leadId}::uuid
          AND phone_normalized = ${e164}
        ORDER BY created_at ASC
        LIMIT 25`.execute(db);
      return r.rows.map((x) => x.id);
    }
    if (digits.length >= 8) {
      // Fallback digit match when the number is invalid / unnormalized.
      const r = await sql<DupRow>`
        SELECT id::text AS id
        FROM leads
        WHERE is_archived = FALSE
          AND id <> ${leadId}::uuid
          AND phone IS NOT NULL
          AND regexp_replace(phone, '\D', '', 'g') = ${digits}
        ORDER BY created_at ASC
        LIMIT 25`.execute(db);
      return r.rows.map((x) => x.id);
    }
    return [];
  }

  private async notifyIssue(
    lead: LeadPhoneRow,
    status: PhoneValidationStatus,
    initial: boolean,
  ): Promise<boolean> {
    const recipient = await this.resolveRecipient(lead);
    if (!recipient) return false;

    const now = Date.now();
    const copy = phoneIssueCopy(lead.fullName);
    const dedupeKey = phoneIssueDedupeKey(lead.id, now);
    const inserted = await this.inbox.insertIfNew({
      recipientUserId: recipient,
      type: PHONE_NOTIFICATION_TYPE,
      title: copy.title,
      body: copy.body,
      leadId: lead.id,
      payload: {
        leadId: lead.id,
        leadName: lead.fullName,
        status,
        initial,
      },
      dedupeKey,
    });

    if (inserted) {
      await sql`
        UPDATE leads
        SET phone_last_notified_at = NOW()
        WHERE id = ${lead.id}::uuid
          AND phone_validation_status IN ('invalid', 'duplicate', 'invalid_duplicate', 'needs_review')`.execute(
        this.db,
      );
    } else if (initial) {
      // Same calendar-day dedupe already exists; still stamp so reminder clock starts.
      await sql`
        UPDATE leads
        SET phone_last_notified_at = COALESCE(phone_last_notified_at, NOW())
        WHERE id = ${lead.id}::uuid`.execute(this.db);
    }
    return inserted;
  }

  /**
   * Prefer the original creator when active; otherwise owner, then team lead
   * (same fallback spirit as SLA notifications).
   */
  private async resolveRecipient(lead: LeadPhoneRow): Promise<string | null> {
    const candidates = [lead.createdByUserId, lead.ownerUserId].filter(Boolean) as string[];
    if (lead.teamId) {
      const tl = await sql<{ id: string }>`
        SELECT team_lead_user_id::text AS id FROM teams WHERE id = ${lead.teamId}::uuid`.execute(this.db);
      if (tl.rows[0]?.id) candidates.push(tl.rows[0].id);
    }
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return null;
    const active = await sql<{ id: string }>`
      SELECT id::text AS id FROM users
      WHERE id = ANY(${unique}::uuid[]) AND is_active = TRUE`.execute(this.db);
    const activeSet = new Set(active.rows.map((r) => r.id));
    return unique.find((id) => activeSet.has(id)) ?? null;
  }
}

/** Fire-and-forget after create/update; failures are retried by the worker. */
export function enqueuePhoneValidation(
  service: PhoneValidationService,
  leadId: string,
  version: number,
): void {
  setImmediate(() => {
    void service.validateLead(leadId, version).catch((err) => {
      logger.warn(
        { leadId, version, error: err instanceof Error ? err.message : String(err) },
        "enqueue phone validation failed",
      );
    });
  });
}

export const PHONE_REMINDER_MS = REMINDER_MS;
