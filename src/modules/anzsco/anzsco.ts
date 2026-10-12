import type { Router } from "express";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import { AppError } from "../../lib/app-error.js";
import { ok } from "../../lib/response.js";
import { atoi, queryParam } from "../../lib/query.js";
import { createRouter } from "../../lib/router.js";
import type { Guard } from "../auth/guard.js";
import { P } from "../permissions/permissions.js";

export interface Occupation {
  id: string;
  code: string;
  title: string;
  occupationGroup: string;
  skillLevel: number;
  createdAt: Date;
}

const occupationColumns = sql`id::text AS "id", code, title, occupation_group AS "occupationGroup",
  skill_level AS "skillLevel", created_at AS "createdAt"`;

export class AnzscoService {
  constructor(private readonly db: Database) {}

  /** Exact code first, then code prefix, then everything else by title. */
  async search(qRaw: string, limitRaw: number): Promise<Occupation[]> {
    const limit = limitRaw <= 0 || limitRaw > 50 ? 20 : limitRaw;
    const q = qRaw.trim();
    try {
      const r = await sql<Occupation>`
        SELECT ${occupationColumns}
        FROM anzsco_occupations
        WHERE (${q} = '' OR code ILIKE '%' || ${q} || '%' OR title ILIKE '%' || ${q} || '%'
          OR occupation_group ILIKE '%' || ${q} || '%')
        ORDER BY CASE WHEN code = ${q} THEN 0 WHEN code ILIKE ${q} || '%' THEN 1 ELSE 2 END, title
        LIMIT ${limit}`.execute(this.db);
      return r.rows;
    } catch (err) {
      throw AppError.internal("failed to search ANZSCO", err);
    }
  }

  async get(id: string): Promise<Occupation | null> {
    const r = await sql<Occupation>`SELECT ${occupationColumns} FROM anzsco_occupations WHERE id = ${id}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async exists(id: string): Promise<boolean> {
    const r = await sql<{ ok: boolean }>`SELECT EXISTS(SELECT 1 FROM anzsco_occupations WHERE id=${id}) AS ok`.execute(this.db);
    return r.rows[0]?.ok === true;
  }
}

export function anzscoRouter(service: AnzscoService, guard: Guard): Router {
  const router = createRouter();
  router.get("/api/v1/anzsco", ...guard(P.LeadsView, P.CustomersView), async (req, res) => {
    ok(res, await service.search(queryParam(req, "q"), atoi(queryParam(req, "limit"))));
  });
  return router;
}
