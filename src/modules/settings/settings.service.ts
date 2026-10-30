import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import type { RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";

export interface Setting {
  key: string;
  value: string;
  valueType: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** Non-sensitive defaults any CRM user may read for form prefill. */
const DEFAULT_KEYS = [
  "organization.timezone",
  "organization.currency",
  "organization.date_format",
  "organization.time_format",
  "crm.default_pipeline_id",
  "crm.default_lead_source",
  "crm.default_activity_type",
  "crm.default_lead_priority",
  "crm.default_deal_currency",
  "crm.default_followup_hours",
  "crm.default_activity_duration_minutes",
];

const ALLOWED_KEYS = new Set([
  "organization.name",
  "organization.email",
  "organization.phone",
  "organization.address",
  "organization.timezone",
  "organization.currency",
  "organization.date_format",
  "organization.time_format",
  "crm.default_pipeline_id",
  "crm.default_lead_source",
  "crm.default_activity_type",
  "crm.default_lead_priority",
  "crm.default_deal_currency",
  "crm.default_followup_hours",
  "crm.default_activity_duration_minutes",
  "notifications.email_enabled",
  "notifications.activity_reminders",
  "notifications.overdue_alerts",
  "notifications.automation",
  "notifications.sla_notify_team_lead",
  "notifications.sla_scan_minutes",
  "security.session_hours",
]);

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<Setting[]> {
    try {
      const r = await sql<Setting>`
        SELECT key, value, value_type AS "valueType", updated_by::text AS "updatedBy", updated_at AS "updatedAt"
        FROM organization_settings ORDER BY key`.execute(this.db);
      return r.rows;
    } catch (err) {
      throw AppError.internal("list settings", err);
    }
  }

  async map(): Promise<Map<string, string>> {
    return new Map((await this.list()).map((s) => [s.key, s.value]));
  }

  /** Go encodes map[string]string with keys sorted. */
  async defaults(): Promise<Record<string, string>> {
    const all = await this.map();
    const out: Record<string, string> = {};
    for (const key of [...DEFAULT_KEYS].sort()) {
      const v = all.get(key);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  /** Missing keys and errors both read as "" (Go ignores the error). */
  async get(key: string): Promise<string> {
    try {
      const r = await sql<{ value: string }>`SELECT value FROM organization_settings WHERE key=${key}`.execute(this.db);
      return r.rows[0]?.value ?? "";
    } catch {
      return "";
    }
  }

  async update(actorId: string, settings: Record<string, string> | undefined, meta: RequestMeta): Promise<Setting[]> {
    const entries = Object.entries(settings ?? {});
    if (entries.length === 0) return this.list();
    // Go iterates a map in random order and stops at the first unknown key, possibly after
    // writing others. Validating everything up front is deterministic and never half-applies.
    for (const [key] of entries) {
      if (!ALLOWED_KEYS.has(key)) throw AppError.validation(`unknown setting key: ${key}`);
    }
    for (const [key, value] of entries) {
      try {
        await sql`
          INSERT INTO organization_settings (key, value, value_type, updated_by)
          VALUES (${key}, ${value.trim()}, 'string', ${actorId}::uuid)
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`.execute(
          this.db,
        );
      } catch (err) {
        throw AppError.internal("update setting", err);
      }
    }
    await this.audit.record(actorId, "settings.updated", "organization_settings", null, { keys: entries.map(([k]) => k) }, meta);
    return this.list();
  }
}
