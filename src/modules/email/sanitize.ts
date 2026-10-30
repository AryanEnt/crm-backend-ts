const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const IFRAME = /<\/?(iframe|object|embed|link|meta|form|base)\b[^>]*>/gi;
const IMG = /<\/?img\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL = /\s+(href|src)\s*=\s*(['"]?)\s*javascript:[^'"\s>]+\2/gi;

/** Strips executable markup and remote images before storing or returning HTML email. */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(SCRIPT, "")
    .replace(STYLE, "")
    .replace(IFRAME, "")
    .replace(IMG, "")
    .replace(EVENT_ATTR, "")
    .replace(JS_URL, "");
}
