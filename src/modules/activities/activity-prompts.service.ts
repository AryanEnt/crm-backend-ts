import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import type { Claims } from "../auth/types.js";
import type { LeadStageService, MoveActor } from "../leads/lead-stage.service.js";
import type { PipelinesRepository, Stage } from "../pipelines/pipelines.service.js";
import type { ActivitiesService, LeadStageRef, MutationResult, NextActivityInput } from "./activities.service.js";

/** Answers to "How did it go?" on a due activity. */
export const PromptResult = {
  NoAnswer: "no_answer",
  Contacted: "contacted",
  Qualified: "qualified",
  NotQualified: "not_qualified",
} as const;

export type PromptResult = (typeof PromptResult)[keyof typeof PromptResult];

const RESULTS = new Set<string>(Object.values(PromptResult));

const OUTCOME_LABEL: Record<PromptResult, string> = {
  no_answer: "No answer",
  contacted: "Contacted",
  qualified: "Qualified",
  not_qualified: "Not qualified",
};

/** Older due activities are left to the calendar instead of piling up as prompts. */
export const PROMPT_LOOKBACK_DAYS = 3;
const PROMPT_LIMIT = 10;
export const MAX_SNOOZE_MINUTES = 24 * 60;
const CLOSED_LEAD_STATUSES = ["won", "lost", "converted", "archived"];

export interface ActivityPrompt {
  activityId: string;
  title: string;
  kind: string;
  typeName: string | null;
  dueAt: Date;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  stageName: string | null;
  priority: string;
  source: string;
}

export interface PromptOutcomeInput {
  result: string;
  note?: string | undefined;
  nextActivity?: NextActivityInput | undefined;
}

export interface PromptStageChange {
  moved: boolean;
  stageId: string | null;
  stageName: string | null;
  /** Why the lead stayed put; empty when it moved or no move was asked for. */
  message: string;
}

export interface PromptOutcome {
  activity: MutationResult;
  result: PromptResult;
  stage: PromptStageChange;
  needsNextActivity: boolean;
}

/**
 * Stage an answer moves the lead to, or null to leave it. Contacted and Qualified match stages by
 * name, falling back to the second and third open stage; leads only ever move forward.
 */
export function promptTarget(stages: Stage[], currentStageId: string | null, result: PromptResult): Stage | null {
  const active = stages.filter((s) => s.isActive).sort((a, b) => a.position - b.position);
  const current = active.find((s) => s.id === currentStageId) ?? null;
  if (current && (current.isWon || current.isLost)) return null;
  if (result === PromptResult.NoAnswer) return null;
  if (result === PromptResult.NotQualified) return active.find((s) => s.isLost) ?? null;
  const open = active.filter((s) => !s.isWon && !s.isLost);
  const target = open.find((s) => s.name.trim().toLowerCase() === result) ?? open[result === PromptResult.Contacted ? 1 : 2];
  if (!target) return null;
  if (current && target.position <= current.position) return null;
  return target;
}

/** A readable reason a planned move was refused, e.g. missing stage requirements. */
export function moveProblem(err: AppError): string {
  const d = err.details ?? {};
  const missing = ["missingFields", "missingActivities", "missingDocuments"].flatMap((k) =>
    Array.isArray(d[k]) ? (d[k] as unknown[]).map(String) : [],
  );
  if (missing.length > 0) return `${String(d.stageName ?? "That stage")} needs: ${missing.join(", ")}`;
  return err.message;
}

export class ActivityPromptsService {
  constructor(
    private readonly db: Database,
    private readonly activities: Pick<ActivitiesService, "get" | "update">,
    private readonly leadStages: Pick<LeadStageService, "move">,
    private readonly pipelines: Pick<PipelinesRepository, "get">,
  ) {}

  /** The caller's lead activities whose time has come and that nobody has answered or snoozed. */
  async due(userId: string): Promise<ActivityPrompt[]> {
    const r = await internal("failed to load activity prompts", () =>
      sql<ActivityPrompt>`
        SELECT a.id::text AS "activityId", COALESCE(NULLIF(a.title,''), a.subject) AS "title", a.kind, t.name AS "typeName",
          COALESCE(a.start_at, a.due_at) AS "dueAt",
          l.id::text AS "leadId", l.full_name AS "leadName", l.phone AS "leadPhone", ps.name AS "stageName",
          l.priority, l.source
        FROM activities a
        JOIN leads l ON l.id = a.lead_id
        LEFT JOIN activity_types t ON t.id = a.activity_type_id
        LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
        WHERE a.owner_user_id = ${userId}
          AND a.status IN ('upcoming','due','overdue')
          AND COALESCE(a.start_at, a.due_at) <= NOW()
          AND COALESCE(a.start_at, a.due_at) > NOW() - make_interval(days => ${PROMPT_LOOKBACK_DAYS})
          AND (a.prompt_snoozed_until IS NULL OR a.prompt_snoozed_until <= NOW())
          AND l.is_archived = FALSE
          AND l.status <> ALL(${CLOSED_LEAD_STATUSES}::text[])
        ORDER BY COALESCE(a.start_at, a.due_at) ASC
        LIMIT ${PROMPT_LIMIT}`.execute(this.db),
    );
    return r.rows;
  }

  /** Completes the activity with the answer, then moves the lead forward when the answer calls for it. */
  async outcome(claims: Claims, activityId: string, in_: PromptOutcomeInput, meta: RequestMeta): Promise<PromptOutcome> {
    if (!RESULTS.has(in_.result)) throw AppError.validation("result must be no_answer, contacted, qualified or not_qualified");
    const result = in_.result as PromptResult;
    const { activity: cur } = await this.activities.get(activityId);
    if (cur.leadId === null) throw AppError.validation("activity is not linked to a lead");
    if (cur.status === "completed" || cur.status === "cancelled") throw AppError.validation("activity is already closed");

    const note = (in_.note ?? "").trim();
    const notes = note === "" ? undefined : cur.notes.trim() === "" ? note : `${cur.notes.trim()}\n\n${note}`;
    const next = in_.nextActivity && in_.nextActivity.dueAt.trim() !== "" ? in_.nextActivity : undefined;
    const activity = await this.activities.update(
      claims.userId,
      activityId,
      { status: "completed", outcome: OUTCOME_LABEL[result], notes, clearDueAt: false, nextActivity: next },
      meta,
      { advanceLead: false },
    );
    const stage = await this.advanceLead({ kind: "user", claims }, cur.leadId, result, note, meta);
    const closed = stage.moved && result === PromptResult.NotQualified;
    return { activity, result, stage, needsNextActivity: closed ? false : activity.needsNextActivity };
  }

  async snooze(activityId: string, minutes: number): Promise<{ snoozedUntil: Date }> {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
      throw AppError.validation(`minutes must be between 1 and ${MAX_SNOOZE_MINUTES}`);
    }
    const r = await internal("failed to snooze activity", () =>
      sql<{ snoozedUntil: Date }>`
        UPDATE activities SET prompt_snoozed_until = NOW() + make_interval(mins => ${minutes})
        WHERE id = ${activityId}
        RETURNING prompt_snoozed_until AS "snoozedUntil"`.execute(this.db),
    );
    const row = r.rows[0];
    if (!row) throw AppError.notFound("activity not found");
    return row;
  }

  /**
   * Completing any activity on a lead counts as contact made: a lead before Contacted moves there.
   * Runs as a system move for the user, so it works for anyone allowed to complete the activity.
   */
  async contactMade(actorId: string, leadId: string, meta: RequestMeta): Promise<LeadStageRef | null> {
    const stage = await this.advanceLead({ kind: "automation", actorUserId: actorId }, leadId, PromptResult.Contacted, "", meta);
    return stage.moved && stage.stageId !== null && stage.stageName !== null
      ? { stageId: stage.stageId, stageName: stage.stageName }
      : null;
  }

  private async advanceLead(actor: MoveActor, leadId: string, result: PromptResult, note: string, meta: RequestMeta): Promise<PromptStageChange> {
    const stay = (message: string): PromptStageChange => ({ moved: false, stageId: null, stageName: null, message });
    if (result === PromptResult.NoAnswer) return stay("");
    const r = await internal("failed to load lead", () =>
      sql<{ pipelineId: string | null; stageId: string | null; status: string }>`
        SELECT pipeline_id::text AS "pipelineId", stage_id::text AS "stageId", status FROM leads WHERE id = ${leadId}`.execute(this.db),
    );
    const lead = r.rows[0];
    if (!lead) throw AppError.notFound("lead not found");
    if (lead.pipelineId === null) return stay("This lead isn't in a pipeline yet.");
    if (CLOSED_LEAD_STATUSES.includes(lead.status)) return stay("This lead is already closed.");
    const pipelineId = lead.pipelineId;
    const pipeline = await internal("failed to load pipeline", () => this.pipelines.get(pipelineId));
    const stages = pipeline?.stages ?? [];
    const target = promptTarget(stages, lead.stageId, result);
    if (!target) {
      const current = stages.find((s) => s.id === lead.stageId)?.name;
      return stay(current ? `Lead stays in ${current}.` : "No matching stage in this pipeline.");
    }
    try {
      await this.leadStages.move(
        actor,
        leadId,
        { stageId: target.id, lostReason: result === PromptResult.NotQualified ? note || "Not qualified" : undefined },
        meta,
      );
    } catch (err) {
      if (err instanceof AppError && err.status < 500) return stay(moveProblem(err));
      throw err;
    }
    return { moved: true, stageId: target.id, stageName: target.name, message: "" };
  }
}
