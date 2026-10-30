import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { internal, type RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";
import { AutomationEvent, type AutomationEmitter } from "../automation/emitter.js";

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  probability: number;
  visualAccent: string;
  requiredFields: string[];
  requiredActivities: string[];
  requiredDocuments: string[];
  slaHours: number | null;
  isWon: boolean;
  isLost: boolean;
  isActive: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  kind: string;
  isDefault: boolean;
  isActive: boolean;
  stages: Stage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePipelineInput {
  name: string;
  description: string;
  kind: string;
  isDefault: boolean;
  isActive?: boolean | undefined;
}

export interface UpdatePipelineInput {
  name?: string | undefined;
  description?: string | undefined;
  kind?: string | undefined;
  isDefault?: boolean | undefined;
  isActive?: boolean | undefined;
}

export interface CreateStageInput {
  name: string;
  position?: number | undefined;
  probability?: number | undefined;
  visualAccent: string;
  requiredFields?: string[] | undefined;
  requiredActivities?: string[] | undefined;
  requiredDocuments?: string[] | undefined;
  slaHours?: number | undefined;
  isWon: boolean;
  isLost: boolean;
  isActive?: boolean | undefined;
}

export interface UpdateStageInput {
  name?: string | undefined;
  position?: number | undefined;
  probability?: number | undefined;
  visualAccent?: string | undefined;
  requiredFields?: string[] | undefined;
  requiredActivities?: string[] | undefined;
  requiredDocuments?: string[] | undefined;
  slaHours?: number | undefined;
  clearSla: boolean;
  isWon?: boolean | undefined;
  isLost?: boolean | undefined;
  isActive?: boolean | undefined;
}

type PipelineRow = Omit<Pipeline, "stages">;

const pipelineColumns = sql`id::text AS "id", name, description, kind, is_default AS "isDefault", is_active AS "isActive",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const stageColumns = sql`id::text AS "id", pipeline_id::text AS "pipelineId", name, position, probability,
  visual_accent AS "visualAccent", required_fields AS "requiredFields", required_activities AS "requiredActivities",
  required_documents AS "requiredDocuments", sla_hours AS "slaHours", is_won AS "isWon", is_lost AS "isLost",
  is_active AS "isActive"`;

/**
 * Keeps a single won and a single lost stage per pipeline: marking a deal won or
 * lost moves it to that one stage.
 */
async function clearOtherOutcomeStages(
  tx: Database,
  pipelineId: string,
  stageId: string,
  isWon: boolean,
  isLost: boolean,
): Promise<void> {
  if (isWon) {
    await sql`UPDATE pipeline_stages SET is_won=FALSE WHERE pipeline_id=${pipelineId} AND id<>${stageId} AND is_won`.execute(tx);
  }
  if (isLost) {
    await sql`UPDATE pipeline_stages SET is_lost=FALSE WHERE pipeline_id=${pipelineId} AND id<>${stageId} AND is_lost`.execute(tx);
  }
}

/** NULL arrays read as [] (Go replaces nil slices). */
function toStage(s: Stage): Stage {
  return {
    ...s,
    requiredFields: s.requiredFields ?? [],
    requiredActivities: s.requiredActivities ?? [],
    requiredDocuments: s.requiredDocuments ?? [],
  };
}

function withStages(p: PipelineRow, stages: Stage[]): Pipeline {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.kind,
    isDefault: p.isDefault,
    isActive: p.isActive,
    stages,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Data access; every method throws raw errors, which the service maps like the Go service. */
export class PipelinesRepository {
  constructor(private readonly db: Database) {}

  async list(kind: string, includeInactive: boolean): Promise<Pipeline[]> {
    const rows = await sql<PipelineRow>`
      SELECT ${pipelineColumns} FROM pipelines
      WHERE (${kind} = '' OR kind = ${kind}) AND (${includeInactive}::bool OR is_active = TRUE)
      ORDER BY is_default DESC, name`.execute(this.db);
    const stages = await this.stagesFor(
      rows.rows.map((p) => p.id),
      includeInactive,
    );
    return rows.rows.map((p) => withStages(p, stages.get(p.id) ?? []));
  }

  async get(id: string): Promise<Pipeline | null> {
    const r = await sql<PipelineRow>`SELECT ${pipelineColumns} FROM pipelines WHERE id = ${id}`.execute(this.db);
    const p = r.rows[0];
    if (!p) return null;
    const stages = await this.stagesFor([p.id], true);
    return withStages(p, stages.get(p.id) ?? []);
  }

  private async stagesFor(pipelineIds: string[], includeInactive: boolean): Promise<Map<string, Stage[]>> {
    const byPipeline = new Map<string, Stage[]>();
    if (pipelineIds.length === 0) return byPipeline;
    const r = await sql<Stage>`
      SELECT ${stageColumns} FROM pipeline_stages
      WHERE pipeline_id = ANY(${pipelineIds}::uuid[]) AND (${includeInactive}::bool OR is_active = TRUE)
      ORDER BY position, created_at`.execute(this.db);
    for (const s of r.rows) {
      const list = byPipeline.get(s.pipelineId) ?? [];
      list.push(toStage(s));
      byPipeline.set(s.pipelineId, list);
    }
    return byPipeline;
  }

  async getStage(id: string): Promise<Stage | null> {
    const r = await sql<Stage>`SELECT ${stageColumns} FROM pipeline_stages WHERE id = ${id}`.execute(this.db);
    return r.rows[0] ? toStage(r.rows[0]) : null;
  }

  async create(in_: CreatePipelineInput): Promise<Pipeline | null> {
    const id = randomUUID();
    const kind = in_.kind === "" ? "sales" : in_.kind;
    await this.db.transaction().execute(async (tx) => {
      if (in_.isDefault) await sql`UPDATE pipelines SET is_default = FALSE WHERE kind = ${kind}`.execute(tx);
      await sql`
        INSERT INTO pipelines (id, name, description, kind, is_default, is_active)
        VALUES (${id}, ${in_.name.trim()}, ${in_.description}, ${kind}, ${in_.isDefault}, ${in_.isActive ?? true})`.execute(tx);
    });
    return this.get(id);
  }

  async update(id: string, cur: Pipeline, in_: UpdatePipelineInput): Promise<Pipeline | null> {
    const name = in_.name !== undefined ? in_.name.trim() : cur.name;
    const description = in_.description ?? cur.description;
    const kind = in_.kind !== undefined && in_.kind !== "" ? in_.kind : cur.kind;
    const isDefault = in_.isDefault ?? cur.isDefault;
    const isActive = in_.isActive ?? cur.isActive;
    await this.db.transaction().execute(async (tx) => {
      if (isDefault) {
        await sql`UPDATE pipelines SET is_default = FALSE WHERE kind = ${kind} AND id <> ${id}`.execute(tx);
      }
      await sql`
        UPDATE pipelines SET name=${name}, description=${description}, kind=${kind}, is_default=${isDefault},
          is_active=${isActive}
        WHERE id=${id}`.execute(tx);
    });
    return this.get(id);
  }

  async createStage(pipelineId: string, in_: CreateStageInput): Promise<Stage | null> {
    const id = randomUUID();
    let position = in_.position;
    if (position === undefined) {
      // Go ignores a failed lookup and falls back to 0.
      position = await sql<{ next: number }>`
        SELECT COALESCE(MAX(position),0)+1 AS next FROM pipeline_stages WHERE pipeline_id=${pipelineId}`
        .execute(this.db)
        .then((r) => r.rows[0]?.next ?? 0)
        .catch(() => 0);
    }
    await this.db.transaction().execute(async (tx) => {
      await sql`
        INSERT INTO pipeline_stages (
          id, pipeline_id, name, position, probability, visual_accent,
          required_fields, required_activities, required_documents, sla_hours, is_won, is_lost, is_active
        ) VALUES (
          ${id}, ${pipelineId}, ${in_.name.trim()}, ${position}, ${in_.probability ?? 0}, ${in_.visualAccent || "neutral"},
          ${in_.requiredFields ?? []}::text[], ${in_.requiredActivities ?? []}::text[], ${in_.requiredDocuments ?? []}::text[],
          ${in_.slaHours ?? null}, ${in_.isWon}, ${in_.isLost}, ${in_.isActive ?? true}
        )`.execute(tx);
      await clearOtherOutcomeStages(tx, pipelineId, id, in_.isWon, in_.isLost);
    });
    return this.getStage(id);
  }

  async updateStage(id: string, cur: Stage, in_: UpdateStageInput): Promise<Stage | null> {
    const name = in_.name !== undefined ? in_.name.trim() : cur.name;
    const visualAccent = in_.visualAccent !== undefined && in_.visualAccent !== "" ? in_.visualAccent : cur.visualAccent;
    const slaHours = in_.clearSla ? null : (in_.slaHours ?? cur.slaHours);
    const isWon = in_.isWon ?? cur.isWon;
    const isLost = in_.isLost ?? cur.isLost;
    await this.db.transaction().execute(async (tx) => {
      await sql`
        UPDATE pipeline_stages SET
          name=${name}, position=${in_.position ?? cur.position}, probability=${in_.probability ?? cur.probability},
          visual_accent=${visualAccent},
          required_fields=${in_.requiredFields ?? cur.requiredFields}::text[],
          required_activities=${in_.requiredActivities ?? cur.requiredActivities}::text[],
          required_documents=${in_.requiredDocuments ?? cur.requiredDocuments}::text[],
          sla_hours=${slaHours},
          is_won=${isWon}, is_lost=${isLost}, is_active=${in_.isActive ?? cur.isActive}
        WHERE id=${id}`.execute(tx);
      await clearOtherOutcomeStages(tx, cur.pipelineId, id, isWon, isLost);
    });
    return this.getStage(id);
  }

  /** Positions follow the given order (1-based); any stage outside the pipeline aborts everything. */
  async reorderStages(pipelineId: string, stageIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      for (const [i, stageId] of stageIds.entries()) {
        const r = await sql`
          UPDATE pipeline_stages SET position=${i + 1} WHERE id=${stageId} AND pipeline_id=${pipelineId}`.execute(tx);
        if ((r.numAffectedRows ?? 0n) === 0n) throw AppError.validation("stage does not belong to pipeline");
      }
    });
  }

  async stageBelongsToPipeline(stageId: string, pipelineId: string): Promise<boolean> {
    const r = await sql<{ ok: boolean }>`
      SELECT EXISTS(SELECT 1 FROM pipeline_stages WHERE id=${stageId} AND pipeline_id=${pipelineId} AND is_active = TRUE) AS ok`.execute(
      this.db,
    );
    return r.rows[0]?.ok === true;
  }

  async stageUsage(stageId: string): Promise<{ leads: number; deals: number }> {
    const r = await sql<{ leads: number; deals: number }>`
      SELECT
        (SELECT COUNT(*)::int FROM leads WHERE stage_id = ${stageId}::uuid) AS leads,
        (SELECT COUNT(*)::int FROM deals WHERE stage_id = ${stageId}::uuid) AS deals`.execute(this.db);
    return r.rows[0] ?? { leads: 0, deals: 0 };
  }

  async deleteStage(id: string): Promise<void> {
    await sql`DELETE FROM pipeline_stages WHERE id = ${id}`.execute(this.db);
  }
}

export class PipelinesService {
  readonly repo: PipelinesRepository;

  constructor(
    db: Database,
    private readonly audit: AuditService,
    private readonly hooks: AutomationEmitter,
  ) {
    this.repo = new PipelinesRepository(db);
  }

  async list(kind: string, includeInactive: boolean): Promise<Pipeline[]> {
    return internal("failed to list pipelines", () => this.repo.list(kind, includeInactive));
  }

  async get(id: string): Promise<Pipeline> {
    const p = await internal("failed to load pipeline", () => this.repo.get(id));
    if (!p) throw AppError.notFound("pipeline not found");
    return p;
  }

  async create(actorId: string, in_: CreatePipelineInput, meta: RequestMeta): Promise<Pipeline> {
    if (in_.name.trim() === "") throw AppError.validation("name is required");
    const kind = in_.kind === "" ? "sales" : in_.kind;
    if (kind !== "sales" && kind !== "leads") throw AppError.validation("kind must be sales or leads");
    const p = await internal("failed to create pipeline", async () => {
      const created = await this.repo.create({ ...in_, kind });
      if (!created) throw new Error("created pipeline not found");
      return created;
    });
    await this.audit.record(actorId, "pipeline.created", "pipeline", p.id, { name: p.name, kind: p.kind }, meta);
    await this.hooks.emit(AutomationEvent.PipelineCreated, "pipeline", p.id, { name: p.name });
    return p;
  }

  async update(actorId: string, id: string, in_: UpdatePipelineInput, meta: RequestMeta): Promise<Pipeline> {
    const cur = await this.get(id);
    const p = await internal("failed to update pipeline", async () => {
      const updated = await this.repo.update(id, cur, in_);
      if (!updated) throw new Error("updated pipeline not found");
      return updated;
    });
    await this.audit.record(actorId, "pipeline.updated", "pipeline", id, { name: p.name, isActive: p.isActive }, meta);
    await this.hooks.emit(AutomationEvent.PipelineUpdated, "pipeline", id, { name: p.name });
    return p;
  }

  async createStage(actorId: string, pipelineId: string, in_: CreateStageInput, meta: RequestMeta): Promise<Stage> {
    await this.get(pipelineId);
    if (in_.name.trim() === "") throw AppError.validation("stage name is required");
    if (in_.isWon && in_.isLost) throw AppError.validation("a stage cannot be both won and lost");
    const st = await internal("failed to create stage", async () => {
      const created = await this.repo.createStage(pipelineId, in_);
      if (!created) throw new Error("created stage not found");
      return created;
    });
    await this.audit.record(actorId, "pipeline.stage_created", "pipeline_stage", st.id, { pipelineId, name: st.name }, meta);
    return st;
  }

  async updateStage(actorId: string, stageId: string, in_: UpdateStageInput, meta: RequestMeta): Promise<Stage> {
    const cur = await internal("failed to load stage", () => this.repo.getStage(stageId));
    if (!cur) throw AppError.notFound("stage not found");
    if ((in_.isWon ?? cur.isWon) && (in_.isLost ?? cur.isLost)) {
      throw AppError.validation("a stage cannot be both won and lost");
    }
    const st = await internal("failed to update stage", async () => {
      const updated = await this.repo.updateStage(stageId, cur, in_);
      if (!updated) throw new Error("updated stage not found");
      return updated;
    });
    await this.audit.record(actorId, "pipeline.stage_updated", "pipeline_stage", stageId, { name: st.name, position: st.position }, meta);
    return st;
  }

  async reorderStages(actorId: string, pipelineId: string, stageIds: string[] | undefined, meta: RequestMeta): Promise<Pipeline> {
    await this.get(pipelineId);
    if (!stageIds || stageIds.length === 0) throw AppError.validation("stageIds required");
    await internal("failed to reorder stages", () => this.repo.reorderStages(pipelineId, stageIds));
    await this.audit.record(actorId, "pipeline.stages_reordered", "pipeline", pipelineId, { stageIds }, meta);
    return this.get(pipelineId);
  }

  async deleteStage(actorId: string, stageId: string, meta: RequestMeta): Promise<void> {
    const cur = await internal("failed to load stage", () => this.repo.getStage(stageId));
    if (!cur) throw AppError.notFound("stage not found");
    if (cur.isWon || cur.isLost) {
      throw AppError.validation("Won and Lost stages can't be deleted. Hide them instead if you need them off the board.");
    }
    const usage = await internal("failed to check stage usage", () => this.repo.stageUsage(stageId));
    if (usage.leads > 0 || usage.deals > 0) {
      const parts: string[] = [];
      if (usage.leads > 0) parts.push(`${usage.leads} lead${usage.leads === 1 ? "" : "s"}`);
      if (usage.deals > 0) parts.push(`${usage.deals} deal${usage.deals === 1 ? "" : "s"}`);
      throw AppError.validation(
        `This stage still has ${parts.join(" and ")}. Move them first, or hide the stage instead.`,
      );
    }
    try {
      await this.repo.deleteStage(stageId);
    } catch (err) {
      const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
      if (code === "23503") {
        throw AppError.validation("This stage has history and can't be removed. Hide it instead.");
      }
      throw AppError.internal("failed to delete stage", err);
    }
    await this.audit.record(
      actorId,
      "pipeline.stage_deleted",
      "pipeline_stage",
      stageId,
      { pipelineId: cur.pipelineId, name: cur.name },
      meta,
    );
  }
}

