const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysIn(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  t.setUTCFullYear(y);
  return t;
}

function validDate(y: number, mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** Go's time.Parse(time.RFC3339, s); null when Go would return an error. */
export function parseRfc3339(s: string): Date | null {
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  let offsetMin = 0;
  const zone = m[8]!;
  if (zone !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offsetMin = (zh * 60 + zm) * (zone.startsWith("-") ? -1 : 1);
  }
  return new Date(utc(y, mo, d, h, mi, sec, ms).getTime() - offsetMin * 60_000);
}

/** Go's time.Parse("2006-01-02", s): midnight UTC, or null. */
export function parseDateOnly(s: string): Date | null {
  const m = DATE_ONLY.exec(s);
  if (!m) return null;
  const [y, mo, d] = m.slice(1, 4).map(Number) as [number, number, number];
  return validDate(y, mo, d) ? utc(y, mo, d) : null;
}

const LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/;

/** Go's time.Parse("2006-01-02T15:04", s): a zone-less local time read as UTC, or null. */
export function parseLocalMinute(s: string): Date | null {
  const m = LOCAL_MINUTE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (!validDate(y, mo, d) || h > 23 || mi > 59) return null;
  return utc(y, mo, d, h, mi);
}

/**
 * The CRM services' parseOptionalTime: blank means no time; RFC3339 first, then a bare date
 * (activities also accept a zone-less "2006-01-02T15:04" in between).
 * Throws "invalid" (the caller maps it to its own validation message) when nothing parses.
 */
export function parseOptionalTime(v: string | undefined, opts: { localMinute?: boolean } = {}): Date | null {
  const s = v?.trim() ?? "";
  if (s === "") return null;
  const t = parseRfc3339(s) ?? (opts.localMinute ? parseLocalMinute(s) : null) ?? parseDateOnly(s);
  if (!t) throw new InvalidTimeError();
  return t;
}

/**
 * An instant with Go's nanosecond precision. JSON output matches Go's RFC3339Nano
 * (trailing fractional zeros trimmed); `sql` is truncated to microseconds, as pgx binds it.
 */
export class GoTime {
  private constructor(
    readonly ms: number,
    /** Nanoseconds below the millisecond, 0–999999. */
    private readonly subMsNanos = 0,
  ) {}

  static fromDate(d: Date): GoTime {
    return new GoTime(d.getTime());
  }

  /** Go's t.Add(24*time.Hour - time.Nanosecond). */
  endOfDay(): GoTime {
    return new GoTime(this.ms + 86_399_999, 999_999);
  }

  private parts(): { base: string; nanos: number } {
    const iso = new Date(this.ms).toISOString();
    return { base: iso.slice(0, 19), nanos: (this.ms % 1000 + 1000) % 1000 * 1_000_000 + this.subMsNanos };
  }

  toJSON(): string {
    const { base, nanos } = this.parts();
    const frac = nanos === 0 ? "" : "." + String(nanos).padStart(9, "0").replace(/0+$/, "");
    return `${base}${frac}Z`;
  }

  get sql(): string {
    const { base, nanos } = this.parts();
    return `${base}.${String(Math.floor(nanos / 1000)).padStart(6, "0")}Z`;
  }
}

export class InvalidTimeError extends Error {
  constructor() {
    super("invalid time");
  }
}
