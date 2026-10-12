/**
 * Go fmt "%.Nf". Go rounds the exact binary value half-to-even, so an exact tie such as
 * 2.5 or 12.25 goes to the even digit ("2", "12.2"); toFixed rounds ties away from zero.
 */
export function goFixed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return v.toFixed(digits);
  const [int = "", frac = ""] = Math.abs(v).toFixed(100).split(".");
  if (/^50*$/.test(frac.slice(digits))) {
    const kept = digits > 0 ? `${int}.${frac.slice(0, digits)}` : int;
    const last = Number(kept[kept.length - 1]);
    if (last % 2 === 0) return (v < 0 || Object.is(v, -0) ? "-" : "") + kept;
  }
  return v.toFixed(digits);
}

/** Go fmt "%v" of a float64: shortest digits, exponent form below 1e-4 and from 1e6 up. */
export function goFloatV(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const [mantissa = "", expRaw = "0"] = Math.abs(v).toExponential().split("e");
  const exp = Number(expRaw);
  if (exp >= -4 && exp < 6) return String(v);
  const sign = v < 0 ? "-" : "";
  return `${sign}${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Go fmt "%v" of a value decoded from JSON (map keys sorted, nil as <nil>). */
export function goV(v: unknown): string {
  if (v === null || v === undefined) return "<nil>";
  if (typeof v === "string") return v;
  if (typeof v === "number") return goFloatV(v);
  if (Array.isArray(v)) return `[${v.map(goV).join(" ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `map[${entries.map(([k, x]) => `${k}:${goV(x)}`).join(" ")}]`;
  }
  return String(v);
}

const QUOTE_ESCAPES: Record<string, string> = {
  '"': '\\"', "\\": "\\\\", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v",
};

/** Go fmt "%q" / strconv.Quote: printable characters kept, everything else escaped. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (QUOTE_ESCAPES[ch]) out += QUOTE_ESCAPES[ch];
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x80 || /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + '"';
}
