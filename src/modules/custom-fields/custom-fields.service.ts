import { sql, type ControlledTransaction, type Transaction } from "kysely";
import type { Database } from "../../db/database.js";
import type { DB } from "../../db/schema.js";
import { AppError } from "../../lib/app-error.js";
import { goMarshal, goSortKeys } from "../../lib/go-json.js";
import { isUniqueViolation, type RequestMeta } from "../../lib/request-meta.js";
import type { AuditService } from "../audit/audit.service.js";

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ENTITIES = new Set(["lead", "customer", "deal", "activity"]);
const FIELD_TYPES = new Set([
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "datetime",
  "boolean",
  "single_select",
  "multi_select",
  "url",
  "email",
  "phone",
]);
const RECORD_TABLES: Record<string, string> = { lead: "leads", customer: "customers", deal: "deals" };

export interface FieldOption {
  id: string;
  label: string;
  value: string;
  position: number;
  isActive: boolean;
}

export interface CustomField {
  id: string;
  entity: string;
  name: string;
  internalKey: string;
  fieldType: string;
  description: string;
  helpText: string;
  isRequired: boolean;
  isActive: boolean;
  displayOrder: number;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  createdBy: string | null;
  createdByName?: string;
  options: FieldOption[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OptionInput {
  label: string;
  value: string;
  position: number;
}

export interface CreateFieldInput {
  entity: string;
  name: string;
  internalKey: string;
  fieldType: string;
  description: string;
  helpText: string;
  isRequired: boolean;
  isActive?: boolean | undefined;
  displayOrder?: number | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  options?: OptionInput[] | undefined;
}

export interface UpdateFieldInput {
  name?: string | undefined;
  description?: string | undefined;
  helpText?: string | undefined;
  isRequired?: boolean | undefined;
  isActive?: boolean | undefined;
  displayOrder?: number | undefined;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  options?: OptionInput[] | undefined;
}

export interface FieldFilter {
  entity: string;
  fieldType: string;
  activeOnly: boolean;
  q: string;
  pipelineId: string;
  stageId: string;
  applyScope: boolean;
}

type FieldRow = Omit<CustomField, "options" | "createdByName"> & { createdByName: string | null };

const fieldSelect = sql`
  SELECT cf.id::text AS "id", cf.entity, cf.name, cf.internal_key AS "internalKey", cf.field_type AS "fieldType",
    cf.description, cf.help_text AS "helpText", cf.is_required AS "isRequired", cf.is_active AS "isActive",
    cf.display_order AS "displayOrder",
    cf.pipeline_id::text AS "pipelineId", p.name AS "pipelineName", cf.stage_id::text AS "stageId", ps.name AS "stageName",
    cf.created_by::text AS "createdBy", u.full_name AS "createdByName",
    cf.created_at AS "createdAt", cf.updated_at AS "updatedAt"
  FROM custom_fields cf
  LEFT JOIN users u ON u.id = cf.created_by
  LEFT JOIN pipelines p ON p.id = cf.pipeline_id
  LEFT JOIN pipeline_stages ps ON ps.id = cf.stage_id`;

/** Builds the response object in Go's struct field order; createdByName is omitempty. */
function toField(r: FieldRow, options: FieldOption[]): CustomField {
  return {
    id: r.id,
    entity: r.entity,
    name: r.name,
    internalKey: r.internalKey,
    fieldType: r.fieldType,
    description: r.description,
    helpText: r.helpText,
    isRequired: r.isRequired,
    isActive: r.isActive,
    displayOrder: r.displayOrder,
    pipelineId: r.pipelineId,
    pipelineName: r.pipelineName,
    stageId: r.stageId,
    stageName: r.stageName,
    createdBy: r.createdBy,
    ...(r.createdByName !== null && { createdByName: r.createdByName }),
    options,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const blankToNull = (id: string) => (id.trim() === "" ? null : id);

export class CustomFieldsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(f: FieldFilter): Promise<CustomField[]> {
    const q = f.q.trim();
    let rows: FieldRow[];
    try {
      const r = await sql<FieldRow>`${fieldSelect}
        WHERE (${f.entity} = '' OR cf.entity = ${f.entity})
          AND (${f.fieldType} = '' OR cf.field_type = ${f.fieldType})
          AND (${f.activeOnly}::bool = false OR cf.is_active = true)
          AND (${q} = '' OR cf.name ILIKE '%'||${q}||'%' OR cf.internal_key ILIKE '%'||${q}||'%')
          AND (${f.applyScope}::bool = false OR (
            (cf.pipeline_id IS NULL AND cf.stage_id IS NULL)
            OR (${f.pipelineId} <> '' AND cf.pipeline_id::text = ${f.pipelineId} AND cf.stage_id IS NULL)
            OR (${f.pipelineId} <> '' AND ${f.stageId} <> '' AND cf.pipeline_id::text = ${f.pipelineId} AND cf.stage_id::text = ${f.stageId})
          ))
        ORDER BY cf.entity, cf.display_order, cf.name`.execute(this.db);
      rows = r.rows;
    } catch (err) {
      throw AppError.internal("failed to list custom fields", err);
    }
    const options = await this.loadOptions(rows.map((r) => r.id));
    return rows.map((r) => toField(r, options.get(r.id) ?? []));
  }

  async get(id: string): Promise<CustomField> {
    let row: FieldRow | undefined;
    try {
      row = (await sql<FieldRow>`${fieldSelect} WHERE cf.id=${id}::uuid`.execute(this.db)).rows[0];
    } catch {
      // Go maps every error, including an invalid uuid, to not found.
    }
    if (!row) throw AppError.notFound("custom field not found");
    const options = await this.loadOptions([row.id]);
    return toField(row, options.get(row.id) ?? []);
  }

  /** Options per field, ordered by position then label; load failures read as no options (as in Go). */
  private async loadOptions(fieldIds: string[]): Promise<Map<string, FieldOption[]>> {
    const byField = new Map<string, FieldOption[]>();
    if (fieldIds.length === 0) return byField;
    try {
      const r = await sql<FieldOption & { fieldId: string }>`
        SELECT custom_field_id::text AS "fieldId", id::text AS "id", label, value, position, is_active AS "isActive"
        FROM custom_field_options WHERE custom_field_id = ANY(${fieldIds}::uuid[])
        ORDER BY position, label`.execute(this.db);
      for (const { fieldId, ...opt } of r.rows) {
        const list = byField.get(fieldId) ?? [];
        list.push(opt);
        byField.set(fieldId, list);
      }
    } catch {
      // Go: loadOptions returns [] on error.
    }
    return byField;
  }

  async create(actorId: string, in_: CreateFieldInput, meta: RequestMeta): Promise<CustomField> {
    const entity = in_.entity.trim().toLowerCase();
    const name = in_.name.trim();
    const key = in_.internalKey.trim();
    const fieldType = in_.fieldType.trim();
    const options = in_.options ?? [];
    if (!ENTITIES.has(entity)) throw AppError.validation("invalid entity");
    if (name === "") throw AppError.validation("field name is required");
    if (!KEY_RE.test(key)) throw AppError.validation("internal key must be lowercase letters, numbers, underscores");
    if (!FIELD_TYPES.has(fieldType)) throw AppError.validation("invalid field type");
    if ((fieldType === "single_select" || fieldType === "multi_select") && options.length === 0) {
      throw AppError.validation("select fields require at least one option");
    }
    const pipelineId = (in_.pipelineId ?? "").trim();
    const stageId = (in_.stageId ?? "").trim();
    await this.validateScope(pipelineId, stageId);

    const id = await this.transaction("begin tx", async (tx) => {
      let newId: string;
      try {
        const r = await sql<{ id: string }>`
          INSERT INTO custom_fields (entity, name, internal_key, field_type, description, help_text,
            is_required, is_active, display_order, created_by, updated_by, pipeline_id, stage_id)
          VALUES (${entity}, ${name}, ${key}, ${fieldType}, ${in_.description.trim()}, ${in_.helpText.trim()},
            ${in_.isRequired}, ${in_.isActive ?? true}, ${in_.displayOrder ?? 0}, ${actorId}::uuid, ${actorId}::uuid,
            ${blankToNull(pipelineId)}, ${blankToNull(stageId)})
          RETURNING id::text AS "id"`.execute(tx);
        newId = r.rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("internal key already exists for this pipeline and stage");
        throw AppError.internal("create custom field", err);
      }
      await this.replaceOptions(tx, newId, options);
      return newId;
    });

    await this.audit.record(actorId, "custom_field.created", "custom_field", id, { entity, name, internalKey: key, fieldType }, meta);
    return this.get(id);
  }

  async update(actorId: string, id: string, in_: UpdateFieldInput, meta: RequestMeta): Promise<CustomField> {
    const cur = await this.get(id);
    const name = in_.name !== undefined ? in_.name.trim() : cur.name;
    const description = in_.description !== undefined ? in_.description.trim() : cur.description;
    const helpText = in_.helpText !== undefined ? in_.helpText.trim() : cur.helpText;
    const isRequired = in_.isRequired ?? cur.isRequired;
    const isActive = in_.isActive ?? cur.isActive;
    const displayOrder = in_.displayOrder ?? cur.displayOrder;

    let pipelineId = cur.pipelineId ?? "";
    let stageId = cur.stageId ?? "";
    if (in_.pipelineId !== undefined) {
      pipelineId = in_.pipelineId.trim();
      // Changing the pipeline without naming a stage clears the stage.
      if (in_.stageId === undefined) stageId = "";
    }
    if (in_.stageId !== undefined) stageId = in_.stageId.trim();
    await this.validateScope(pipelineId, stageId);

    await this.transaction("begin tx", async (tx) => {
      try {
        await sql`
          UPDATE custom_fields SET name=${name}, description=${description}, help_text=${helpText},
            is_required=${isRequired}, is_active=${isActive}, display_order=${displayOrder}, updated_by=${actorId}::uuid,
            pipeline_id=${blankToNull(pipelineId)}, stage_id=${blankToNull(stageId)}
          WHERE id=${id}::uuid`.execute(tx);
      } catch (err) {
        throw AppError.internal("update custom field", err);
      }
      if (in_.options !== undefined) await this.replaceOptions(tx, id, in_.options);
    });

    await this.audit.record(actorId, "custom_field.updated", "custom_field", id, { name, isActive }, meta);
    return this.get(id);
  }

  async delete(actorId: string, id: string, meta: RequestMeta): Promise<void> {
    // Go ignores a failed usage count (e.g. an invalid uuid) and lets the DELETE report it.
    const usage = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM custom_field_values WHERE custom_field_id=${id}::uuid`
      .execute(this.db)
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => 0);
    if (usage > 0) throw AppError.validation("cannot delete a field with stored values; deactivate it instead");

    let affected: bigint;
    try {
      const r = await sql`DELETE FROM custom_fields WHERE id=${id}::uuid`.execute(this.db);
      affected = r.numAffectedRows ?? 0n;
    } catch (err) {
      throw AppError.internal("delete custom field", err);
    }
    if (affected === 0n) throw AppError.notFound("custom field not found");
    await this.audit.record(actorId, "custom_field.deleted", "custom_field", id, null, meta);
  }

  async getValues(entity: string, recordId: string): Promise<Record<string, unknown>> {
    let rows: { key: string; text: string | null; json: unknown }[];
    try {
      const r = await sql<{ key: string; text: string | null; json: unknown }>`
        SELECT cf.internal_key AS "key", v.value_text AS "text", v.value_json AS "json"
        FROM custom_field_values v
        JOIN custom_fields cf ON cf.id = v.custom_field_id
        WHERE v.entity=${entity} AND v.record_id=${recordId}::uuid`.execute(this.db);
      rows = r.rows;
    } catch (err) {
      throw AppError.internal("load field values", err);
    }
    const out: Record<string, unknown> = {};
    for (const { key, text, json } of rows) {
      // A non-null JSON value wins; otherwise the text value, if any.
      if (json !== null && json !== undefined) out[key] = json;
      else if (text !== null) out[key] = text;
    }
    return goSortKeys(out);
  }

  /** Upserts values for active fields that apply to the record's pipeline/stage; unknown keys are skipped. */
  async setValues(actorId: string, entity: string, recordId: string, values: Record<string, unknown> | undefined): Promise<void> {
    if (!ENTITIES.has(entity)) throw AppError.validation("invalid entity");
    const { pipelineId, stageId } = await this.recordScope(entity, recordId);
    const defs = await this.list({ entity, fieldType: "", activeOnly: true, q: "", pipelineId, stageId, applyScope: true });
    const byKey = new Map(defs.map((d) => [d.internalKey, d]));

    for (const [key, value] of Object.entries(values ?? {})) {
      const def = byKey.get(key);
      if (!def) continue;
      const { text, json } = encodeValue(value);
      try {
        await sql`
          INSERT INTO custom_field_values (custom_field_id, entity, record_id, value_text, value_json, updated_by)
          VALUES (${def.id}::uuid, ${entity}, ${recordId}::uuid, ${text}, ${json}::jsonb, ${actorId}::uuid)
          ON CONFLICT (custom_field_id, record_id) DO UPDATE
          SET value_text=EXCLUDED.value_text, value_json=EXCLUDED.value_json, updated_by=EXCLUDED.updated_by, updated_at=NOW()`.execute(
          this.db,
        );
      } catch (err) {
        throw AppError.internal("save field value", err);
      }
    }
  }

  private async recordScope(entity: string, recordId: string): Promise<{ pipelineId: string; stageId: string }> {
    const table = Object.hasOwn(RECORD_TABLES, entity) ? RECORD_TABLES[entity] : undefined;
    if (!table) return { pipelineId: "", stageId: "" };
    try {
      const r = await sql<{ pipelineId: string | null; stageId: string | null }>`
        SELECT pipeline_id::text AS "pipelineId", stage_id::text AS "stageId" FROM ${sql.table(table)} WHERE id=${recordId}`.execute(
        this.db,
      );
      const row = r.rows[0];
      return { pipelineId: row?.pipelineId ?? "", stageId: row?.stageId ?? "" };
    } catch {
      return { pipelineId: "", stageId: "" };
    }
  }

  private async validateScope(pipelineId: string, stageId: string): Promise<void> {
    if (stageId !== "" && pipelineId === "") throw AppError.validation("choose a pipeline before a stage");
    if (pipelineId !== "") {
      let ok: boolean;
      try {
        const r = await sql<{ ok: boolean }>`
          SELECT EXISTS(SELECT 1 FROM pipelines WHERE id=${pipelineId} AND is_active=TRUE) AS ok`.execute(this.db);
        ok = r.rows[0]?.ok === true;
      } catch (err) {
        throw AppError.internal("failed to check pipeline", err);
      }
      if (!ok) throw AppError.validation("pipeline is invalid or inactive");
    }
    if (stageId !== "") {
      let ok: boolean;
      try {
        const r = await sql<{ ok: boolean }>`
          SELECT EXISTS(SELECT 1 FROM pipeline_stages WHERE id=${stageId} AND pipeline_id=${pipelineId} AND is_active=TRUE) AS ok`.execute(
          this.db,
        );
        ok = r.rows[0]?.ok === true;
      } catch (err) {
        throw AppError.internal("failed to check stage", err);
      }
      if (!ok) throw AppError.validation("stage is not an active stage on this pipeline");
    }
  }

  /** Replaces all options; blank labels are skipped, blank values derive from the label. */
  private async replaceOptions(tx: Transaction<DB>, fieldId: string, options: OptionInput[]): Promise<void> {
    try {
      await sql`DELETE FROM custom_field_options WHERE custom_field_id=${fieldId}::uuid`.execute(tx);
    } catch (err) {
      throw AppError.internal("clear options", err);
    }
    for (const [i, o] of options.entries()) {
      const label = o.label.trim();
      let value = o.value.trim();
      if (value === "") value = label.replaceAll(" ", "_").toLowerCase();
      if (label === "") continue;
      const position = o.position === 0 ? i + 1 : o.position;
      try {
        await sql`
          INSERT INTO custom_field_options (custom_field_id, label, value, position)
          VALUES (${fieldId}::uuid, ${label}, ${value}, ${position})`.execute(tx);
      } catch (err) {
        throw AppError.internal("insert option", err);
      }
    }
  }

  /** A failed BEGIN reports beginMessage and a failed COMMIT reports "commit", as in Go. */
  private async transaction<T>(beginMessage: string, fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    let tx: ControlledTransaction<DB>;
    try {
      tx = await this.db.startTransaction().execute();
    } catch (err) {
      throw AppError.internal(beginMessage, err);
    }
    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      await tx.rollback().execute().catch(() => undefined);
      throw err;
    }
    try {
      await tx.commit().execute();
    } catch (err) {
      throw AppError.internal("commit", err);
    }
    return result;
  }
}

/** Go's encodeValue: strings keep their text; other values store their JSON encoding as text. */
export function encodeValue(v: unknown): { text: string | null; json: string } {
  if (v === null || v === undefined) return { text: null, json: "null" };
  if (typeof v === "string") return { text: v, json: goMarshal(v) };
  const json = goMarshal(v);
  return { text: json, json };
}