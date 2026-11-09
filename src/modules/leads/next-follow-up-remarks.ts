/** Stages that require a documented next follow-up plan (sales pipeline). */

const REQUIRED_STAGE_NAMES = new Set(["contacted", "negotiation", "purchased", "lost"]);

export function requiresNextFollowUpRemarks(stageName: string | null | undefined): boolean {
  return REQUIRED_STAGE_NAMES.has((stageName ?? "").trim().toLowerCase());
}

/** Empty when blank; otherwise null (valid). Kept light so SEs can update quickly. */
export function nextFollowUpRemarksProblem(text: string): string | null {
  if (text.trim() === "") return "Next follow-up remarks are required";
  if (text.trim().length > 2000) return "Keep next follow-up remarks under 2,000 characters";
  return null;
}
