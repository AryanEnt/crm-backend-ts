import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { DB } from "../src/db/schema.js";
import type { AuditService } from "../src/modules/audit/audit.service.js";
import { CustomFieldsService } from "../src/modules/custom-fields/custom-fields.service.js";
import { P } from "../src/modules/permissions/permissions.js";
import { bearer, config, queueAuth } from "./helpers/app.js";
import { fakeDb } from "./helpers/fake-db.js";

const FIELD_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const fieldRow = {
  id: FIELD_ID,
  entity: "lead",
  name: "Tier",
  internalKey: "tier",
  fieldType: "single_select",
  description: "",
  helpText: "",
  isRequired: false,
  isActive: true,
  displayOrder: 0,
  pipelineId: null,
  pipelineName: null,
  stageId: null,
  stageName: null,
  createdBy: null,
  createdByName: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("custom field definitions", () => {
  it("a null option decodes to Go's zero struct: it counts for select fields and is then skipped", async () => {
    const f = fakeDb();
    queueAuth(f, P.CustomFieldsManage);
    f.queue([{ id: FIELD_ID }], [], [], [fieldRow], []);
    const res = await request(createApp({ config: config(), db: f.db }))
      .post("/api/v1/custom-fields")
      .set("Authorization", bearer())
      .send({ entity: "lead", name: "Tier", internalKey: "tier", fieldType: "single_select", options: [null] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: FIELD_ID, options: [] });
    expect(res.body.data).not.toHaveProperty("createdByName");
    expect(f.queries.some((q) => q.sql.includes("INSERT INTO custom_field_options"))).toBe(false);
  });

  it("a failed COMMIT reports Go's \"commit\" message", async () => {
    const connection: DatabaseConnection = {
      async executeQuery<R>(_q: CompiledQuery): Promise<QueryResult<R>> {
        return { rows: [{ id: FIELD_ID }] as R[] };
      },
      // eslint-disable-next-line require-yield
      async *streamQuery() {
        throw new Error("not supported");
      },
    };
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          async init() {},
          async acquireConnection() {
            return connection;
          },
          async beginTransaction() {},
          async commitTransaction() {
            throw new Error("connection reset");
          },
          async rollbackTransaction() {},
          async releaseConnection() {},
          async destroy() {},
        }),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const service = new CustomFieldsService(db, { record: async () => {} } as unknown as AuditService);
    const input = {
      entity: "lead",
      name: "Tier",
      internalKey: "tier",
      fieldType: "text",
      description: "",
      helpText: "",
      isRequired: false,
    };
    await expect(service.create("u1", input, { ip: "", userAgent: "" })).rejects.toMatchObject({
      code: "internal_error",
      message: "commit",
      status: 500,
    });
  });
});
