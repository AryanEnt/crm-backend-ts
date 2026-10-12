import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.js";
import { pgxMessage } from "../../lib/pgx.js";
import { logger } from "../../logger.js";
import { AuditService } from "../audit/audit.service.js";
import {
  matchConditions,
  PAYLOAD_AUTOMATION_DEPTH,
  PAYLOAD_SUPPRESS_AUTOMATION,
  Trigger,
} from "./automation.definition.js";
import { AutomationExecutor } from "./automation.executor.js";
import { AutomationRepository, rfc3339, type Automation, type Job, type Run } from "./automation.repository.js";
import { AutomationEmitter } from "./emitter.js";

const TICK_MS = 5_000;
const SCAN_MS = 60_000;
const BATCH = 25;
const INACTIVE_DEAL_DAYS = 14;
const INACTIVE_LEAD_DAYS = 14;

/** A worker wired to the database, with its scan events waking itself. */
export function createAutomationWorker(db: Database): AutomationWorker {
  const repo = new AutomationRepository(db);
  const worker = new AutomationWorker(repo, new AutomationExecutor(db, repo, new AuditService(db)));
  worker.setEmitter(new AutomationEmitter(db, worker.wake));
  return worker;
}

/**
 * Claims domain events, queues a job per matching active automation, evaluates IF,
 * executes THEN, and logs every run. Work is serialized: one tick at a time, and a
 * wake-up during a tick schedules exactly one more.
 */
export class AutomationWorker {
  private readonly id = `api-worker-${randomUUID().slice(0, 8)}`;
  private queue: Promise<void> = Promise.resolve();
  private tickQueued = false;
  private stopped = true;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly repo: AutomationRepository,
    private readonly executor: AutomationExecutor,
    private emitter: AutomationEmitter | null = null,
  ) {}

  /** The emitter used for synthetic scan events (its notify should call wake). */
  setEmitter(emitter: AutomationEmitter): void {
    this.emitter = emitter;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
    this.timers = [
      setInterval(this.wake, TICK_MS),
      setInterval(() => this.enqueue(async () => {
        await this.scanSynthetic();
        await this.tick();
      }), SCAN_MS),
    ];
    logger.info({ worker: this.id }, "automation worker started");
  }

  /** Stops scheduling and waits for in-flight work. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.queue;
  }

  readonly wake = (): void => {
    if (this.stopped || this.tickQueued) return;
    this.tickQueued = true;
    this.enqueue(async () => {
      this.tickQueued = false;
      await this.tick();
    });
  };

  private enqueue(fn: () => Promise<void>): void {
    if (this.stopped) return;
    this.queue = this.queue.then(fn).catch((err: unknown) => logger.warn({ error: pgxMessage(err) }, "automation worker tick failed"));
  }

  async tick(): Promise<void> {
    await this.processEvents();
    await this.processJobs();
  }

  private async processEvents(): Promise<void> {
    let events;
    try {
      events = await this.repo.claimPendingEvents(this.id, BATCH);
    } catch (err) {
      logger.warn({ error: pgxMessage(err) }, "automation claim events failed");
      return;
    }
    for (const ev of events) {
      const depth = ev.payload[PAYLOAD_AUTOMATION_DEPTH];
      if (ev.payload[PAYLOAD_SUPPRESS_AUTOMATION] === true || (typeof depth === "number" && Math.trunc(depth) > 0)) {
        await this.repo.markEventProcessed(ev.id).catch(() => undefined);
        continue;
      }
      let rules: Automation[];
      try {
        rules = await this.repo.listActiveByTrigger(ev.eventType);
      } catch (err) {
        await this.repo.markEventFailed(ev.id, pgxMessage(err)).catch(() => undefined);
        continue;
      }
      for (const rule of rules) {
        await this.repo.enqueueJob(ev.id, rule, ev.resourceType, ev.resourceId, ev.payload).catch((err: unknown) => {
          logger.warn({ automation: rule.id, error: pgxMessage(err) }, "automation enqueue failed");
        });
      }
      await this.repo.markEventProcessed(ev.id).catch(() => undefined);
    }
  }

  private async processJobs(): Promise<void> {
    let jobs: Job[];
    try {
      jobs = await this.repo.claimJobs(this.id, BATCH);
    } catch (err) {
      logger.warn({ error: pgxMessage(err) }, "automation claim jobs failed");
      return;
    }
    for (const job of jobs) {
      const error = await this.runJob(job).catch((err: unknown) => pgxMessage(err));
      // Go passes the pre-claim attempt count, so a job exhausts as "failed", never "dead".
      if (error !== null) await this.repo.failJob(job.id, error, job.maxAttempts, job.attempts).catch(() => undefined);
      else await this.repo.completeJob(job.id).catch(() => undefined);
    }
  }

  /** Runs one job and logs the run; returns the failure message, or null on success. */
  async runJob(job: Job): Promise<string | null> {
    if (job.automationId === null) return "job missing automation";
    const auto = await this.repo.get(job.automationId).catch(() => null);
    if (!auto) return "automation not found";

    const run = (fields: Partial<Run>): Run => ({
      automationId: auto.id,
      automationName: auto.name,
      jobId: job.id,
      eventId: job.eventId,
      triggerType: auto.triggerType,
      resourceType: job.resourceType,
      resourceId: job.resourceId,
      conditions: auto.conditions,
      conditionsMatched: false,
      actions: auto.actions,
      actionResults: [],
      status: "skipped",
      errorMessage: "",
      ...fields,
    });
    const log = (r: Run) => this.repo.insertRun(r).catch((err: unknown) => logger.warn({ error: pgxMessage(err) }, "automation run log failed"));

    if (!auto.isActive) {
      await this.repo.insertRun(run({ errorMessage: "automation inactive" })).catch(() => undefined);
      return null;
    }
    const resourceId = job.resourceId ?? "";
    let ctx: Record<string, unknown> = {};
    if (resourceId !== "") {
      try {
        ctx = await this.repo.loadEntityContext(job.resourceType, resourceId);
      } catch (err) {
        const message = pgxMessage(err);
        await this.repo.insertRun(run({ conditionsMatched: true, status: "failed", errorMessage: message })).catch(() => undefined);
        return message;
      }
    }
    // Event payload facts fill in without overwriting entity facts.
    for (const [k, v] of Object.entries(job.payload)) {
      if (!(k in ctx)) ctx[k] = v;
    }

    const { matched, detail } = matchConditions(auto.conditions, ctx);
    if (!matched) {
      await this.repo.insertRun(run({ errorMessage: detail })).catch(() => undefined);
      return null;
    }

    const { results, error } = await this.executor.execute(auto, ctx, job.resourceType, resourceId);
    let status = error ? "failed" : "succeeded";
    let errorMessage = error;
    for (const r of results) {
      if (r.status === "failed") {
        status = "failed";
        if (errorMessage === "") errorMessage = r.error ?? "";
      }
    }
    await log(run({ conditionsMatched: true, actionResults: results, status, errorMessage }));
    return status === "failed" ? errorMessage : null;
  }

  /** Emits activity.overdue, lead.inactive and deal.inactive events for records nobody touched. */
  async scanSynthetic(): Promise<void> {
    if (!this.emitter) return;
    try {
      for (const id of await this.repo.findOverdueActivities(50)) {
        await this.emitter.emit(Trigger.ActivityOverdue, "activity", id, { scannedAt: rfc3339(new Date()) });
      }
    } catch (err) {
      logger.warn({ error: pgxMessage(err) }, "overdue scan failed");
    }
    try {
      for (const id of await this.repo.findInactiveLeads(INACTIVE_LEAD_DAYS, 50)) {
        await this.emitter.emit(Trigger.LeadInactive, "lead", id, { inactivityDays: INACTIVE_LEAD_DAYS, scannedAt: rfc3339(new Date()) });
      }
    } catch (err) {
      logger.warn({ error: pgxMessage(err) }, "inactive lead scan failed");
    }
    try {
      for (const id of await this.repo.findInactiveDeals(INACTIVE_DEAL_DAYS, 50)) {
        await this.emitter.emit(Trigger.DealInactive, "deal", id, { inactivityDays: INACTIVE_DEAL_DAYS, scannedAt: rfc3339(new Date()) });
      }
    } catch (err) {
      logger.warn({ error: pgxMessage(err) }, "inactive deal scan failed");
    }
  }
}
