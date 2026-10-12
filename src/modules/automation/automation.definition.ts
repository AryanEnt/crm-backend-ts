import { AppError } from "../../lib/app-error.js";
import { goFloatV, goQuote, goV } from "../../lib/go-fmt.js";
import { goSortKeys } from "../../lib/go-json.js";

export const Trigger = {
  LeadCreated: "lead.created",
  LeadAssigned: "lead.assigned",
  LeadStageChanged: "lead.stage_changed",
  LeadInactive: "lead.inactive",
  ActivityCompleted: "activity.completed",
  ActivityOverdue: "activity.overdue",
  DocumentUploaded: "document.uploaded",
  DealInactive: "deal.inactive",
  CustomerUpdated: "customer.updated",
  DealCreated: "deal.created",
  DealUpdated: "deal.updated",
  DealStageChanged: "deal.stage_changed",
} as const;

export const Cond = {
  Pipeline: "pipeline",
  Stage: "stage",
  Owner: "owner",
  Team: "team",
  Source: "source",
  Anzsco: "anzsco",
  Priority: "priority",
  InactivityDays: "inactivity_days",
  DealValue: "deal_value",
  LeadValue: "lead_value",
  DocumentType: "document_type",
  Attention: "attention",
} as const;

export const ActionType = {
  CreateTask: "create_task",
  AssignUser: "assign_user",
  ChangeStage: "change_stage",
  SendNotification: "send_notification",
  UpdateField: "update_field",
  AddTag: "add_tag",
  CreateActivity: "create_activity",
  SendEmail: "send_email",
} as const;

export const Op = { Equals: "eq", NotEquals: "neq", Gte: "gte", Lte: "lte", In: "in", Contains: "contains" } as const;

/** Payload keys reserved by the engine. */
export const PAYLOAD_SUPPRESS_AUTOMATION = "_suppressAutomation";
export const PAYLOAD_AUTOMATION_DEPTH = "_automationDepth";

const ALLOWED_TRIGGERS: string[] = Object.values(Trigger);
const ALLOWED_FIELDS: string[] = Object.values(Cond);
const ALLOWED_ACTIONS: string[] = Object.values(ActionType);
const ALLOWED_OPS: string[] = Object.values(Op);
const UPDATABLE_FIELDS = ["priority", "source", "notes", "status"];

export interface Condition {
  field: string;
  operator: string;
  value: unknown;
}

export interface Action {
  type: string;
  /** null mirrors a Go nil map. */
  params: Record<string, unknown> | null;
}

export interface ActionResult {
  type: string;
  /** succeeded | failed | skipped */
  status: string;
  detail?: string;
  error?: string;
  payload?: Record<string, unknown>;
}

/** Go fmt "%v" of a non-string param (asString in the Go engine). */
export function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : goV(v);
}

// ---------------------------------------------------------------- JSON shapes (Go struct order, omitempty)

export const conditionJson = (c: Condition) => ({ field: c.field, operator: c.operator, value: goSortKeys(c.value ?? null) });

export const actionJson = (a: Action) => ({ type: a.type, params: a.params === null ? null : goSortKeys(a.params) });

export function actionResultJson(r: ActionResult): Record<string, unknown> {
  const out: Record<string, unknown> = { type: r.type, status: r.status };
  if (r.detail) out.detail = r.detail;
  if (r.error) out.error = r.error;
  if (r.payload && Object.keys(r.payload).length > 0) out.payload = goSortKeys(r.payload);
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** jsonb decoded into []Condition: non-arrays are empty, mistyped members become zero values. */
export function decodeConditions(v: unknown): Condition[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = isObject(x) ? x : {};
    return {
      field: typeof o.field === "string" ? o.field : "",
      operator: typeof o.operator === "string" ? o.operator : "",
      value: o.value ?? null,
    };
  });
}

export function decodeActions(v: unknown): Action[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = isObject(x) ? x : {};
    return { type: typeof o.type === "string" ? o.type : "", params: isObject(o.params) ? o.params : null };
  });
}

export function decodeActionResults(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = isObject(x) ? x : {};
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return actionResultJson({
      type: str("type"),
      status: str("status"),
      detail: str("detail"),
      error: str("error"),
      ...(isObject(o.payload) && { payload: o.payload }),
    });
  });
}

// ---------------------------------------------------------------- validation

export function validateDefinition(trigger: string, conditions: Condition[], actions: Action[]): void {
  if (!ALLOWED_TRIGGERS.includes(trigger)) throw AppError.validation(`unsupported WHEN trigger: ${trigger}`);
  if (actions.length === 0) throw AppError.validation("at least one THEN action is required");
  conditions.forEach((c, i) => {
    if (!ALLOWED_FIELDS.includes(c.field)) {
      throw AppError.validation(`condition ${i + 1}: unsupported IF field ${goQuote(c.field)}`);
    }
    const op = c.operator || Op.Equals;
    if (!ALLOWED_OPS.includes(op)) throw AppError.validation(`condition ${i + 1}: unsupported operator ${goQuote(op)}`);
    if (c.value === null || c.value === undefined) throw AppError.validation(`condition ${i + 1}: value is required`);
  });
  actions.forEach((a, i) => {
    if (!ALLOWED_ACTIONS.includes(a.type)) {
      throw AppError.validation(`action ${i + 1}: unsupported THEN type ${goQuote(a.type)}`);
    }
    const problem = actionProblem(a.type, a.params ?? {});
    if (problem) throw AppError.validation(`action ${i + 1}: ${problem}`);
  });
}

function actionProblem(type: string, p: Record<string, unknown>): string {
  const blank = (k: string) => asString(p[k]).trim() === "";
  switch (type) {
    case ActionType.CreateTask:
      return blank("title") ? "create_task requires title" : "";
    case ActionType.AssignUser:
      return blank("ownerUserId") ? "assign_user requires ownerUserId" : "";
    case ActionType.ChangeStage:
      return blank("stageId") ? "change_stage requires stageId" : "";
    case ActionType.SendNotification:
      return blank("message") ? "send_notification requires message" : "";
    case ActionType.UpdateField: {
      const field = asString(p.field).trim();
      if (field === "") return "update_field requires field";
      return UPDATABLE_FIELDS.includes(field) ? "" : `update_field field ${goQuote(field)} is not allowed`;
    }
    case ActionType.AddTag:
      return blank("tag") ? "add_tag requires tag" : "";
    case ActionType.CreateActivity:
      return blank("title") && blank("subject") ? "create_activity requires title" : "";
    case ActionType.SendEmail:
      return blank("templateId") ? "send_email requires templateId" : "";
    default:
      return "";
  }
}

/** Checks the stage exists on the record's pipeline; returns the problem, or "" when allowed. */
export async function changeStageProblem(
  entityPipelineId: string,
  actionPipelineId: string,
  stageId: string,
  belongs: (stageId: string, pipelineId: string) => Promise<boolean>,
): Promise<string> {
  const pipe = actionPipelineId.trim() || entityPipelineId.trim();
  if (pipe === "") return "cannot change stage: entity has no pipeline";
  if (actionPipelineId !== "" && entityPipelineId !== "" && actionPipelineId !== entityPipelineId) {
    return "cannot change stage: target pipeline does not match the record's pipeline";
  }
  if (!(await belongs(stageId, pipe))) return "impossible stage transition: stage is not an active stage on this pipeline";
  return "";
}

// ---------------------------------------------------------------- matching

const CONTEXT_KEYS: Record<string, string> = {
  [Cond.Pipeline]: "pipelineId",
  [Cond.Stage]: "stageId",
  [Cond.Owner]: "ownerUserId",
  [Cond.Team]: "teamId",
  [Cond.Source]: "source",
  [Cond.Anzsco]: "anzscoId",
  [Cond.Priority]: "priority",
  [Cond.InactivityDays]: "inactivityDays",
  [Cond.DealValue]: "dealValue",
  [Cond.LeadValue]: "leadValue",
  [Cond.DocumentType]: "documentType",
  [Cond.Attention]: "attention",
};

/** Go stringify: whole floats print as integers. */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    return Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? BigInt(v).toString() : goFloatV(v);
  }
  return goV(v);
}

/** Go fmt.Sscanf("%f"): the leading number of a string, else 0. */
function toFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(v);
    return m ? Number(m[0]) : 0;
  }
  return 0;
}

const toList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

export function matchConditions(conditions: Condition[], ctx: Record<string, unknown>): { matched: boolean; detail: string } {
  if (conditions.length === 0) return { matched: true, detail: "no conditions" };
  for (const c of conditions) {
    const detail = mismatch(c, ctx);
    if (detail !== null) return { matched: false, detail };
  }
  return { matched: true, detail: "all conditions matched" };
}

/** null when the condition holds, else Go's explanation. */
function mismatch(c: Condition, ctx: Record<string, unknown>): string | null {
  const actual = ctx[CONTEXT_KEYS[c.field] ?? c.field];
  const [f, a, v] = [c.field, goV(actual), goV(c.value)];
  switch (c.operator || Op.Equals) {
    case Op.Equals:
      return stringify(actual) === stringify(c.value) ? null : `${f} is ${a}, expected ${v}`;
    case Op.NotEquals:
      return stringify(actual) !== stringify(c.value) ? null : `${f} is ${a}, excluded value`;
    case Op.Gte:
      return toFloat(actual) >= toFloat(c.value) ? null : `${f}=${a} is below ${v}`;
    case Op.Lte:
      return toFloat(actual) <= toFloat(c.value) ? null : `${f}=${a} is above ${v}`;
    case Op.In:
      return toList(c.value).some((x) => stringify(actual) === stringify(x)) ? null : `${f}=${a} not in list`;
    case Op.Contains:
      return stringify(actual).toLowerCase().includes(stringify(c.value).toLowerCase()) ? null : `${f} does not contain ${v}`;
    default:
      return "unknown operator";
  }
}

// ---------------------------------------------------------------- builder catalog

const item = (code: string, label: string, description?: string) => (description ? { code, label, description } : { code, label });

/** Builder options. Customer and deal triggers stay valid for existing automations but are no longer offered. */
export const CATALOG = {
  triggers: [
    item(Trigger.LeadCreated, "Lead created", "When a new lead is added"),
    item(Trigger.LeadAssigned, "Lead assigned", "When a lead's owner changes"),
    item(Trigger.LeadStageChanged, "Lead stage changed", "When a lead moves stage"),
    item(Trigger.LeadInactive, "Lead inactive", "When an open lead has no activity for 14 days"),
    item(Trigger.ActivityCompleted, "Activity completed", "When an activity is marked complete"),
    item(Trigger.ActivityOverdue, "Activity overdue", "When a follow-up becomes overdue"),
    item(Trigger.DocumentUploaded, "Document uploaded", "When a document file is uploaded"),
  ],
  conditions: [
    item(Cond.Pipeline, "Pipeline"),
    item(Cond.Stage, "Stage"),
    item(Cond.Owner, "Owner"),
    item(Cond.Team, "Team"),
    item(Cond.Source, "Source"),
    item(Cond.Anzsco, "ANZSCO"),
    item(Cond.Priority, "Priority"),
    item(Cond.InactivityDays, "Inactivity days"),
    item(Cond.LeadValue, "Lead value"),
    item(Cond.DocumentType, "Document type", "Category of the uploaded document"),
    item(Cond.Attention, "Attention", "no_next_activity, overdue_next, over_sla, attention_needed, or no_recent_activity"),
  ],
  actions: [
    item(ActionType.CreateTask, "Create task"),
    item(ActionType.AssignUser, "Assign user"),
    item(ActionType.ChangeStage, "Change stage"),
    item(ActionType.SendNotification, "Send notification"),
    item(ActionType.UpdateField, "Update field"),
    item(ActionType.AddTag, "Add tag"),
    item(ActionType.CreateActivity, "Create activity"),
    item(ActionType.SendEmail, "Send templated email", "Queue the owner's mailbox to send an email template"),
  ],
  operators: [
    item(Op.Equals, "is"),
    item(Op.NotEquals, "is not"),
    item(Op.Gte, "at least"),
    item(Op.Lte, "at most"),
    item(Op.In, "is one of"),
    item(Op.Contains, "contains"),
  ],
};
