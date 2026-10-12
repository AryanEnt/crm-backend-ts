/**
 * JSON encoding identical to Go's json.Marshal for values decoded from JSON:
 * object keys sorted, and <, >, &, U+2028, U+2029 escaped. Use where the encoded text
 * is stored and later compared or displayed (e.g. custom field value_text).
 */
export function goMarshal(value: unknown): string {
  return escapeHtml(JSON.stringify(goSortKeys(value)));
}

/**
 * Recursively orders object keys the way Go encodes map[string]any: by byte order.
 * Apply to anything Go holds in a map (meta, jsonb decoded into map[string]any, ...);
 * Postgres returns jsonb keys in its own storage order.
 */
export function goSortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(goSortKeys) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(goStringCompare)) {
      out[key] = goSortKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/**
 * jsonb decoded with `m := map[string]any{}; json.Unmarshal(raw, &m)`: JSON null sets the
 * map to nil (encoded as null), a non-object fails and leaves {}, an object is key-sorted.
 */
export function goMapOrNull(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  return typeof v === "object" && !Array.isArray(v) ? goSortKeys(v as Record<string, unknown>) : {};
}

function goStringCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function escapeHtml(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
