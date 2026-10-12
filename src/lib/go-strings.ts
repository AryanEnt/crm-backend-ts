/**
 * Go's `s[:n]` on a string: the first n UTF-8 bytes. Go can split a character there and
 * Postgres then rejects the text; here a split character decodes to U+FFFD instead.
 */
export function truncateBytes(s: string, n: number): string {
  return Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n).toString();
}

/** Go's url.ParseQuery: values per key in order, and whether Go would report an error. */
export function goParseQuery(raw: string): { values: Map<string, string[]>; error: boolean } {
  const values = new Map<string, string[]>();
  let error = false;
  for (const pair of raw.split("&")) {
    if (pair.includes(";")) {
      error = true;
      continue;
    }
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = queryUnescape(eq < 0 ? pair : pair.slice(0, eq));
    const value = queryUnescape(eq < 0 ? "" : pair.slice(eq + 1));
    if (key === null || value === null) {
      error = true;
      continue;
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return { values, error };
}

/** Go's url.QueryUnescape; null on a malformed %-escape. */
function queryUnescape(s: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c === "+") {
      bytes.push(0x20);
    } else {
      bytes.push(...Buffer.from(c));
    }
  }
  return Buffer.from(bytes).toString();
}
