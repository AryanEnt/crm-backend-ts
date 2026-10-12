/** Permission codes follow resource:action. */
export const P = {
  UsersView: "users:view",
  UsersCreate: "users:create",
  UsersEdit: "users:edit",
  UsersDelete: "users:delete",
  UsersAssign: "users:assign",
  UsersExport: "users:export",
  UsersManage: "users:manage",

  TeamsView: "teams:view",
  TeamsCreate: "teams:create",
  TeamsEdit: "teams:edit",
  TeamsDelete: "teams:delete",
  TeamsAssign: "teams:assign",
  TeamsManage: "teams:manage",

  RolesView: "roles:view",
  RolesManage: "roles:manage",

  AuditView: "audit:view",

  LeadsView: "leads:view",
  LeadsCreate: "leads:create",
  LeadsEdit: "leads:edit",
  LeadsDelete: "leads:delete",
  LeadsAssign: "leads:assign",
  LeadsExport: "leads:export",

  CustomersView: "customers:view",
  CustomersCreate: "customers:create",
  CustomersEdit: "customers:edit",
  CustomersDelete: "customers:delete",
  CustomersExport: "customers:export",

  DealsView: "deals:view",
  DealsCreate: "deals:create",
  DealsEdit: "deals:edit",
  DealsDelete: "deals:delete",
  DealsAssign: "deals:assign",
  DealsExport: "deals:export",

  PipelinesView: "pipelines:view",
  PipelinesManage: "pipelines:manage",

  ActivitiesView: "activities:view",
  ActivitiesCreate: "activities:create",
  ActivitiesEdit: "activities:edit",
  ActivitiesDelete: "activities:delete",

  DocumentsView: "documents:view",
  DocumentsCreate: "documents:create",
  DocumentsEdit: "documents:edit",
  DocumentsDelete: "documents:delete",

  AnalyticsView: "analytics:view",
  AnalyticsExport: "analytics:export",

  ForecastsView: "forecasts:view",
  TargetsView: "targets:view",
  TargetsManage: "targets:manage",

  PredictionsView: "predictions:view",
  PredictionsManage: "predictions:manage",

  AutomationsView: "automations:view",
  AutomationsManage: "automations:manage",

  CommunicationsView: "communications:view",
  CommunicationsSend: "communications:send",
  CommunicationsManage: "communications:manage",

  EmailView: "email:view",
  EmailSend: "email:send",
  EmailManage: "email:manage",
  EmailConfigure: "email:configure",

  ReferralsView: "referrals:view",
  ReferralsCreate: "referrals:create",
  ReferralsEdit: "referrals:edit",
  ReferralsManage: "referrals:manage",
  ReferralsConfigure: "referrals:configure",

  SettingsView: "settings:view",
  SettingsManage: "settings:manage",
  SystemView: "system:view",

  CustomFieldsView: "custom_fields:view",
  CustomFieldsManage: "custom_fields:manage",
  LeadSourcesView: "lead_sources:view",
  LeadSourcesManage: "lead_sources:manage",
  ActivityTypesView: "activity_types:view",
  ActivityTypesManage: "activity_types:manage",
} as const;

export const Role = {
  SuperAdmin: "super_admin",
  /** Team Lead */
  SalesManager: "sales_manager",
  SalesExecutive: "sales_executive",
  SalesSupport: "sales_support",
} as const;

/** Data scope of a permission grant (resource visibility). */
export type Scope = "own" | "team" | "organization";
export const Scope = { Own: "own", Team: "team", Organization: "organization" } as const;

/** "" means no scope, like Go's zero-value Scope. */
export type MaybeScope = Scope | "";

export interface Grant {
  code: string;
  scope: MaybeScope;
}

export type ScopeMap = Record<string, Scope>;

const IMPLIED_ACTIONS = ["view", "create", "edit", "delete", "assign", "export", "configure"];

function rank(s: MaybeScope | undefined): number {
  switch (s) {
    case "organization":
      return 3;
    case "team":
      return 2;
    case "own":
      return 1;
    default:
      return 0;
  }
}

/** Returns the broader of two scopes. */
export function widenScope<A extends MaybeScope | undefined, B extends MaybeScope | undefined>(a: A, b: B): A | B {
  return rank(b) > rank(a) ? b : a;
}

export function scopeFor(scopes: ScopeMap | undefined, code: string): MaybeScope {
  return scopes?.[code] ?? "";
}

function split(code: string): [string, string] | null {
  const i = code.indexOf(":");
  return i < 0 ? null : [code.slice(0, i), code.slice(i + 1)];
}

/** Expands :manage into implied actions, carrying scope forward. */
export function expandImpliesScoped(grants: Grant[]): ScopeMap {
  const out: ScopeMap = {};
  const widen = (code: string, scope: Scope) => {
    out[code] = widenScope(out[code], scope) ?? scope;
  };
  for (const g of grants) {
    const scope: Scope = g.scope === "" ? "organization" : g.scope;
    widen(g.code, scope);
    const parts = split(g.code);
    if (!parts || parts[1] !== "manage") continue;
    for (const a of IMPLIED_ACTIONS) widen(`${parts[0]}:${a}`, scope);
  }
  return out;
}

export class PermissionSet {
  private readonly codes: Set<string>;

  constructor(codes: Iterable<string> = []) {
    this.codes = new Set(codes);
  }

  has(code: string): boolean {
    return this.codes.has(code);
  }

  hasAny(...codes: string[]): boolean {
    return codes.some((c) => this.codes.has(c));
  }

  hasAll(...codes: string[]): boolean {
    return codes.every((c) => this.codes.has(c));
  }

  list(): string[] {
    return [...this.codes];
  }
}

/**
 * Treats :manage as implying other actions on the same resource.
 * It does not imply provider-specific actions such as communications:send.
 */
export function expandImplies(codes: string[]): PermissionSet {
  const out = new Set(codes);
  for (const code of codes) {
    const parts = split(code);
    if (!parts || parts[1] !== "manage") continue;
    for (const a of IMPLIED_ACTIONS) out.add(`${parts[0]}:${a}`);
  }
  return new PermissionSet(out);
}
