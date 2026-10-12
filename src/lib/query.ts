import type { Request } from "express";

/** First value of a query parameter, or "" — like Go's r.URL.Query().Get. */
export function queryParam(req: Request, key: string): string {
  const v: unknown = req.query[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** Go's strconv.Atoi with the error ignored: 0 unless s is a plain base-10 integer. */
export function atoi(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) return 0;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Go's strconv.ParseBool with the error ignored. */
export function parseBool(s: string): boolean {
  return s === "1" || s === "t" || s === "T" || s === "true" || s === "TRUE" || s === "True";
}
