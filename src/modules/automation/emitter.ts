import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.js";
import { logger } from "../../logger.js";

export const AutomationEvent = {
  LeadCreated: "lead.created",
  LeadAssigned: "lead.assigned",
  LeadStageChanged: "lead.stage_changed",
  ActivityCompleted: "activity.completed",
  CustomerUpdated: "customer.updated",
  DealCreated: "deal.created",
  DealUpdated: "deal.updated",
  DealStageChanged: "deal.stage_changed",
  PipelineCreated: "pipeline.created",
  PipelineUpdated: "pipeline.updated",
} as const;

/**
 * Records domain events in automation_events for whichever automation worker is running
 * (this process's, or Go's, which polls every 5s). notify wakes the in-process worker.
 */
export class AutomationEmitter {
  constructor(
    private readonly db: Database,
    private readonly notify?: () => void,
  ) {}

  /** Never throws: Go callers discard the error after it is logged. */
  async emit(eventType: string, resourceType: string, resourceId: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.db
        .insertInto("automation_events")
        .values({
          id: randomUUID(),
          event_type: eventType,
          resource_type: resourceType,
          resource_id: resourceId === "" ? null : resourceId,
          payload: JSON.stringify(payload),
        })
        .execute();
    } catch (err) {
      logger.warn({ event: eventType, resource: resourceType, error: String(err) }, "automation emit failed");
      return;
    }
    this.notify?.();
  }

  /** For callers that insert automation_events themselves inside a transaction. */
  wake(): void {
    this.notify?.();
  }
}
