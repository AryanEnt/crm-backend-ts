import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { goSortKeys } from "../../lib/go-json.js";
import { truncateBytes } from "../../lib/go-strings.js";
import { NoRowsError } from "../../lib/pgx.js";
import { computeAttention } from "../attention/attention.js";
import {
  actionJson,
  actionResultJson,
  conditionJson,
  decodeActionResults,
  decodeActions,
  decodeConditions,
  Trigger,
  type Action,
  type ActionResult,
  type Condition,
} from "./automation.definition.js";

export interface Automation {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  triggerType: string;
  conditions: Condition[];
  actions: Action[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  id: string;
  eventId: string | null;
  automationId: string | null;
  triggerType: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string;
  createdAt: Date;
}

export interface Run {
  automationId: string | null;
  automationName: string;
  jobId: string | null;
  eventId: string | null;
  triggerType: string;
  resourceType: string;
  resourceId: string | null;
  conditions: Condition[];
  conditionsMatched: boolean;
  actions: Action[];
  actionResults: ActionResult[];
  status: string;
  errorMessage: string;
}

export interface ClaimedEvent {
  id: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
}

export interface CreateAutomation {
  name: string;
  description: string;
  isActive: boolean;
  triggerType: string;
  conditions: Condition[];
  actions: Action[];
}

/** Go time.Format(time.RFC3339) in UTC. */
export const rfc3339 = (d: Date) => d.toISOString().slice(0, 19) + "Z";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const emptyToNull = (s: string | null | undefined) => (s == null || s.trim() === "" ? null : s);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- JSON shapes

export function automationJson(a: Automation): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    isActive: a.isActive,
    triggerType: a.triggerType,
    conditions: a.conditions.map(conditionJson),
    actions: a.actions.map(actionJson),
    ...(a.createdBy !== null && { createdBy: a.createdBy }),
    ...(a.updatedBy !== null && { updatedBy: a.updatedBy }),
    createdAt: rfc3339(a.createdAt),
    updatedAt: rfc3339(a.updatedAt),
  };
}

export function jobJson(j: Job): Record<string, unknown> {
  return {
    id: j.id,
    eventId: j.eventId,
    automationId: j.automationId,
    triggerType: j.triggerType,
    resourceType: j.resourceType,
    resourceId: j.resourceId,
    payload: goSortKeys(j.payload),
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    nextAttemptAt: rfc3339(j.nextAttemptAt),
    lastError: j.lastError,
    createdAt: rfc3339(j.createdAt),
  };
}

// ---------------------------------------------------------------- rows

interface AutomationRow {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  triggerType: string;
  conditions: unknown;
  actions: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const automationSelect = sql`
  SELECT id::text AS id, name, description, is_active AS "isActive", trigger_type AS "triggerType", conditions, actions,
    created_by::text AS "createdBy", updated_by::text AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM automations`;

const toAutomation = (r: AutomationRow): Automation => ({
  ...r,
  conditions: decodeConditions(r.conditions),
  actions: decodeActions(r.actions),
});

type JobRow = Omit<Job, "payload"> & { payload: unknown };

const jobSelect = sql`
  SELECT id::text AS id, event_id::text AS "eventId", automation_id::text AS "automationId", trigger_type AS "triggerType",
    resource_type AS "resourceType", resource_id::text AS "resourceId", payload, status, attempts, max_attempts AS "maxAttempts",
    next_attempt_at AS "nextAttemptAt", last_error AS "lastError", created_at AS "createdAt"
  FROM automation_jobs`;

const toJob = (r: JobRow): Job => ({ ...r, payload: isObject(r.payload) ? r.payload : {} });

/** Go retry delay after a failed attempt (attempts is the count before this one). */
export function backoffMs(attempts: number): number {
  if (attempts <= 1) return 30_000;
  if (attempts === 2) return 120_000;
  if (attempts === 3) return 600_000;
  return 1_800_000;
}

export class AutomationRepository {
  constructor(readonly db: Database) {}

  // ---------------------------------------------------------------- definitions

  async create(actorId: string, in_: CreateAutomation): Promise<Automation | null> {
    const id = randomUUID();
    await sql`
      INSERT INTO automations (id, name, description, is_active, trigger_type, conditions, actions, created_by, updated_by)
      VALUES (${id}, ${in_.name.trim()}, ${in_.description.trim()}, ${in_.isActive}, ${in_.triggerType},
        ${JSON.stringify(in_.conditions.map(conditionJson))}::jsonb, ${JSON.stringify(in_.actions.map(actionJson))}::jsonb,
        ${emptyToNull(actorId)}, ${emptyToNull(actorId)})`.execute(this.db);
    return this.get(id);
  }

  async update(actorId: string, id: string, a: CreateAutomation): Promise<Automation | null> {
    await sql`
      UPDATE automations SET name=${a.name}, description=${a.description}, is_active=${a.isActive}, trigger_type=${a.triggerType},
        conditions=${JSON.stringify(a.conditions.map(conditionJson))}::jsonb, actions=${JSON.stringify(a.actions.map(actionJson))}::jsonb,
        updated_by=${emptyToNull(actorId)}
      WHERE id=${id}`.execute(this.db);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM automations WHERE id=${id}`.execute(this.db);
  }

  async get(id: string): Promise<Automation | null> {
    const r = await sql<AutomationRow>`${automationSelect} WHERE id=${id}`.execute(this.db);
    return r.rows[0] ? toAutomation(r.rows[0]) : null;
  }

  async list(trigger: string, activeOnly: boolean, limit: number, offset: number): Promise<{ items: Automation[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    if (offset < 0) offset = 0;
    const where = sql`(${trigger}='' OR trigger_type=${trigger}) AND (${activeOnly}=FALSE OR is_active=TRUE)`;
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM automations WHERE ${where}`.execute(this.db);
    const rows = await sql<AutomationRow>`
      ${automationSelect} WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: rows.rows.map(toAutomation), total: count.rows[0]?.n ?? 0 };
  }

  async listActiveByTrigger(trigger: string): Promise<Automation[]> {
    const r = await sql<AutomationRow>`
      ${automationSelect} WHERE is_active=TRUE AND trigger_type=${trigger} ORDER BY created_at ASC`.execute(this.db);
    return r.rows.map(toAutomation);
  }

  async stageBelongsToPipeline(stageId: string, pipelineId: string): Promise<boolean> {
    const r = await sql<{ ok: boolean }>`
      SELECT EXISTS(SELECT 1 FROM pipeline_stages WHERE id=${stageId} AND pipeline_id=${pipelineId} AND is_active=TRUE) AS ok`.execute(this.db);
    return r.rows[0]?.ok ?? false;
  }

  /** The pipeline of an active stage; throws when there is none. */
  async activeStagePipeline(stageId: string): Promise<string> {
    const r = await sql<{ p: string }>`
      SELECT pipeline_id::text AS p FROM pipeline_stages WHERE id=${stageId} AND is_active=TRUE`.execute(this.db);
    if (!r.rows[0]) throw new NoRowsError();
    return r.rows[0].p;
  }

  // ---------------------------------------------------------------- events and jobs

  async claimPendingEvents(workerId: string, limit: number): Promise<ClaimedEvent[]> {
    return this.db.transaction().execute(async (trx) => {
      const r = await sql<Omit<ClaimedEvent, "payload"> & { payload: unknown }>`
        SELECT id::text AS id, event_type AS "eventType", resource_type AS "resourceType", resource_id::text AS "resourceId", payload
        FROM automation_events
        WHERE status='pending'
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`.execute(trx);
      if (r.rows.length === 0) return [];
      const ids = r.rows.map((e) => e.id);
      await sql`
        UPDATE automation_events
        SET status='processing', claimed_at=NOW(), claimed_by=${workerId}, attempts=attempts+1
        WHERE id = ANY(${ids}::uuid[])`.execute(trx);
      return r.rows.map((e) => ({ ...e, payload: isObject(e.payload) ? e.payload : {} }));
    });
  }

  async markEventProcessed(id: string): Promise<void> {
    await sql`UPDATE automation_events SET status='processed', processed_at=NOW(), last_error='' WHERE id=${id}`.execute(this.db);
  }

  async markEventFailed(id: string, message: string): Promise<void> {
    await sql`
      UPDATE automation_events SET status='failed', processed_at=NOW(), last_error=${truncateBytes(message, 2000)} WHERE id=${id}`.execute(this.db);
  }

  async enqueueJob(eventId: string, auto: Automation, resourceType: string, resourceId: string | null, payload: Record<string, unknown>): Promise<void> {
    await sql`
      INSERT INTO automation_jobs (
        id, event_id, automation_id, trigger_type, resource_type, resource_id, payload, status, next_attempt_at
      ) VALUES (${randomUUID()}, ${emptyToNull(eventId)}, ${auto.id}, ${auto.triggerType}, ${resourceType},
        ${emptyToNull(resourceId)}, ${JSON.stringify(payload)}::jsonb, 'pending', NOW())`.execute(this.db);
  }

  /** Jobs as they were before the claim: attempts is the count before this attempt. */
  async claimJobs(workerId: string, limit: number): Promise<Job[]> {
    return this.db.transaction().execute(async (trx) => {
      const r = await sql<JobRow>`
        ${jobSelect}
        WHERE status IN ('pending','failed') AND next_attempt_at <= NOW() AND attempts < max_attempts
        ORDER BY next_attempt_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`.execute(trx);
      if (r.rows.length === 0) return [];
      await sql`
        UPDATE automation_jobs
        SET status='processing', locked_at=NOW(), locked_by=${workerId}, attempts=attempts+1
        WHERE id = ANY(${r.rows.map((j) => j.id)}::uuid[])`.execute(trx);
      return r.rows.map(toJob);
    });
  }

  async completeJob(id: string): Promise<void> {
    await sql`
      UPDATE automation_jobs SET status='succeeded', last_error='', locked_at=NULL, locked_by='' WHERE id=${id}`.execute(this.db);
  }

  async failJob(id: string, message: string, maxAttempts: number, attempts: number): Promise<void> {
    const dead = attempts >= maxAttempts;
    const next = new Date(Date.now() + (dead ? 0 : backoffMs(attempts)));
    await sql`
      UPDATE automation_jobs
      SET status=${dead ? "dead" : "failed"}, last_error=${truncateBytes(message, 2000)}, next_attempt_at=${next}, locked_at=NULL, locked_by=''
      WHERE id=${id}`.execute(this.db);
  }

  /** false when the job is not failed or dead. */
  async retryJob(id: string): Promise<boolean> {
    const r = await sql`
      UPDATE automation_jobs
      SET status='pending', next_attempt_at=NOW(), last_error='', locked_at=NULL, locked_by=''
      WHERE id=${id} AND status IN ('failed','dead')`.execute(this.db);
    return Number(r.numAffectedRows ?? 0) > 0;
  }

  async getJob(id: string): Promise<Job | null> {
    const r = await sql<JobRow>`${jobSelect} WHERE id=${id}`.execute(this.db);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  async listJobs(status: string, limit: number, offset: number): Promise<{ items: Job[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM automation_jobs WHERE (${status}='' OR status=${status})`.execute(this.db);
    const rows = await sql<JobRow>`
      ${jobSelect} WHERE (${status}='' OR status=${status}) ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    return { items: rows.rows.map(toJob), total: count.rows[0]?.n ?? 0 };
  }

  // ---------------------------------------------------------------- runs

  async insertRun(run: Run): Promise<void> {
    await sql`
      INSERT INTO automation_runs (
        id, automation_id, automation_name, job_id, event_id, trigger_type, resource_type, resource_id,
        conditions_json, conditions_matched, actions_json, action_results, status, error_message, finished_at
      ) VALUES (${randomUUID()}, ${emptyToNull(run.automationId)}, ${run.automationName}, ${emptyToNull(run.jobId)},
        ${emptyToNull(run.eventId)}, ${run.triggerType}, ${run.resourceType}, ${emptyToNull(run.resourceId)},
        ${JSON.stringify(run.conditions.map(conditionJson))}::jsonb, ${run.conditionsMatched},
        ${JSON.stringify(run.actions.map(actionJson))}::jsonb, ${JSON.stringify(run.actionResults.map(actionResultJson))}::jsonb,
        ${run.status}, ${run.errorMessage}, ${new Date()})`.execute(this.db);
  }

  async listRuns(automationId: string, status: string, limit: number, offset: number): Promise<{ items: Record<string, unknown>[]; total: number }> {
    if (limit <= 0 || limit > 100) limit = 50;
    const where = sql`(${automationId}='' OR automation_id::text=${automationId}) AND (${status}='' OR status=${status})`;
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM automation_runs WHERE ${where}`.execute(this.db);
    const rows = await sql<{
      id: string;
      automationId: string | null;
      automationName: string;
      jobId: string | null;
      eventId: string | null;
      triggerType: string;
      resourceType: string;
      resourceId: string | null;
      conditions: unknown;
      conditionsMatched: boolean;
      actions: unknown;
      results: unknown;
      status: string;
      errorMessage: string;
      startedAt: Date;
      finishedAt: Date | null;
    }>`
      SELECT id::text AS id, automation_id::text AS "automationId", automation_name AS "automationName", job_id::text AS "jobId",
        event_id::text AS "eventId", trigger_type AS "triggerType", resource_type AS "resourceType", resource_id::text AS "resourceId",
        conditions_json AS conditions, conditions_matched AS "conditionsMatched", actions_json AS actions, action_results AS results,
        status, error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt"
      FROM automation_runs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`.execute(this.db);
    const items = rows.rows.map((r) => ({
      id: r.id,
      automationId: r.automationId,
      automationName: r.automationName,
      jobId: r.jobId,
      eventId: r.eventId,
      triggerType: r.triggerType,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      conditions: decodeConditions(r.conditions).map(conditionJson),
      conditionsMatched: r.conditionsMatched,
      actions: decodeActions(r.actions).map(actionJson),
      actionResults: decodeActionResults(r.results),
      status: r.status,
      errorMessage: r.errorMessage,
      startedAt: rfc3339(r.startedAt),
      ...(r.finishedAt !== null && { finishedAt: rfc3339(r.finishedAt) }),
    }));
    return { items, total: count.rows[0]?.n ?? 0 };
  }

  // ---------------------------------------------------------------- entity context

  /** Facts about the record an event points at, keyed the way conditions and actions read them. */
  async loadEntityContext(resourceType: string, resourceId: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { resourceType, resourceId };
    const now = new Date();
    switch (resourceType) {
      case "lead": {
        const r = await sql<{
          pipelineId: string | null;
          stageId: string | null;
          ownerId: string | null;
          teamId: string | null;
          anzscoId: string | null;
          source: string;
          priority: string;
          lastAct: Date | null;
          createdAt: Date;
          fullName: string;
          email: string;
          nextAct: Date | null;
          status: string;
          archived: boolean;
          updatedAt: Date;
          stageEntered: Date | null;
          slaHours: number | null;
          tags: string[];
          value: number | null;
        }>`
          SELECT l.pipeline_id::text AS "pipelineId", l.stage_id::text AS "stageId", l.owner_user_id::text AS "ownerId",
            l.team_id::text AS "teamId", l.anzsco_id::text AS "anzscoId", l.source, l.priority, l.last_activity_at AS "lastAct",
            l.created_at AS "createdAt", l.full_name AS "fullName", COALESCE(l.email,'') AS email, l.next_activity_at AS "nextAct",
            l.status, l.is_archived AS archived, l.updated_at AS "updatedAt", l.stage_entered_at AS "stageEntered",
            ps.sla_hours AS "slaHours", COALESCE(l.tags,'{}') AS tags, l.potential_value AS value
          FROM leads l
          LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
          WHERE l.id=${resourceId}`.execute(this.db);
        const l = r.rows[0];
        if (!l) throw new NoRowsError();
        Object.assign(out, {
          pipelineId: l.pipelineId ?? "",
          stageId: l.stageId ?? "",
          ownerUserId: l.ownerId ?? "",
          teamId: l.teamId ?? "",
          anzscoId: l.anzscoId ?? "",
          source: l.source,
          priority: l.priority,
          fullName: l.fullName,
          email: l.email,
          status: l.status,
          leadValue: l.value ?? 0,
          inactivityDays: (now.getTime() - (l.lastAct ?? l.createdAt).getTime()) / DAY_MS,
          attention: computeAttention({
            closed: l.archived || ["won", "lost", "converted", "archived", "unqualified"].includes(l.status),
            next: l.nextAct,
            last: l.lastAct,
            anchor: l.stageEntered ?? l.updatedAt,
            createdAt: l.createdAt,
            slaHours: l.slaHours,
            now,
          }),
          tags: l.tags,
        });
        break;
      }
      case "deal": {
        const r = await sql<{
          pipelineId: string | null;
          stageId: string | null;
          ownerId: string | null;
          teamId: string | null;
          customerId: string | null;
          source: string;
          priority: string;
          value: number | null;
          lastAct: Date | null;
          createdAt: Date;
          title: string;
          status: string;
          nextAct: Date | null;
          stageEntered: Date | null;
          slaHours: number | null;
          fullName: string;
          email: string;
        }>`
          SELECT d.pipeline_id::text AS "pipelineId", d.stage_id::text AS "stageId", d.owner_user_id::text AS "ownerId",
            d.team_id::text AS "teamId", d.customer_id::text AS "customerId", d.source, d.priority, d.value,
            d.last_activity_at AS "lastAct", d.created_at AS "createdAt", d.title, d.status, d.next_activity_at AS "nextAct",
            d.stage_entered_at AS "stageEntered", ps.sla_hours AS "slaHours",
            COALESCE(c.full_name,'') AS "fullName", COALESCE(c.email,'') AS email
          FROM deals d
          LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
          LEFT JOIN customers c ON c.id = d.customer_id
          WHERE d.id=${resourceId}`.execute(this.db);
        const d = r.rows[0];
        if (!d) throw new NoRowsError();
        Object.assign(out, {
          pipelineId: d.pipelineId ?? "",
          stageId: d.stageId ?? "",
          ownerUserId: d.ownerId ?? "",
          teamId: d.teamId ?? "",
          customerId: d.customerId ?? "",
          source: d.source,
          priority: d.priority,
          dealTitle: d.title,
          fullName: d.fullName,
          email: d.email,
          dealValue: d.value ?? 0,
          inactivityDays: (now.getTime() - (d.lastAct ?? d.createdAt).getTime()) / DAY_MS,
          attention: computeAttention({
            closed: d.status !== "open",
            next: d.nextAct,
            last: d.lastAct,
            anchor: d.stageEntered ?? d.createdAt,
            createdAt: d.createdAt,
            slaHours: d.slaHours,
            now,
          }),
        });
        break;
      }
      case "customer": {
        const r = await sql<{
          ownerId: string | null;
          teamId: string | null;
          anzscoId: string | null;
          source: string;
          fullName: string;
          email: string;
          nextFollow: Date | null;
          lastContact: Date | null;
          archived: boolean;
          createdAt: Date;
        }>`
          SELECT owner_user_id::text AS "ownerId", team_id::text AS "teamId", anzsco_id::text AS "anzscoId", COALESCE(source,'') AS source,
            full_name AS "fullName", COALESCE(email,'') AS email, next_follow_up_at AS "nextFollow", last_contacted_at AS "lastContact",
            is_archived AS archived, created_at AS "createdAt"
          FROM customers WHERE id=${resourceId}`.execute(this.db);
        const c = r.rows[0];
        if (!c) throw new NoRowsError();
        Object.assign(out, {
          ownerUserId: c.ownerId ?? "",
          teamId: c.teamId ?? "",
          anzscoId: c.anzscoId ?? "",
          source: c.source,
          fullName: c.fullName,
          email: c.email,
          attention: computeAttention({
            closed: c.archived,
            next: c.nextFollow,
            last: c.lastContact,
            anchor: null,
            createdAt: c.createdAt,
            slaHours: null,
            now,
          }),
        });
        break;
      }
      case "activity": {
        const r = await sql<{ leadId: string | null; dealId: string | null; customerId: string | null; ownerId: string | null }>`
          SELECT lead_id::text AS "leadId", deal_id::text AS "dealId", customer_id::text AS "customerId",
            COALESCE(owner_user_id, actor_user_id)::text AS "ownerId"
          FROM activities WHERE id=${resourceId}`.execute(this.db);
        const a = r.rows[0];
        if (!a) throw new NoRowsError();
        Object.assign(out, { leadId: a.leadId ?? "", dealId: a.dealId ?? "", customerId: a.customerId ?? "", ownerUserId: a.ownerId ?? "" });
        const parent = a.leadId !== null ? ["lead", a.leadId] : a.dealId !== null ? ["deal", a.dealId] : null;
        if (parent) {
          // Parent facts fill keys the activity lacks or left blank.
          const ctx = await this.loadEntityContext(parent[0]!, parent[1]!).catch(() => null);
          for (const [k, v] of Object.entries(ctx ?? {})) {
            if (!(k in out) || out[k] === "") out[k] = v;
          }
        }
        break;
      }
      case "document": {
        const r = await sql<{ leadId: string | null; dealId: string | null; customerId: string | null; documentType: string }>`
          SELECT lead_id::text AS "leadId", deal_id::text AS "dealId", customer_id::text AS "customerId",
            COALESCE(NULLIF(category, ''), doc_type, '') AS "documentType"
          FROM documents WHERE id=${resourceId}`.execute(this.db);
        const d = r.rows[0];
        if (!d) throw new NoRowsError();
        Object.assign(out, { leadId: d.leadId ?? "", dealId: d.dealId ?? "", customerId: d.customerId ?? "" });
        const parent = d.leadId !== null ? ["lead", d.leadId] : d.dealId !== null ? ["deal", d.dealId] : null;
        if (parent) {
          // Go overwrites every key here, including resourceType and resourceId.
          const ctx = await this.loadEntityContext(parent[0]!, parent[1]!).catch(() => null);
          Object.assign(out, ctx ?? {});
        }
        out.documentType = d.documentType;
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- synthetic scans

  async findOverdueActivities(limit: number): Promise<string[]> {
    const r = await sql<{ id: string }>`
      SELECT a.id::text AS id
      FROM activities a
      WHERE (a.status='overdue' OR (a.status IN ('upcoming','due') AND a.due_at IS NOT NULL AND a.due_at < NOW()))
        AND NOT EXISTS (
          SELECT 1 FROM automation_events e
          WHERE e.event_type=${Trigger.ActivityOverdue} AND e.resource_id=a.id
            AND e.created_at > NOW() - INTERVAL '12 hours'
        )
      ORDER BY a.due_at ASC NULLS LAST
      LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => x.id);
  }

  /** Open leads untouched for inactivityDays, at most one lead.inactive event per lead per day. */
  async findInactiveLeads(inactivityDays: number, limit: number): Promise<string[]> {
    const r = await sql<{ id: string }>`
      SELECT l.id::text AS id
      FROM leads l
      WHERE l.status IN ('open','inbox','qualified') AND l.is_archived = FALSE
        AND COALESCE(l.last_activity_at, l.created_at) < NOW() - (${String(inactivityDays)} || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM automation_events e
          WHERE e.event_type=${Trigger.LeadInactive} AND e.resource_id=l.id
            AND e.created_at > NOW() - INTERVAL '24 hours'
        )
      ORDER BY COALESCE(l.last_activity_at, l.created_at) ASC
      LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => x.id);
  }

  async findInactiveDeals(inactivityDays: number, limit: number): Promise<string[]> {
    const r = await sql<{ id: string }>`
      SELECT d.id::text AS id
      FROM deals d
      WHERE d.status='open'
        AND COALESCE(d.last_activity_at, d.created_at) < NOW() - (${String(inactivityDays)} || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM automation_events e
          WHERE e.event_type=${Trigger.DealInactive} AND e.resource_id=d.id
            AND e.created_at > NOW() - INTERVAL '24 hours'
        )
      ORDER BY COALESCE(d.last_activity_at, d.created_at) ASC
      LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => x.id);
  }
}
