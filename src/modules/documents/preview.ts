import { extname } from "node:path";

/** File types browsers display without running anything. SVG and HTML are left out: they can carry scripts. */
const PREVIEW_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const PREVIEW_TYPES = new Set(Object.values(PREVIEW_BY_EXTENSION));

/**
 * The Content-Type to show a stored file inline with, or null when it may only be downloaded.
 * Files saved without a usable type fall back to their extension.
 */
export function inlineContentType(mimeType: string, name: string): string | null {
  const mime = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  let type: string | null = PREVIEW_TYPES.has(mime) ? mime : null;
  if (!type && (mime === "" || mime === "application/octet-stream")) {
    type = PREVIEW_BY_EXTENSION[extname(name).toLowerCase()] ?? null;
  }
  if (!type) return null;
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}
