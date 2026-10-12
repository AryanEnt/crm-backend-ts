import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { truncateBytes } from "../../lib/go-strings.js";
import { pgxMessage } from "../../lib/pgx.js";
import type { AuditService } from "../audit/audit.service.js";
import { LeadStageService } from "../leads/lead-stage.service.js";
import { PipelinesRepository } from "../pipelines/pipelines.service.js";
import { ActionType, asString, changeStageProblem, type Action, type ActionResult } from "./automation.definition.js";
import type { Automation, AutomationRepository } from "./automation.repository.js";

type Ctx = Record<string, unknown>;

const WORKER_META = { ip: "", userAgent: "automation-worker" };
const HOUR_MS = 3_600_000;

/** Go's regexp \s is ASCII whitespace only. */
const TEMPLATE_VAR = /\{\{[\t\n\f\r ]*([a-zA-Z0-9_]+)[\t\n\f\r ]*\}\}/g;

const failed = (type: string, error: string): ActionResult => ({ type, status: "failed", error });
const skipped = (type: string, detail: string): ActionResult => ({ type, status: "skipped", detail });
const emptyToNull = (s: string) => (s.trim() === "" ? null : s);

function toFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(v);
    return m ? Number(m[0]) : 0;
  }
  return 0;
}

/** The lead / deal / customer an action on this resource should link to. */
function resolveLinks(resourceType: string, resourceId: string, ctx: Ctx): { leadId: string; dealId: string; customerId: string } {
  switch (resourceType) {
    case "lead":
      return { leadId: resourceId, dealId: "", customerId: "" };
    case "deal":
      return { leadId: "", dealId: resourceId, customerId: asString(ctx.customerId) };
    case "customer":
      return { leadId: "", dealId: "", customerId: resourceId };
    case "activity":
    case "document":
      return { leadId: asString(ctx.leadId), dealId: asString(ctx.dealId), customerId: asString(ctx.customerId) };
    default:
      return { leadId: "", dealId: "", customerId: "" };
  }
}

export function applyTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(TEMPLATE_VAR, (m, name: string) => (Object.hasOwn(vars, name) && vars[name]) || m);
}

/** Tags become spaces, then whitespace runs collapse (Go strings.Fields: unicode.IsSpace). */
export const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .split(/(?:[^\S\ufeff]|\u0085)+/)
    .filter(Boolean)
    .join(" ");

/** Applies THEN actions with SQL. Side effects are audited and never emit automation events. */
export class AutomationExecutor {
  private readonly leadStages: Pick<LeadStageService, "move">;

  constructor(
    private readonly db: Database,
    private readonly repo: AutomationRepository,
    private readonly audit: AuditService,
    leadStages?: Pick<LeadStageService, "move">,
  ) {
    this.leadStages = leadStages ?? new LeadStageService(db, new PipelinesRepository(db), null);
  }

  /** All results, plus the first failure as "type: error". */
  async execute(auto: Automation, ctx: Ctx, resourceType: string, resourceId: string): Promise<{ results: ActionResult[]; error: string }> {
    const results: ActionResult[] = [];
    let error = "";
    for (const action of auto.actions) {
      const res = await this.run(auto, action, ctx, resourceType, resourceId);
      results.push(res);
      if (res.status === "failed" && error === "") error = `${res.type}: ${res.error ?? ""}`;
    }
    return { results, error };
  }

  private async run(auto: Automation, action: Action, ctx: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const p = action.params ?? {};
    try {
      switch (action.type) {
        case ActionType.CreateTask:
          return await this.createTask(auto, p, ctx, resourceType, resourceId);
        case ActionType.AssignUser:
          return await this.assignUser(auto, p, resourceType, resourceId);
        case ActionType.ChangeStage:
          return await this.changeStage(auto, p, ctx, resourceType, resourceId);
        case ActionType.SendNotification:
          return await this.sendNotification(auto, p, resourceType, resourceId);
        case ActionType.UpdateField:
          return await this.updateField(auto, p, resourceType, resourceId);
        case ActionType.AddTag:
          return await this.addTag(auto, p, resourceType, resourceId);
        case ActionType.CreateActivity:
          return await this.createActivity(auto, p, ctx, resourceType, resourceId);
        case ActionType.SendEmail:
          return await this.sendEmail(auto, p, ctx, resourceType, resourceId);
        default:
          return failed(action.type, "unsupported action");
      }
    } catch (err) {
      return failed(action.type, pgxMessage(err));
    }
  }

  private record(action: string, resourceType: string, resourceId: string, meta: Record<string, unknown>): Promise<void> {
    return this.audit.record(null, action, resourceType, resourceId, meta, WORKER_META);
  }

  private async createTask(auto: Automation, p: Ctx, ctx: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const title = asString(p.title).trim();
    if (title === "") return failed(ActionType.CreateTask, "title required");
    // time.Duration(hours) truncates to whole hours.
    const dueHours = toFloat(p.dueInHours);
    const due = dueHours > 0 ? new Date(Date.now() + Math.trunc(dueHours) * HOUR_MS) : null;
    const owner = asString(p.ownerUserId).trim() || asString(ctx.ownerUserId);
    const id = randomUUID();
    const links = resolveLinks(resourceType, resourceId, ctx);
    const o = emptyToNull(owner);
    await sql`
      INSERT INTO activities (
        id, kind, subject, title, body, status, due_at, owner_user_id, actor_user_id,
        lead_id, deal_id, customer_id, priority, created_by_user_id
      ) VALUES (
        ${id}, 'task', ${title}, ${title}, ${`Created by automation: ${auto.name}`}, 'upcoming', ${due}, ${o}, ${o},
        ${emptyToNull(links.leadId)}, ${emptyToNull(links.dealId)}, ${emptyToNull(links.customerId)}, 'medium', ${o}
      )`.execute(this.db);
    await this.record(ActionType.CreateTask, "activity", id, { automationId: auto.id, title });
    return { type: ActionType.CreateTask, status: "succeeded", detail: "Task created", payload: { activityId: id } };
  }

  private async assignUser(auto: Automation, p: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const owner = asString(p.ownerUserId).trim();
    if (owner === "") return failed(ActionType.AssignUser, "ownerUserId required");
    switch (resourceType) {
      case "lead":
        await sql`UPDATE leads SET owner_user_id=${owner} WHERE id=${resourceId}`.execute(this.db);
        break;
      case "deal":
        await sql`UPDATE deals SET owner_user_id=${owner} WHERE id=${resourceId}`.execute(this.db);
        break;
      case "customer":
        await sql`UPDATE customers SET owner_user_id=${owner} WHERE id=${resourceId}`.execute(this.db);
        break;
      case "activity":
      case "document":
        return skipped(ActionType.AssignUser, "assign_user applies to lead, deal, or customer");
      default:
        return failed(ActionType.AssignUser, "unsupported resource");
    }
    await this.record("automation.assign_user", resourceType, resourceId, { automationId: auto.id, ownerUserId: owner });
    return { type: ActionType.AssignUser, status: "succeeded", detail: "Owner assigned", payload: { ownerUserId: owner } };
  }

  private async changeStage(auto: Automation, p: Ctx, ctx: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const stageId = asString(p.stageId).trim();
    const pipelineId = asString(p.pipelineId).trim();
    const entityPipe = asString(ctx.pipelineId);
    const problem = await changeStageProblem(entityPipe, pipelineId, stageId, (s, pl) => this.repo.stageBelongsToPipeline(s, pl));
    if (problem) return failed(ActionType.ChangeStage, problem);
    const pipe = pipelineId || entityPipe;
    switch (resourceType) {
      case "lead": {
        // Same rules as a user move: requirements, lost reason, no reopening closed leads.
        const lostReason = asString(p.lostReason).trim() || `Automation: ${auto.name}`;
        try {
          await this.leadStages.move({ kind: "automation", actorUserId: null }, resourceId, { stageId, pipelineId: pipe, lostReason }, WORKER_META);
        } catch (err) {
          if (err instanceof AppError && err.status < 500) return failed(ActionType.ChangeStage, err.message);
          throw err;
        }
        break;
      }
      case "deal":
        await sql`
          UPDATE deals SET stage_id=${stageId}, pipeline_id=COALESCE(NULLIF(${pipe},'')::uuid, pipeline_id), stage_entered_at=NOW()
          WHERE id=${resourceId}`.execute(this.db);
        break;
      default:
        return skipped(ActionType.ChangeStage, "change_stage applies to lead or deal");
    }
    await this.record("automation.change_stage", resourceType, resourceId, { automationId: auto.id, stageId, pipelineId: pipe });
    return { type: ActionType.ChangeStage, status: "succeeded", detail: "Stage updated", payload: { stageId } };
  }

  private async sendNotification(auto: Automation, p: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const message = asString(p.message).trim();
    const userId = asString(p.userId).trim();
    const title = asString(p.title).trim() || `Automation: ${auto.name}`;
    // Recorded in the audit log for delivery workers; there is no notifications table yet.
    await this.record("automation.notification", resourceType, resourceId, {
      automationId: auto.id,
      title,
      message,
      userId,
      channel: asString(p.channel),
    });
    return {
      type: ActionType.SendNotification,
      status: "succeeded",
      detail: "Notification recorded for delivery workers",
      payload: { title, message, userId },
    };
  }

  private async updateField(auto: Automation, p: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const field = asString(p.field).trim();
    const value = asString(p.value);
    if (resourceType !== "lead" && resourceType !== "deal") return skipped(ActionType.UpdateField, "update_field applies to lead or deal");
    if (!["priority", "source", "notes", "status"].includes(field)) return failed(ActionType.UpdateField, "field not allowed");
    if (resourceType === "lead" && field === "status" && ["won", "lost", "converted"].includes(value.trim())) {
      return failed(ActionType.UpdateField, "use change_stage to close a lead as Won or Lost");
    }
    await sql`UPDATE ${sql.table(resourceType === "lead" ? "leads" : "deals")} SET ${sql.ref(field)}=${value} WHERE id=${resourceId}`.execute(this.db);
    await this.record("automation.update_field", resourceType, resourceId, { automationId: auto.id, field, value });
    return { type: ActionType.UpdateField, status: "succeeded", detail: "Field updated", payload: { field } };
  }

  private async addTag(auto: Automation, p: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const tag = asString(p.tag).trim();
    if (tag === "") return failed(ActionType.AddTag, "tag required");
    if (resourceType !== "lead") return skipped(ActionType.AddTag, "add_tag applies to leads");
    await sql`
      UPDATE leads SET tags = (
        SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY[${tag}]::text[]))
      ) WHERE id=${resourceId}`.execute(this.db);
    await this.record("automation.add_tag", resourceType, resourceId, { automationId: auto.id, tag });
    return { type: ActionType.AddTag, status: "succeeded", detail: "Tag added", payload: { tag } };
  }

  private async createActivity(auto: Automation, p: Ctx, ctx: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const title = asString(p.title).trim() || asString(p.subject).trim();
    const kind = asString(p.kind).trim() || "note";
    const body = asString(p.body);
    const id = randomUUID();
    const links = resolveLinks(resourceType, resourceId, ctx);
    const o = emptyToNull(asString(p.ownerUserId) || asString(ctx.ownerUserId));
    await sql`
      INSERT INTO activities (
        id, kind, subject, title, body, status, owner_user_id, actor_user_id,
        lead_id, deal_id, customer_id, created_by_user_id
      ) VALUES (${id}, ${kind}, ${title}, ${title}, ${`${body}\n\n(via automation: ${auto.name})`}, 'completed', ${o}, ${o},
        ${emptyToNull(links.leadId)}, ${emptyToNull(links.dealId)}, ${emptyToNull(links.customerId)}, ${o})`.execute(this.db);
    await this.record("automation.create_activity", "activity", id, { automationId: auto.id, kind });
    return { type: ActionType.CreateActivity, status: "succeeded", detail: "Activity created", payload: { activityId: id } };
  }

  private async sendEmail(auto: Automation, p: Ctx, ctx: Ctx, resourceType: string, resourceId: string): Promise<ActionResult> {
    const type = ActionType.SendEmail;
    const templateId = asString(p.templateId).trim();
    if (templateId === "") return failed(type, "templateId required");
    const tpl = await sql<{ subject: string; body: string }>`
      SELECT subject, body_html AS body FROM email_templates WHERE id=${templateId} AND is_active=TRUE`
      .execute(this.db)
      .then((r) => r.rows[0], () => undefined);
    if (!tpl) return failed(type, "email template not found");
    const to = asString(ctx.email).trim();
    if (to === "") return failed(type, "record has no email address");
    const owner = asString(ctx.ownerUserId).trim();
    if (owner === "") return failed(type, "record has no owner to send from");
    const account = await sql<{ id: string; address: string; name: string }>`
      SELECT id::text AS id, email_address AS address, display_name AS name
      FROM email_accounts
      WHERE user_id=${owner} AND connection_status='connected' AND sending_enabled=TRUE
      ORDER BY updated_at DESC
      LIMIT 1`
      .execute(this.db)
      .then((r) => r.rows[0], () => undefined);
    if (!account) return failed(type, "owner has no connected mailbox");

    const vars = await this.templateVars(ctx);
    const subject = applyTemplate(tpl.subject, vars);
    const body = applyTemplate(tpl.body, vars);
    if (new RegExp(TEMPLATE_VAR.source).test(subject + body)) return failed(type, "template has unresolved variables");

    const links = resolveLinks(resourceType, resourceId, ctx);
    const threadId = randomUUID();
    const now = new Date();
    const snippet = truncateBytes(subject, 180);
    await sql`
      INSERT INTO email_threads (
        id, account_id, owner_user_id, provider_thread_id, lead_id, customer_id, deal_id,
        participants, subject, last_message_at, last_message_preview, message_count, match_status
      ) VALUES (${threadId}, ${account.id}, ${owner}, ${`automation-${threadId}`}, ${emptyToNull(links.leadId)},
        ${emptyToNull(links.customerId)}, ${emptyToNull(links.dealId)}, ${[to]}, ${subject}, ${now}, ${snippet}, 1, 'matched')`.execute(this.db);
    const msgId = randomUUID();
    await sql`
      INSERT INTO email_messages (
        id, thread_id, account_id, owner_user_id, direction, from_address, from_name,
        to_addresses, subject, body_html, body_text, snippet, scheduled_at, status
      ) VALUES (${msgId}, ${threadId}, ${account.id}, ${owner}, 'outbound', ${account.address}, ${account.name},
        ${[to]}, ${subject}, ${body}, ${stripHtml(body)}, ${snippet}, ${now}, 'scheduled')`.execute(this.db);
    await this.record("automation.send_email", resourceType, resourceId, { automationId: auto.id, templateId, messageId: msgId, to });
    return { type, status: "succeeded", detail: "Email queued", payload: { messageId: msgId } };
  }

  private async templateVars(ctx: Ctx): Promise<Record<string, string>> {
    const vars: Record<string, string> = {
      full_name: asString(ctx.fullName),
      email: asString(ctx.email),
      deal_title: asString(ctx.dealTitle),
    };
    let id = asString(ctx.customerId);
    let table = "customers";
    if (id === "") {
      id = asString(ctx.resourceType) === "lead" ? asString(ctx.resourceId) : "";
      table = "leads";
    }
    if (id === "") return vars;
    const row = await sql<{ fullName: string | null; email: string | null; phone: string | null; employer: string | null; ownerName: string | null }>`
      SELECT e.full_name AS "fullName", e.email, e.phone, e.employer, u.full_name AS "ownerName"
      FROM ${sql.table(table)} e
      LEFT JOIN users u ON u.id = e.owner_user_id
      WHERE e.id=${id}`
      .execute(this.db)
      .then((r) => r.rows[0], () => undefined);
    if (!row) return vars;
    const name = row.fullName ?? "";
    const space = name.indexOf(" ");
    return {
      ...vars,
      full_name: name,
      first_name: space > 0 ? name.slice(0, space) : name,
      last_name: space > 0 ? name.slice(space + 1).trim() : "",
      email: row.email ?? "",
      phone: row.phone ?? "",
      company_name: row.employer ?? "",
      lead_owner: row.ownerName ?? "",
    };
  }
}
