/** Go RE2 `\s` is ASCII whitespace only. */
const VAR_PATTERN = /\{\{[\t\n\f\r ]*([a-zA-Z0-9_]+)[\t\n\f\r ]*\}\}/g;

export function applyVars(s: string, vars: Record<string, string>): string {
  return s.replace(VAR_PATTERN, (m, name: string) => {
    const v = vars[name];
    return v !== undefined && v !== "" ? v : m;
  });
}

/** Variable names still present, first occurrence order; null (Go nil) when none. */
export function findUnresolved(s: string): string[] | null {
  const out: string[] = [];
  for (const m of s.matchAll(VAR_PATTERN)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out.length > 0 ? out : null;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").trim();
}

/** Lowercased, trimmed, de-duplicated. */
export function uniqueEmails(input: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const e = raw.trim().toLowerCase();
    if (e !== "" && !out.includes(e)) out.push(e);
  }
  return out;
}

export function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return ["", ""];
  return [parts[0]!, parts.slice(1).join(" ")];
}

/** fmt.Sscan into an int64: a leading optionally-signed integer token. */
export function parseInt64(s: string): number | null {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function buildRfc822(
  fromName: string,
  fromAddr: string,
  m: { toAddresses: string[]; ccAddresses: string[]; bccAddresses: string[]; subject: string; bodyHtml: string; bodyText: string },
): string {
  const from = fromName !== "" ? `${fromName} <${fromAddr}>` : fromAddr;
  let b = `From: ${from}\r\nTo: ${m.toAddresses.join(", ")}\r\n`;
  if (m.ccAddresses.length > 0) b += `Cc: ${m.ccAddresses.join(", ")}\r\n`;
  if (m.bccAddresses.length > 0) b += `Bcc: ${m.bccAddresses.join(", ")}\r\n`;
  b += `Subject: ${m.subject}\r\nMIME-Version: 1.0\r\n`;
  if (m.bodyHtml !== "") return `${b}Content-Type: text/html; charset=UTF-8\r\n\r\n${m.bodyHtml}`;
  return `${b}Content-Type: text/plain; charset=UTF-8\r\n\r\n${m.bodyText}`;
}

// ------------------------------------------------ net/mail approximations

/** RFC 2047 encoded words (=?charset?B|Q?text?=) in display names. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    const cs = charset.toLowerCase();
    const encoding = cs === "utf-8" || cs === "us-ascii" ? "utf8" : cs === "iso-8859-1" ? "latin1" : null;
    if (encoding === null) return whole;
    const bytes =
      enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(
            text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          );
    return bytes.toString(encoding);
  });
}

function validAddrSpec(addr: string): boolean {
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return false;
  return !/[\s<>(),;]/.test(addr) && !/\.\.|^\.|\.$/.test(addr.slice(at + 1));
}

/** mail.ParseAddress; null where Go returns an error. */
function parseMailAddress(raw: string): { name: string; address: string } | null {
  const s = raw.trim();
  const angle = /^(.*?)<([^<>]*)>$/s.exec(s);
  if (angle) {
    let name = angle[1]!.trim();
    const address = angle[2]!.trim();
    if (!validAddrSpec(address)) return null;
    if (name.startsWith('"')) {
      if (!name.endsWith('"') || name.length < 2) return null;
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return { name: decodeWords(name), address };
  }
  return validAddrSpec(s) ? { name: "", address: s } : null;
}

/** Splits on commas outside quotes and angle brackets. */
function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && quoted && i + 1 < raw.length) {
      cur += c + raw[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle++;
    else if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    if (c === "," && !quoted && angle === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function parseAddress(raw: string): { name: string; addr: string } {
  const s = raw.trim();
  if (s === "") return { name: "", addr: "" };
  const a = parseMailAddress(s);
  if (a === null) return { name: "", addr: s.toLowerCase() };
  return { name: a.name, addr: a.address.toLowerCase() };
}

export function parseAddressList(raw: string): string[] {
  if (raw.trim() === "") return [];
  const parsed = splitAddressList(raw).map(parseMailAddress);
  if (parsed.every((a) => a !== null)) return parsed.map((a) => a!.address.toLowerCase());
  return raw
    .split(",")
    .map((p) => parseAddress(p).addr)
    .filter((a) => a !== "");
}
