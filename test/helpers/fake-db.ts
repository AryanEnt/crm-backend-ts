import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type { DB } from "../../src/db/schema.js";

export interface FakeDb {
  db: Kysely<DB>;
  /** Every query the code under test executed. */
  queries: CompiledQuery[];
  /** Rows returned for every query not covered by queue() (default: []). */
  setRows(rows: Record<string, unknown>[]): void;
  /** Rows for the next queries, one entry per query, in order. */
  queue(...results: Record<string, unknown>[][]): void;
  /** Make every query reject with err. */
  failWith(err: Error): void;
}

/** A Kysely instance that compiles real Postgres SQL but never touches a database. */
export function fakeDb(): FakeDb {
  const queries: CompiledQuery[] = [];
  let rows: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[][] = [];
  let failure: Error | null = null;

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(compiled);
      if (failure) throw failure;
      return { rows: (pending.shift() ?? rows) as R[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("not supported");
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return {
    db,
    queries,
    setRows: (r) => {
      rows = r;
    },
    queue: (...results) => {
      pending.push(...results);
    },
    failWith: (err) => {
      failure = err;
    },
  };
}
