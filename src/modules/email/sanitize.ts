const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const IFRAME = /<\/?(iframe|object|embed|link|meta|form|base)\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL = /\s+(href|src)\s*=\s*(['"]?)\s*javascript:[^'"\s>]+\2/gi;

/** True when img src is safe to keep (embedded / cid). Remote http(s) images are dropped (tracking). */
function isSafeImgSrc(src: string): boolean {
  const s = src.trim().toLowerCase();
  return s.startsWith("data:image/") || s.startsWith("cid:");
}

/** Strips executable markup and remote images before storing or returning HTML email. */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(SCRIPT, "")
    .replace(STYLE, "")
    .replace(IFRAME, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? /\bsrc\s*=\s*([^\s>]+)/i.exec(tag)?.[1] ?? "";
      return isSafeImgSrc(src) ? tag : "";
    })
    .replace(EVENT_ATTR, "")
    .replace(JS_URL, "");
}
