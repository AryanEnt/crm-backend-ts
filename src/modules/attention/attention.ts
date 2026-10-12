export const Attention = {
  NoNext: "no_next_activity",
  OverdueNext: "overdue_next",
  OverSla: "over_sla",
  AttentionNeeded: "attention_needed",
  NoRecentActivity: "no_recent_activity",
} as const;

const INACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read-time snapshot used to classify a record. Closed records (won, lost, archived,
 * converted, unqualified) return no code. anchor is when the current stage started;
 * createdAt is the fallback for "no recent activity".
 */
export interface AttentionInput {
  closed: boolean;
  next: Date | null;
  last: Date | null;
  anchor: Date | null;
  createdAt: Date;
  slaHours: number | null;
  now?: Date;
}

/** Precedence: closed, missing next, overdue next, stage SLA, then seven days without activity. */
export function computeAttention(in_: AttentionInput): string {
  if (in_.closed) return "";
  const now = (in_.now ?? new Date()).getTime();
  if (in_.next === null) return Attention.NoNext;
  if (in_.next.getTime() <= now) return Attention.OverdueNext;
  if (in_.slaHours !== null && in_.slaHours > 0 && in_.anchor !== null) {
    const hours = (now - in_.anchor.getTime()) / 3_600_000;
    if (hours > in_.slaHours) return Attention.OverSla;
    if (hours > in_.slaHours * 0.8) return Attention.AttentionNeeded;
  }
  const ref = in_.last ?? in_.createdAt;
  if (now - ref.getTime() > INACTIVE_WINDOW_MS) return Attention.NoRecentActivity;
  return "";
}

export function validAttention(code: string): boolean {
  return code === "" || (Object.values(Attention) as string[]).includes(code);
}

/** SQL equivalents. Queries must use the documented aliases and join pipeline_stages as ps where mentioned. */
export const AttentionSql = {
  lead: `CASE
    WHEN l.status IN ('won','lost','converted','archived','unqualified') OR l.is_archived THEN ''
    WHEN l.next_activity_at IS NULL THEN 'no_next_activity'
    WHEN l.next_activity_at <= NOW() THEN 'overdue_next'
    WHEN ps.sla_hours IS NOT NULL AND ps.sla_hours > 0 AND EXTRACT(EPOCH FROM (NOW() - COALESCE(l.stage_entered_at, l.updated_at))) / 3600 > ps.sla_hours THEN 'over_sla'
    WHEN ps.sla_hours IS NOT NULL AND ps.sla_hours > 0 AND EXTRACT(EPOCH FROM (NOW() - COALESCE(l.stage_entered_at, l.updated_at))) / 3600 > ps.sla_hours * 0.8 THEN 'attention_needed'
    WHEN COALESCE(l.last_activity_at, l.created_at) < NOW() - INTERVAL '7 days' THEN 'no_recent_activity'
    ELSE ''
  END`,
  customer: `CASE
    WHEN c.is_archived THEN ''
    WHEN c.next_follow_up_at IS NULL THEN 'no_next_activity'
    WHEN c.next_follow_up_at <= NOW() THEN 'overdue_next'
    WHEN COALESCE(c.last_contacted_at, c.created_at) < NOW() - INTERVAL '7 days' THEN 'no_recent_activity'
    ELSE ''
  END`,
  deal: `CASE
    WHEN d.status <> 'open' THEN ''
    WHEN d.next_activity_at IS NULL THEN 'no_next_activity'
    WHEN d.next_activity_at <= NOW() THEN 'overdue_next'
    WHEN ps.sla_hours IS NOT NULL AND ps.sla_hours > 0 AND EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 3600 > ps.sla_hours THEN 'over_sla'
    WHEN ps.sla_hours IS NOT NULL AND ps.sla_hours > 0 AND EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 3600 > ps.sla_hours * 0.8 THEN 'attention_needed'
    WHEN COALESCE(d.last_activity_at, d.created_at) < NOW() - INTERVAL '7 days' THEN 'no_recent_activity'
    ELSE ''
  END`,
} as const;
 