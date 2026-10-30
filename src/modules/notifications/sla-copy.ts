/** Human-readable stage-SLA wording shared by the scan and tests. */

export const SLA_NOTIFICATION_TYPE = "lead_sla_exceeded";

export function slaDedupeKey(leadId: string, stageId: string, stageEnteredAt: Date): string {
  return `lead_sla:${leadId}:${stageId}:${stageEnteredAt.toISOString()}`;
}

/** Whole days from elapsed hours, at least 1 once the SLA has been exceeded. */
export function daysFromHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.max(1, Math.round(hours / 24));
}

export function slaLimitDays(slaHours: number): number {
  if (!Number.isFinite(slaHours) || slaHours <= 0) return 0;
  return Math.max(1, Math.round(slaHours / 24));
}

export function dayLabel(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

export function slaExceededCopy(input: {
  leadName: string;
  stageName: string;
  hoursInStage: number;
  slaHours: number;
  ownerName: string;
}): { title: string; body: string } {
  const inStage = daysFromHours(input.hoursInStage);
  const limit = slaLimitDays(input.slaHours);
  const over = Math.max(1, inStage - limit);
  const stage = input.stageName.trim() || "this stage";
  const lead = input.leadName.trim() || "this lead";
  const limitAdj = limit === 1 ? "1-day" : `${limit}-day`;
  return {
    title: "Lead SLA exceeded",
    body: `${lead} has remained in ${stage} for ${dayLabel(inStage)}, exceeding its ${limitAdj} SLA by ${dayLabel(over)}.`,
  };
}
