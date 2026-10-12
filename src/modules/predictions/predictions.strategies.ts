import { goFixed } from "../../lib/go-fmt.js";
import { goSortKeys } from "../../lib/go-json.js";

export const DISCLAIMER = "Predictions are estimates based on CRM data. They are not guaranteed outcomes.";
export const INSUFFICIENT_HISTORICAL_DATA = "Insufficient historical data.";
export const MIN_HISTORICAL_SAMPLE = 10;

export type Features = Record<string, unknown>;

export interface FeatureSet {
  entityType: string;
  entityId: string;
  /** Built with sorted keys, as Go encodes map[string]any. */
  features: Features;
}

/** A single explained contribution to a score or insight. */
export interface Signal {
  code: string;
  label: string;
  /** Positive or negative points. */
  impact: number;
  /** positive | negative | neutral */
  polarity: string;
  detail?: string;
}

/** null mirrors a Go nil slice, which encodes as JSON null. */
export interface Explanation {
  summary: string;
  positiveSignals: Signal[] | null;
  negativeSignals: Signal[] | null;
  neutralNotes: string[] | null;
}

export interface PredictionResult {
  available: boolean;
  message: string;
  disclaimer: string;
  insightType: string;
  entityType: string;
  entityId: string;
  score: number | null;
  label: string;
  strategyCode: string;
  strategyVersion: string;
  features: Features;
  explanation: Explanation;
  payload: Record<string, unknown> | null;
  computedAt: string;
  insufficientHistoricalData: boolean;
}

export interface Strategy {
  code: string;
  version: string;
  insightType: string;
  score(fs: FeatureSet): PredictionResult;
}

/** Go time.Now().UTC().Format(time.RFC3339). */
export const rfc3339Now = (d = new Date()) => d.toISOString().slice(0, 19) + "Z";

const round2 = (v: number) => (v < 0 ? -Math.round(-v * 100) : Math.round(v * 100)) / 100;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const asFloat = (v: unknown) => (typeof v === "number" ? v : 0);
const asInt = (v: unknown) => Math.trunc(asFloat(v));
const asString = (v: unknown) => (typeof v === "string" ? v : "");
const asBool = (v: unknown) => v === true;
const f0 = (v: number) => goFixed(v, 0);

// JSON shapes (Go struct order, omitempty rules).

export function signalJson(s: Signal): Record<string, unknown> {
  const out: Record<string, unknown> = { code: s.code, label: s.label, impact: s.impact, polarity: s.polarity };
  if (s.detail) out.detail = s.detail;
  return out;
}

export function explanationJson(e: Explanation): Record<string, unknown> {
  const out: Record<string, unknown> = {
    summary: e.summary,
    positiveSignals: e.positiveSignals?.map(signalJson) ?? null,
    negativeSignals: e.negativeSignals?.map(signalJson) ?? null,
  };
  if (e.neutralNotes && e.neutralNotes.length > 0) out.neutralNotes = e.neutralNotes;
  return out;
}

export function resultJson(r: PredictionResult): Record<string, unknown> {
  const out: Record<string, unknown> = { available: r.available };
  if (r.message !== "") out.message = r.message;
  out.disclaimer = r.disclaimer;
  out.insightType = r.insightType;
  out.entityType = r.entityType;
  out.entityId = r.entityId;
  if (r.score !== null) out.score = r.score;
  out.label = r.label;
  out.strategyCode = r.strategyCode;
  out.strategyVersion = r.strategyVersion;
  out.features = r.features;
  out.explanation = explanationJson(r.explanation);
  if (r.payload && Object.keys(r.payload).length > 0) out.payload = goSortKeys(r.payload);
  out.computedAt = r.computedAt;
  out.insufficientHistoricalData = r.insufficientHistoricalData;
  return out;
}

function baseResult(s: Omit<Strategy, "score">, fs: FeatureSet): PredictionResult {
  return {
    available: false,
    message: "",
    disclaimer: DISCLAIMER,
    insightType: s.insightType,
    entityType: fs.entityType,
    entityId: fs.entityId,
    score: null,
    label: "",
    strategyCode: s.code,
    strategyVersion: s.version,
    features: fs.features,
    explanation: { summary: "", positiveSignals: [], negativeSignals: [], neutralNotes: null },
    payload: {},
    computedAt: rfc3339Now(),
    insufficientHistoricalData: false,
  };
}

const sig = (code: string, label: string, impact: number, polarity: string, detail?: string): Signal =>
  detail === undefined ? { code, label, impact, polarity } : { code, label, impact, polarity, detail };

/** Appends to a Go nil slice (null) or an existing list. */
const push = (list: Signal[] | null, s: Signal): Signal[] => [...(list ?? []), s];

export const LeadScoreStrategy: Strategy = {
  code: "lead_score_rules_v1",
  version: "1",
  insightType: "lead_score",
  score(fs) {
    const f = fs.features;
    let score = 45;
    const pos: Signal[] = [];
    const neg: Signal[] = [];
    const add = (list: Signal[], code: string, label: string, impact: number, detail: string) => {
      const pol = impact < 0 ? "negative" : impact === 0 ? "neutral" : "positive";
      list.push(sig(code, label, impact, pol, detail));
      score += impact;
    };

    const stage = asString(f.stageName).toLowerCase();
    const status = asString(f.status).toLowerCase();
    if (status === "qualified" || stage.includes("qualif")) add(pos, "stage_qualified", "Advanced / qualified stage", 15, stage);
    else if (stage.includes("contact")) add(pos, "stage_contacted", "Lead has been contacted", 8, stage);
    else if (stage.includes("unqualif") || status === "unqualified") add(neg, "stage_unqualified", "Unqualified stage", -20, stage);
    else if (stage !== "") add(pos, "stage_known", "Stage assigned", 3, stage);

    const source = asString(f.source);
    if (source !== "") add(pos, "source_known", "Source captured", 4, source);
    const sample = asInt(f.sourceClosedSample);
    const insuffHist = sample < MIN_HISTORICAL_SAMPLE;
    if (!insuffHist) {
      const rate = asFloat(f.sourceConversionRate);
      if (rate >= 40) {
        add(pos, "hist_source_conversion", "Historical conversion behavior for source", 10, `${f0(rate)}% of ${sample} similar leads converted`);
      } else if (rate > 0 && rate < 15) {
        add(neg, "hist_source_low", "Low historical conversion for source", -8, `${f0(rate)}% of ${sample} similar leads converted`);
      }
    }

    const daysInactive = asFloat(f.daysSinceActivity);
    const act7 = asInt(f.activityCount7d);
    if (act7 > 0 || daysInactive <= 3) {
      add(pos, "recently_contacted", "Recently contacted", 12, `${f0(daysInactive)} days since last activity`);
    } else if (daysInactive <= 7) {
      add(pos, "recent_activity", "Activity within a week", 6, `${f0(daysInactive)} days since last activity`);
    } else if (daysInactive > 14) {
      add(neg, "inactivity", "Inactivity", -15, `No activity for ${f0(daysInactive)} days`);
    } else if (daysInactive > 7) {
      add(neg, "cooling", "Cooling engagement", -8, `${f0(daysInactive)} days since last activity`);
    }

    const completed = asInt(f.completedActivities);
    if (completed >= 3) add(pos, "high_engagement", "High-engagement activity", 10, `${completed} completed activities`);
    else if (completed >= 1) add(pos, "response_behavior", "Response behavior recorded", 6, `${completed} completed activities`);

    const overdue = asInt(f.overdueFollowups);
    if (overdue > 0) add(neg, "follow_up_overdue", "Follow-up overdue", -12, `${overdue} overdue follow-ups`);

    const completeness = asFloat(f.profileCompletenessPct);
    if (completeness >= 70) add(pos, "profile_complete", "Strong profile completeness", 12, `${f0(completeness)}% complete`);
    else if (completeness >= 40) add(pos, "profile_partial", "Partial profile completeness", 5, `${f0(completeness)}% complete`);
    else add(neg, "profile_thin", "Thin profile", -6, `${f0(completeness)}% complete`);

    if (asBool(f.hasAnzsco)) add(pos, "anzsco", "ANZSCO occupation linked", 5, asString(f.anzscoCode));

    const docsVerified = asInt(f.docsVerified);
    const docsUploaded = asInt(f.docsUploaded);
    const docsRequested = asInt(f.docsRequested);
    if (docsVerified > 0) add(pos, "documents_verified", "Documents verified", 12, `${docsVerified} verified`);
    else if (docsUploaded > 0) add(pos, "documents_received", "Documents received", 8, `${docsUploaded} uploaded`);
    else if (docsRequested > 0) add(neg, "documents_pending", "Documents still outstanding", -5, `${docsRequested} requested/missing`);

    const age = asInt(f.ageDays);
    if (age > 60) add(neg, "deal_age", "Lead age elevated", -10, `${age} days old`);
    else if (age > 30) add(neg, "deal_age_moderate", "Lead aging", -5, `${age} days old`);

    score = clamp(round2(score), 0, 100);
    const label = score >= 75 ? "Hot" : score >= 50 ? "Warm" : score >= 30 ? "Cool" : "Cold";
    const notes = insuffHist
      ? [INSUFFICIENT_HISTORICAL_DATA + " Historical source conversion was not applied as a scored signal."]
      : [];

    return {
      ...baseResult(this, fs),
      available: true,
      score,
      label,
      explanation: {
        summary: `Score: ${f0(score)} — ${label.toLowerCase()} lead based on configurable CRM signals.`,
        positiveSignals: pos,
        negativeSignals: neg,
        neutralNotes: notes,
      },
      payload: { band: label },
      insufficientHistoricalData: insuffHist,
    };
  },
};

export const ConversionLikelihoodStrategy: Strategy = {
  code: "conversion_likelihood_v1",
  version: "1",
  insightType: "conversion_likelihood",
  score(fs) {
    const f = fs.features;
    // Deal features carry pipelineClosedSample instead.
    let sample = asInt(f.sourceClosedSample);
    if (sample === 0) sample = asInt(f.pipelineClosedSample);
    const res = baseResult(this, fs);
    if (sample < MIN_HISTORICAL_SAMPLE) {
      res.message = INSUFFICIENT_HISTORICAL_DATA;
      res.insufficientHistoricalData = true;
      res.explanation.summary = INSUFFICIENT_HISTORICAL_DATA;
      res.explanation.neutralNotes = [`Need at least ${MIN_HISTORICAL_SAMPLE} closed historical records; found ${sample}.`];
      return res;
    }

    let baseRate = asFloat(f.sourceConversionRate);
    if (baseRate === 0) baseRate = asFloat(f.pipelineWinRate);
    let likelihood = baseRate;
    let pos: Signal[] | null = null;
    let neg: Signal[] | null = null;
    if (asInt(f.activityCount7d) > 0 || asFloat(f.daysSinceActivity) <= 7) {
      likelihood += 8;
      pos = push(pos, sig("recent_activity", "Recent engagement", 8, "positive"));
    }
    if (asInt(f.overdueFollowups) > 0) {
      likelihood -= 10;
      neg = push(neg, sig("overdue", "Overdue follow-up", -10, "negative"));
    }
    if (asFloat(f.profileCompletenessPct) >= 70 || asInt(f.docsVerified) > 0) {
      likelihood += 6;
      pos = push(pos, sig("readiness", "Profile/docs readiness", 6, "positive"));
    }
    likelihood = clamp(round2(likelihood), 0, 100);
    res.available = true;
    res.score = likelihood;
    res.label = `${f0(likelihood)}% estimated conversion likelihood`;
    res.explanation = {
      summary: res.label + " (estimate from historical rates + current signals).",
      positiveSignals: pos,
      negativeSignals: neg,
      neutralNotes: [`Historical sample size: ${sample}`, `Baseline rate: ${goFixed(baseRate, 1)}%`],
    };
    res.payload = { baselineRate: baseRate, sampleSize: sample };
    return res;
  },
};

export const StalledOpportunityStrategy: Strategy = {
  code: "stalled_opportunity_v1",
  version: "1",
  insightType: "stalled_opportunity",
  score(fs) {
    const f = fs.features;
    const res = baseResult(this, fs);
    let days = asInt(f.daysInStage);
    if (days === 0) days = asInt(f.ageDays);
    const sla = asInt(f.slaHours);
    let inactive = asFloat(f.daysSinceActivity);
    if (inactive === 0 && asInt(f.activityCount30d) === 0) inactive = days;
    let risk = 0;
    let pos: Signal[] | null = null;
    let neg: Signal[] | null = null;
    if (days >= 14) {
      risk += 35;
      neg = push(neg, sig("long_stage", "Long time in stage", -35, "negative", `${days} days in current stage`));
    }
    if (sla > 0 && days * 24 > sla) {
      risk += 25;
      neg = push(neg, sig("over_sla", "Past stage SLA", -25, "negative"));
    }
    if (inactive >= 14 || asInt(f.activityCount30d) === 0) {
      risk += 25;
      neg = push(neg, sig("no_recent_activity", "No recent activity", -25, "negative"));
    }
    if (asInt(f.overdueFollowups) > 0) {
      risk += 15;
      neg = push(neg, sig("overdue", "Follow-up overdue", -15, "negative"));
    }
    if (asInt(f.activityCount30d) >= 3) {
      risk -= 15;
      pos = push(pos, sig("active", "Active engagement", 15, "positive"));
    }
    risk = clamp(round2(risk), 0, 100);
    const label = risk >= 70 ? "Likely stalled" : risk >= 40 ? "At risk of stalling" : "Healthy pace";
    res.available = true;
    res.score = risk;
    res.label = label;
    res.explanation = {
      summary: `${label} (stall risk score ${f0(risk)}).`,
      positiveSignals: pos,
      negativeSignals: neg,
      neutralNotes: null,
    };
    res.payload = { daysInStage: days, stallRisk: risk };
    return res;
  },
};

export const FollowUpRiskStrategy: Strategy = {
  code: "follow_up_risk_v1",
  version: "1",
  insightType: "follow_up_risk",
  score(fs) {
    const f = fs.features;
    const res = baseResult(this, fs);
    let risk = 20;
    let pos: Signal[] | null = null;
    let neg: Signal[] | null = null;
    const overdue = asInt(f.overdueFollowups);
    if (overdue > 0) {
      risk += 40;
      neg = push(neg, sig("follow_up_overdue", "Follow-up overdue", -40, "negative", `${overdue} overdue`));
    }
    const days = asFloat(f.daysSinceActivity);
    if (days > 10) {
      risk += 25;
      neg = push(neg, sig("inactivity", "Inactivity", -25, "negative", `${f0(days)} days quiet`));
    }
    if (asBool(f.hasNextActivity)) {
      risk -= 20;
      pos = push(pos, sig("next_planned", "Next activity planned", 20, "positive"));
    }
    if (asInt(f.activityCount7d) > 0) {
      risk -= 15;
      pos = push(pos, sig("recent", "Recently contacted", 15, "positive"));
    }
    risk = clamp(round2(risk), 0, 100);
    const label = risk >= 60 ? "High follow-up risk" : risk >= 35 ? "Elevated follow-up risk" : "Follow-up on track";
    res.available = true;
    res.score = risk;
    res.label = label;
    res.explanation = { summary: label, positiveSignals: pos, negativeSignals: neg, neutralNotes: null };
    return res;
  },
};

export const ExpectedOutcomeStrategy: Strategy = {
  code: "expected_outcome_v1",
  version: "1",
  insightType: "expected_outcome",
  score(fs) {
    const f = fs.features;
    const res = baseResult(this, fs);
    let sample = asInt(f.pipelineClosedSample);
    if (sample === 0) sample = asInt(f.sourceClosedSample);
    if (sample < MIN_HISTORICAL_SAMPLE) {
      res.message = INSUFFICIENT_HISTORICAL_DATA;
      res.insufficientHistoricalData = true;
      res.explanation.summary = INSUFFICIENT_HISTORICAL_DATA;
      res.explanation.neutralNotes = [`Closed historical sample: ${sample} (minimum ${MIN_HISTORICAL_SAMPLE}).`];
      return res;
    }
    let win = asFloat(f.pipelineWinRate);
    if (win === 0) win = asFloat(f.sourceConversionRate);
    const stageProb = asFloat(f.stageProbability);
    const blended = stageProb > 0 ? (win + stageProb) / 2 : win;
    const label =
      blended >= 60
        ? "Positive outcome more likely"
        : blended >= 35
          ? "Mixed / depends on execution"
          : "Lower likelihood of positive outcome";
    let pos: Signal[] | null = null;
    let neg: Signal[] | null = null;
    if (stageProb >= 50) {
      pos = push(pos, sig("stage_prob", "Favorable stage probability", stageProb, "positive", `${f0(stageProb)}% stage probability`));
    }
    if (win < 30) {
      neg = push(neg, sig("hist_win", "Modest historical win rate", -win, "negative", `${f0(win)}% historical`));
    } else {
      pos = push(pos, sig("hist_win", "Supportive historical outcomes", win, "positive", `${f0(win)}% historical`));
    }
    res.available = true;
    res.score = round2(blended);
    res.label = label;
    res.explanation = {
      summary: `${label} (blended estimate ${f0(blended)}%).`,
      positiveSignals: pos,
      negativeSignals: neg,
      neutralNotes: [`Sample size: ${sample}`],
    };
    res.payload = { blendedLikelihood: blended, sampleSize: sample };
    return res;
  },
};

export const WorkloadForecastStrategy: Strategy = {
  code: "workload_forecast_v1",
  version: "1",
  insightType: "workload_forecast",
  score(fs) {
    const f = fs.features;
    const res = baseResult(this, fs);
    const idx = asFloat(f.workloadIndex);
    const due = asInt(f.dueNext7Days);
    const overdue = asInt(f.overdueActivities);
    const openDeals = asInt(f.openDeals);
    const openLeads = asInt(f.openLeads);
    let pos: Signal[] | null = null;
    let neg: Signal[] | null = null;
    if (overdue > 0) {
      neg = push(neg, sig("overdue_load", "Overdue backlog", -(overdue * 5), "negative", `${overdue} overdue activities`));
    }
    if (due >= 8) neg = push(neg, sig("dense_week", "Dense upcoming week", -15, "negative", `${due} due in 7 days`));
    else if (due > 0) pos = push(pos, sig("planned_week", "Planned follow-ups ahead", 5, "positive"));
    if (asInt(f.completedLast7Days) >= 5) pos = push(pos, sig("throughput", "Healthy recent throughput", 8, "positive"));
    const label = idx >= 40 || overdue >= 5 ? "Heavy workload forecast" : idx >= 20 ? "Elevated workload" : "Manageable workload";
    res.available = true;
    res.score = clamp(round2(idx), 0, 100);
    res.label = label;
    res.explanation = {
      summary: `${label} — open leads ${openLeads}, open deals ${openDeals}, due next 7d ${due}.`,
      positiveSignals: pos,
      negativeSignals: neg,
      neutralNotes: null,
    };
    res.payload = { openLeads, openDeals, dueNext7Days: due, overdueActivities: overdue };
    return res;
  },
};

export const PipelineRiskStrategy: Strategy = {
  code: "pipeline_risk_v1",
  version: "1",
  insightType: "pipeline_risk",
  score(fs) {
    const f = fs.features;
    const res = baseResult(this, fs);
    const open = asInt(f.openDealCount);
    if (open === 0) {
      res.available = true;
      res.label = "No open pipeline";
      res.score = 0;
      res.explanation.summary = "No open deals in this pipeline.";
      return res;
    }
    const stalled = asInt(f.stalledDeals14d);
    const overSla = asInt(f.overSLADeals);
    const quiet = asInt(f.noActivity14d);
    let risk = ((stalled + overSla + quiet) / open) * 100;
    const pos: Signal[] = [];
    const neg: Signal[] = [];
    if (stalled > 0) neg.push(sig("stalled", "Stalled opportunities", -stalled, "negative", `${stalled} deals >=14 days in stage`));
    if (overSla > 0) neg.push(sig("sla", "Over SLA", -overSla, "negative", `${overSla} deals past SLA`));
    if (quiet > 0) neg.push(sig("quiet", "No recent activity", -quiet, "negative", `${quiet} deals quiet 14d+`));
    if (open - quiet > Math.trunc(open / 2)) pos.push(sig("active_majority", "Majority still active", 10, "positive"));
    const notes: string[] = [];
    if (asInt(f.closedSample) < MIN_HISTORICAL_SAMPLE) {
      res.insufficientHistoricalData = true;
      notes.push(INSUFFICIENT_HISTORICAL_DATA + " Historical win rate is informational only.");
    }
    risk = clamp(round2(risk), 0, 100);
    const label = risk >= 60 ? "Elevated pipeline risk" : risk >= 30 ? "Moderate pipeline risk" : "Pipeline healthy";
    res.available = true;
    res.score = risk;
    res.label = label;
    res.explanation = {
      summary: `${label} (${f0(risk)}% of open deals show risk signals).`,
      positiveSignals: pos,
      negativeSignals: neg,
      neutralNotes: notes,
    };
    res.payload = {
      openDealCount: open,
      stalledDeals14d: stalled,
      overSLADeals: overSla,
      noActivity14d: quiet,
      openPipelineValue: f.openPipelineValue,
    };
    return res;
  },
};

export const STRATEGIES: Strategy[] = [
  LeadScoreStrategy,
  ConversionLikelihoodStrategy,
  StalledOpportunityStrategy,
  FollowUpRiskStrategy,
  ExpectedOutcomeStrategy,
  WorkloadForecastStrategy,
  PipelineRiskStrategy,
];
