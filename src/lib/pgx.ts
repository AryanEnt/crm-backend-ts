/** pgx.ErrNoRows, for code paths that surface the Go error text. */
export class NoRowsError extends Error {
  constructor() {
    super("no rows in result set");
  }
}

/** err.Error() as pgx formats it: Postgres errors read "SEVERITY: message (SQLSTATE code)". */
export function pgxMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as { severity?: unknown; code?: unknown; message?: unknown };
    if (typeof e.severity === "string" && typeof e.code === "string" && typeof e.message === "string") {
      return `${e.severity}: ${e.message} (SQLSTATE ${e.code})`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
