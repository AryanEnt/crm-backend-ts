import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { Database } from "./db/database.js";
import { cors } from "./middleware/cors.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { goProxy } from "./middleware/go-proxy.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { activitiesRouter } from "./modules/activities/activities.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { AnalyticsService } from "./modules/analytics/analytics.service.js";
import { ActivitiesService } from "./modules/activities/activities.service.js";
import { ActivityTypesService } from "./modules/activities/activity-types.service.js";
import { AnzscoService, anzscoRouter } from "./modules/anzsco/anzsco.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { AuthRepository } from "./modules/auth/auth.repository.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { createGuard } from "./modules/auth/guard.js";
import { callsRouter } from "./modules/calls/calls.routes.js";
import { CallsService } from "./modules/calls/calls.service.js";
import { JwtService } from "./modules/auth/tokens.js";
import { AutomationRepository } from "./modules/automation/automation.repository.js";
import { automationRouter } from "./modules/automation/automation.routes.js";
import { AutomationService } from "./modules/automation/automation.service.js";
import { AutomationEmitter } from "./modules/automation/emitter.js";
import { communicationsRouter } from "./modules/communications/communications.routes.js";
import { CommunicationsService } from "./modules/communications/communications.service.js";
import { customFieldsRouter } from "./modules/custom-fields/custom-fields.routes.js";
import { customersRouter } from "./modules/customers/customers.routes.js";
import { CustomersService } from "./modules/customers/customers.service.js";
import { CustomFieldsService } from "./modules/custom-fields/custom-fields.service.js";
import { dealsRouter } from "./modules/deals/deals.routes.js";
import { DealsService } from "./modules/deals/deals.service.js";
import { documentsRouter } from "./modules/documents/documents.routes.js";
import { emailRouter } from "./modules/email/email.routes.js";
import { EmailService } from "./modules/email/email.service.js";
import { ForecastingService, forecastingRouter } from "./modules/forecasting/forecasting.js";
import { predictionsRouter } from "./modules/predictions/predictions.routes.js";
import { PredictionsService } from "./modules/predictions/predictions.service.js";
import { targetsRouter } from "./modules/targets/targets.routes.js";
import { TargetsService } from "./modules/targets/targets.service.js";
import { DocumentsService } from "./modules/documents/documents.service.js";
import { referralsRouter } from "./modules/referrals/referrals.routes.js";
import { createR2Store } from "./modules/storage/r2.js";
import { createStore, type Store } from "./modules/storage/storage.js";
import { teamsRouter } from "./modules/teams/teams.routes.js";
import { TeamsService } from "./modules/teams/teams.service.js";
import { timelineRouter } from "./modules/timeline/timeline.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { UsersService } from "./modules/users/users.service.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { leadSourcesRouter } from "./modules/lead-sources/lead-sources.routes.js";
import { leadInsightsRouter } from "./modules/leads/lead-insights.routes.js";
import { LeadInsightsService } from "./modules/leads/lead-insights.service.js";
import { LeadStageService } from "./modules/leads/lead-stage.service.js";
import { ActivityPromptsService } from "./modules/activities/activity-prompts.service.js";
import { leadsRouter } from "./modules/leads/leads.routes.js";
import { LeadsService } from "./modules/leads/leads.service.js";
import { ReferralsService } from "./modules/referrals/referrals.service.js";
import { TimelineService } from "./modules/timeline/timeline.service.js";
import { LeadSourcesService } from "./modules/lead-sources/lead-sources.service.js";
import { pipelinesRouter } from "./modules/pipelines/pipelines.routes.js";
import { PipelinesService } from "./modules/pipelines/pipelines.service.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { SettingsService } from "./modules/settings/settings.service.js";
import { systemActivityRouter } from "./modules/system-activity/system-activity.routes.js";
import { SystemActivityService } from "./modules/system-activity/system-activity.service.js";
import { notificationsRouter } from "./modules/notifications/notifications.routes.js";
import { NotificationsService } from "./modules/notifications/notifications.service.js";

export interface AppDeps {
  config: Config;
  db: Database;
  /** Defaults to the driver in config. */
  store?: Store;
  /** Wakes the in-process automation worker when events are emitted or jobs retried. */
  automationWake?: () => void;
}

export function createApp({ config, db, store = createStore(config.storageDriver, config.storageRoot), automationWake }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(requestId, requestLogger, cors(config.corsOrigins), cookieParser());

  const authService = new AuthService(new AuthRepository(db), new JwtService(config.jwtSecret));
  const guard = createGuard(authService);
  const audit = new AuditService(db);
  const automation = new AutomationEmitter(db, automationWake);
  const systemActivity = new SystemActivityService(db);

  app.use(healthRouter(db));
  app.use(authRouter(authService, config));
  app.use(usersRouter(new UsersService(db, audit), guard));
  app.use(teamsRouter(new TeamsService(db, audit), guard));
  app.use(auditRouter(audit, guard));
  app.use(systemActivityRouter(systemActivity, guard));
  app.use(leadSourcesRouter(new LeadSourcesService(db, audit), guard));
  app.use(settingsRouter(new SettingsService(db, audit), guard));
  app.use(notificationsRouter(new NotificationsService(db), guard));
  app.use(anzscoRouter(new AnzscoService(db), guard));
  const customFields = new CustomFieldsService(db, audit);
  const timeline = new TimelineService(db);
  const referrals = new ReferralsService(db, audit);
  app.use(customFieldsRouter(customFields, db, guard));
  const pipelines = new PipelinesService(db, audit, automation);
  app.use(pipelinesRouter(pipelines, guard));
  const activityTypes = new ActivityTypesService(db, audit);
  const activities = new ActivitiesService(db, activityTypes.repo, audit, timeline, automation, systemActivity);
  const leadStages = new LeadStageService(db, pipelines.repo, activities, () => automation.wake());
  const leads = new LeadsService(db, audit, timeline, automation, referrals, customFields, systemActivity, leadStages, activities);
  app.use(leadInsightsRouter(new LeadInsightsService(db, pipelines.repo), guard));
  app.use(leadsRouter(leads, db, guard));
  const customers = new CustomersService(db, leads.repo, audit, timeline, automation, referrals, customFields, systemActivity);
  app.use(customersRouter(customers, db, guard));
  const activityPrompts = new ActivityPromptsService(db, activities, leadStages, pipelines.repo);
  activities.setLeadAdvancer((actorId, leadId, meta) => activityPrompts.contactMade(actorId, leadId, meta));
  app.use(activitiesRouter(activities, activityTypes, activityPrompts, db, guard));
  const deals = new DealsService(db, pipelines, audit, automation, timeline, systemActivity, activities);
  app.use(dealsRouter(deals, db, guard));
  app.use(callsRouter(new CallsService(db, leads.repo, customers.repo, timeline), guard));
  const screenshots = createR2Store({
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucket: config.r2Bucket,
    endpoint: config.r2Endpoint,
  });
  app.use(documentsRouter(new DocumentsService(db, store, audit, timeline, automation, screenshots), db, guard));
  app.use(referralsRouter(referrals, guard));
  app.use(timelineRouter(timeline, guard));
  app.use(analyticsRouter(new AnalyticsService(db), guard));
  app.use(targetsRouter(new TargetsService(db, audit), guard));
  app.use(forecastingRouter(new ForecastingService(db), guard));
  app.use(predictionsRouter(new PredictionsService(db), db, guard));
  app.use(automationRouter(new AutomationService(new AutomationRepository(db), audit, automationWake), guard));
  app.use(
    communicationsRouter(
      new CommunicationsService(db, timeline, audit, config.publicApiUrl, {
        appId: config.metaAppId,
        appSecret: config.metaAppSecret,
        configId: config.metaWhatsAppConfigId,
        verifyToken: config.metaWhatsAppVerifyToken,
        graphApiVersion: config.metaGraphApiVersion,
        publicApiUrl: config.publicApiUrl,
      }),
      guard,
    ),
  );
  app.use(emailRouter(new EmailService(db, config, audit, timeline), guard));

  // Everything not ported yet is served by the Go backend.
  if (config.goBackendUrl) app.use(goProxy(config.goBackendUrl));
  else app.use(notFound);

  app.use(errorHandler);
  return app;
}
