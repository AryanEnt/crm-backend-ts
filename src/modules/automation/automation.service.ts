import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import { optionalString, str } from "../../lib/validate.js";
import type { AuditService } from "../audit/audit.service.js";
import {
  ActionType,
  asString,
  CATALOG,
  validateDefinition,
  type Action,
  type Condition,
} from "./automation.definition.js";
import { automationJson, jobJson, type Automation, type AutomationRepository } from "./automation.repository.js";

// A null array element decodes to the zero struct in Go.
const conditionSchema = z.strictObject({ field: str(), operator: str(), value: z.unknown().optional() }).nullable();
const actionSchema = z.strictObject({ type: str(), params: z.record(z.string(), z.unknown()).nullish() }).nullable();

const toConditions = (v: z.output<typeof conditionSchema>[] | null | undefined): Condition[] | undefined =>
  v?.map((c) => ({ field: c?.field ?? "", operator: c?.operator ?? "", value: c?.value ?? null }));
const toActions = (v: z.output<typeof actionSchema>[] | null | undefined): Action[] | undefined =>
  v?.map((a) => ({ type: a?.type ?? "", params: a?.params ?? null }));

export const createSchema = z.strictObject({
  name: str(),
  description: str(),
  isActive: z.boolean().nullish(),
  triggerType: str(),
  conditions: z.array(conditionSchema).nullish(),
  actions: z.array(actionSchema).nullish(),
});

export const updateSchema = z.strictObject({
  name: optionalString(),
  description: optionalString(),
  isActive: z.boolean().nullish(),
  triggerType: optionalString(),
  conditions: z.array(conditionSchema).nullish(),
  actions: z.array(actionSchema).nullish(),
});

export type CreateInput = z.output<typeof createSchema>;
export type UpdateInput = z.output<typeof updateSchema>;

export class AutomationService {
  constructor(
    private readonly repo: AutomationRepository,
    private readonly audit: AuditService,
    private readonly wake: () => void = () => undefined,
  ) {}

  catalog() {
    return CATALOG;
  }

  async list(trigger: string, activeOnly: boolean, limit: number, offset: number) {
    const { items, total } = await internal("failed to list automations", () => this.repo.list(trigger, activeOnly, limit, offset));
    return { items: items.map(automationJson), total };
  }

  async get(id: string): Promise<Record<string, unknown>> {
    return automationJson(await this.load(id));
  }

  private async load(id: string): Promise<Automation> {
    const a = await internal("failed to load automation", () => this.repo.get(id));
    if (!a) throw AppError.notFound("automation not found");
    return a;
  }

  async create(actorId: string, in_: CreateInput, meta: RequestMeta) {
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    const conditions = toConditions(in_.conditions) ?? [];
    const actions = toActions(in_.actions) ?? [];
    validateDefinition(in_.triggerType, conditions, actions);
    await this.validateStageActions(actions);
    const a = await internal("failed to create automation", async () =>
      this.repo.create(actorId, {
        name: in_.name,
        description: in_.description,
        isActive: in_.isActive ?? true,
        triggerType: in_.triggerType,
        conditions,
        actions,
      }),
    );
    if (!a) throw AppError.internal("failed to create automation");
    await this.audit.record(actorId, "automation.created", "automation", a.id, { name: a.name, triggerType: a.triggerType }, meta);
    return automationJson(a);
  }

  async update(actorId: string, id: string, in_: UpdateInput, meta: RequestMeta) {
    const current = await this.load(id);
    const next = {
      name: in_.name != null ? in_.name.trim() : current.name,
      description: in_.description != null ? in_.description.trim() : current.description,
      isActive: in_.isActive ?? current.isActive,
      triggerType: in_.triggerType ?? current.triggerType,
      conditions: toConditions(in_.conditions) ?? current.conditions,
      actions: toActions(in_.actions) ?? current.actions,
    };
    validateDefinition(next.triggerType, next.conditions, next.actions);
    await this.validateStageActions(next.actions);
    const a = await internal("failed to update automation", () => this.repo.update(actorId, id, next));
    if (!a) throw AppError.internal("failed to update automation");
    await this.audit.record(actorId, "automation.updated", "automation", id, { name: a.name, isActive: a.isActive }, meta);
    return automationJson(a);
  }

  async delete(actorId: string, id: string, meta: RequestMeta): Promise<void> {
    await this.load(id);
    await internal("failed to delete automation", () => this.repo.delete(id));
    await this.audit.record(actorId, "automation.deleted", "automation", id, null, meta);
  }

  listRuns(automationId: string, status: string, limit: number, offset: number) {
    return internal("failed to list automation runs", () => this.repo.listRuns(automationId, status, limit, offset));
  }

  async listJobs(status: string, limit: number, offset: number) {
    const { items, total } = await internal("failed to list automation jobs", () => this.repo.listJobs(status, limit, offset));
    return { items: items.map(jobJson), total };
  }

  async retryJob(actorId: string, id: string, meta: RequestMeta) {
    const job = await internal("failed to load job", () => this.repo.getJob(id));
    if (!job) throw AppError.notFound("job not found");
    const ok = await this.repo.retryJob(id).catch(() => false);
    if (!ok) throw AppError.validation("job cannot be retried");
    await this.audit.record(actorId, "automation.job_retry", "automation_job", id, null, meta);
    this.wake();
    const after = await this.repo.getJob(id);
    return after ? jobJson(after) : null;
  }

  /** change_stage targets must be active stages (on the given pipeline, when one is set). */
  private async validateStageActions(actions: Action[]): Promise<void> {
    for (const a of actions) {
      if (a.type !== ActionType.ChangeStage) continue;
      const stageId = asString(a.params?.stageId);
      const pipelineId = asString(a.params?.pipelineId);
      if (pipelineId === "") {
        const pipe = await this.repo.activeStagePipeline(stageId).catch(() => "");
        if (pipe === "") throw AppError.validation("impossible stage transition: stage not found or inactive");
        continue;
      }
      const ok = await internal("failed to validate stage", () => this.repo.stageBelongsToPipeline(stageId, pipelineId));
      if (!ok) throw AppError.validation("impossible stage transition: stage is not an active stage on the selected pipeline");
    }
  }
}