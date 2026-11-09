/** Contacted-stage star rating + mandatory remarks helpers. */

export const CONTACT_RATING_MIN = 1;
export const CONTACT_RATING_MAX = 5;
export const CONTACT_REMARKS_MIN_UNIQUE_WORDS = 5;

export function isContactedStage(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "contacted";
}

/** Words split on whitespace; empty tokens dropped. */
export function contactRemarkWords(text: string): string[] {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Remarks need at least 5 different words. Repeating the same word to pad the
 * count does not satisfy the minimum.
 */
export function validContactRemarks(text: string): boolean {
  const words = contactRemarkWords(text);
  if (words.length < CONTACT_REMARKS_MIN_UNIQUE_WORDS) return false;
  return new Set(words).size >= CONTACT_REMARKS_MIN_UNIQUE_WORDS;
}

export function contactRemarksProblem(text: string): string | null {
  const words = contactRemarkWords(text);
  if (words.length === 0) return "Remarks are required";
  if (words.length < CONTACT_REMARKS_MIN_UNIQUE_WORDS) {
    return `Remarks need at least ${CONTACT_REMARKS_MIN_UNIQUE_WORDS} words`;
  }
  if (new Set(words).size < CONTACT_REMARKS_MIN_UNIQUE_WORDS) {
    return `Remarks need at least ${CONTACT_REMARKS_MIN_UNIQUE_WORDS} different words (repeats don't count)`;
  }
  return null;
}

export function parseContactRating(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < CONTACT_RATING_MIN || n > CONTACT_RATING_MAX) return null;
  return n;
}
