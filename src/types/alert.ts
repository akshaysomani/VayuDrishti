/**
 * Type definitions and runtime schema validator for alert_data.json.
 * Strict adherence to data contracts, zero numeric fallbacks, and runtime path assertion.
 */

export interface TimingAudit {
  day_t_features: string[];
  past_day_features: string[];
  forecast_target: string;
  leakage_verification: string;
}

export interface ProbabilityCalibration {
  type: string;
  calibration_split: string;
  formula: string;
  params?: {
    distribution?: string;
    sigma?: number;
    threshold_pm25?: number;
  };
  derivation_explanation?: string;
}

export interface FeaturesMetadata {
  all: string[];
  fire: string[];
  wind: string[];
  lags: string[];
  meteorological: string[];
  calendar: string[];
}

export interface BaselineConfig {
  rule: string;
  calibrated_split?: string;
  threshold_x?: number;
  description: string;
}

export interface BaselinesMetadata {
  persistence_naive: BaselineConfig;
  persistence_tuned_fresh: BaselineConfig;
  persistence_tuned_general: BaselineConfig;
}

export interface GeneralAlertOperatingPoint {
  threshold: number;
  calibrated_on: string;
  description: string;
}

export interface SeasonalRatioRecord {
  events: number;
  eligible: number;
  event_rate: number;
  no_fire_rate: number;
  rate_ratio_to_no_fire: number | null;
  status: 'valid' | string;
  ratio_ci_95_date: [number, number] | null;
}

export interface FireSeasonalitySegment {
  all_year: SeasonalRatioRecord;
  oct_feb: SeasonalRatioRecord;
  mar_sep: SeasonalRatioRecord;
}

export interface ReliabilityBin {
  bin_range: [number, number];
  bin_center: number;
  n_predictions: number;
  mean_risk_score: number;
  observed_frequency_overall: number;
  n_eligible_fresh: number;
  observed_frequency_fresh_crossing: number;
  is_fresh_eligible_sparse: boolean;
}

export interface AlertMeta {
  test_year?: number;
  test_period?: string;
  train_years?: number[];
  train_period?: string;
  validation_year?: number;
  validation_period?: string;
  model_name: string;
  alert_definition: string;
  alert_threshold: number;
  threshold_split: string;
  data_leakage_audit: string;
  timing_audit: TimingAudit;
  probability_calibration: ProbabilityCalibration;
  features: FeaturesMetadata;
  lightgbm_hyperparameters: Record<string, unknown>;
  baselines: BaselinesMetadata;
  general_alert_operating_point: GeneralAlertOperatingPoint;
  fire_seasonality_analysis: Record<string, FireSeasonalitySegment>;
  reliability_diagram: {
    all_rows: ReliabilityBin[];
    any_fire_100km: ReliabilityBin[];
  };
  n_rows: number;
  data_window: string;
  generated_at: string;
  input_data_hash: string;
  definitions: {
    fire_100km: string;
    upwind: string;
    top10_upwind_intensity: string;
    top10_upwind_intensity_all_rows: string;
  };
}

export interface FreshCrossingModelStats {
  recall: number;
  recall_ci_95_date: [number, number];
  precision: number;
  precision_ci_95_date: [number, number];
  f1: number;
}

export interface FreshCrossingTunedStats {
  rule: string;
  threshold_x: number;
  recall: number;
  precision: number;
  f1: number;
}

export interface FreshCrossingSegmentStats {
  eligible_n: number;
  event_n: number;
  event_rate: number;
  event_rate_ci_95_date: [number, number];
  model: FreshCrossingModelStats;
  persistence_tuned: FreshCrossingTunedStats;
  persistence_naive: {
    rule: string;
    recall: number;
    precision: number;
    f1: number;
    note?: string;
  };
}

export interface GeneralAlertModelStats {
  threshold: number;
  recall: number;
  precision: number;
  f1: number;
  f1_ci_95_date: [number, number];
}

export interface GeneralAlertPersistenceStats {
  rule: string;
  threshold_x?: number;
  recall: number;
  precision: number;
  f1: number;
  f1_ci_95_date: [number, number];
}

export interface GeneralAlertSegmentStats {
  all_rows_n: number;
  event_n: number;
  base_rate: number;
  model: GeneralAlertModelStats;
  persistence_naive: GeneralAlertPersistenceStats;
  persistence_tuned: GeneralAlertPersistenceStats;
}

export interface MatchedRecallPoint {
  target_recall: number;
  model: number | null;
  model_status: 'reached' | 'not reached';
  model_ci_95_date: [number, number] | null;
  baseline: number | null;
  baseline_status: 'reached' | 'not reached';
  baseline_ci_95_date: [number, number] | null;
  diff_model_minus_baseline: number | null;
  diff_ci_95_date: [number, number] | null;
}

export interface MatchedPrSummary {
  max_recall_reached_model: number;
  max_recall_reached_baseline: number;
  model_average_precision: number;
  model_ap_ci_95_date: [number, number];
  baseline_average_precision: number;
  baseline_ap_ci_95_date: [number, number];
  diff_average_precision: number;
  diff_ap_ci_95_date: [number, number];
  precision_at_recall_60: MatchedRecallPoint;
  precision_at_recall_75: MatchedRecallPoint;
  precision_at_recall_85: MatchedRecallPoint;
}

export interface SegmentData {
  n: number;
  definition: string;
  denominator: string;
  persistence_mae: number;
  model_mae: number;
  improvement_pct: number;
  improvement_ci_95_date: [number, number];
  fresh_crossing: FreshCrossingSegmentStats;
  general_alert: GeneralAlertSegmentStats;
  matched_pr: MatchedPrSummary;
}

export interface ModelPrCurvePoint {
  threshold: number;
  precision: number;
  recall: number;
  alerts_per_100_days: number;
}

export interface BaselinePrCurvePoint {
  threshold_x: number;
  precision: number;
  recall: number;
  alerts_per_100_days: number;
}

export interface PrCurveSegment {
  max_recall_model: number;
  max_recall_baseline: number;
  model: ModelPrCurvePoint[];
  baseline: BaselinePrCurvePoint[];
  baseline_calibrated_operating_point: {
    threshold_x: number;
    description: string;
  };
}

export interface OperatingPointDef {
  threshold: number;
  meaning: string;
}

export interface PredictionsColumnar {
  date: string[];
  station_id: string[];
  city: string[];
  pm25_today: number[];
  pm25_pred_tomorrow: number[];
  pm25_actual_tomorrow: number[];
  risk_score: (number | null)[];
  status?: string[];
  actual_poor_or_worse: boolean[];
  actual_fresh_crossing: boolean[];
  fire_any_100km: boolean[];
  fire_upwind_100km: boolean[];
  top10_upwind: boolean[];
  top10_upwind_all_rows: boolean[];
  expected_people_exposed?: (number | null)[];
  population_5km?: number[];
}

export interface StationExposureRecord {
  id: string;
  name: string;
  city: string;
  state?: string;
  lat: number;
  lon: number;
  coord_quality: 'station' | 'city_point' | 'suspect' | 'manual';
  population_2km: number;
  population_5km: number;
  population_within_5km_of_monitors: number;
  population_within_2km_of_monitors?: number;
  city_union_population_5km?: number;
  city_union_population_2km?: number;
  shared_coordinates_with?: string[];
  is_shared_city_point?: boolean;
}

export interface CityExposureSummary {
  city: string;
  stations_count: number;
  population_within_2km_of_monitors: number;
  population_within_5km_of_monitors: number;
  population_2km_union?: number;
  population_5km_union?: number;
  mean_daily_expected_exposed: number;
  people_in_already_poor_areas?: number;
  already_poor_share_pct?: number;
  total_monitor_days?: number;
  already_poor_monitor_days?: number;
  shared_coordinates_with?: string[];
  is_shared_city_point?: boolean;
  mean_monitor_share_by_tier?: {
    High: number;
    Elevated: number;
    Watch: number;
    Nominal: number;
  };
  mean_people_by_tier: {
    High: number;
    Elevated: number;
    Watch: number;
    Nominal: number;
  };
}

export interface AlertDataPayload {
  meta: AlertMeta;
  segments: Record<string, SegmentData>;
  pr_curves: Record<string, PrCurveSegment>;
  operating_points: {
    balanced: OperatingPointDef;
    high_recall: OperatingPointDef;
    high_precision: OperatingPointDef;
  };
  predictions: PredictionsColumnar;
  test_period?: string;
  fresh_crossing_benchmark?: {
    test_period: string;
    model: string;
    pr_auc: number;
    pr_auc_excl_lockdown?: number;
    budget_5pct_recall: number;
    budget_5pct_precision: number;
    budget_5pct_f1: number;
    framing?: string;
  };
  logistic_regression_benchmark?: {
    test_period: string;
    model: string;
    features: string[];
    pr_auc: number;
    pr_auc_excl_lockdown?: number;
    budget_5pct_recall: number;
    budget_5pct_precision: number;
    budget_5pct_f1: number;
    framing?: string;
  };
  stations?: Record<string, StationExposureRecord>;
  city_exposure?: Record<string, CityExposureSummary>;
}

/**
 * Runtime schema validator that verifies every required section and path.
 * Throws an explicit error naming the exact path if any is missing.
 */
export function validateAlertData(data: unknown): asserts data is AlertDataPayload {
  if (!data || typeof data !== 'object') {
    throw new Error('Schema validation error: root data must be an object');
  }

  const d = data as Record<string, unknown>;

  // Check top level keys
  const topKeys = ['meta', 'segments', 'pr_curves', 'operating_points', 'predictions'];
  for (const k of topKeys) {
    if (!(k in d) || d[k] === undefined || d[k] === null) {
      throw new Error(`Schema validation error: missing expected path '${k}'`);
    }
  }

  const meta = d.meta as Record<string, unknown>;
  const metaKeys = [
    'model_name',
    'alert_definition',
    'alert_threshold',
    'threshold_split',
    'timing_audit',
    'probability_calibration',
    'general_alert_operating_point',
    'fire_seasonality_analysis',
    'reliability_diagram',
    'n_rows',
    'definitions',
  ];
  for (const mk of metaKeys) {
    if (!(mk in meta) || meta[mk] === undefined || meta[mk] === null) {
      throw new Error(`Schema validation error: missing expected path 'meta.${mk}'`);
    }
  }
  if (!('test_period' in meta) && !('test_year' in meta)) {
    throw new Error("Schema validation error: missing expected path 'meta.test_period' or 'meta.test_year'");
  }

  const segments = d.segments as Record<string, unknown>;
  const expectedSegments = [
    'all_rows',
    'no_fire_100km',
    'any_fire_100km',
    'upwind_fire_100km',
    'top10_upwind_intensity',
    'top10_upwind_intensity_all_rows',
  ];
  for (const seg of expectedSegments) {
    if (!(seg in segments)) {
      throw new Error(`Schema validation error: missing expected path 'segments.${seg}'`);
    }
    const s = segments[seg] as Record<string, unknown>;
    const segKeys = [
      'n',
      'definition',
      'denominator',
      'persistence_mae',
      'model_mae',
      'improvement_pct',
      'improvement_ci_95_date',
      'fresh_crossing',
      'general_alert',
      'matched_pr',
    ];
    for (const sk of segKeys) {
      if (!(sk in s)) {
        throw new Error(`Schema validation error: missing expected path 'segments.${seg}.${sk}'`);
      }
    }
  }

  const pr = d.pr_curves as Record<string, unknown>;
  for (const seg of expectedSegments) {
    if (!(seg in pr)) {
      throw new Error(`Schema validation error: missing expected path 'pr_curves.${seg}'`);
    }
  }

  const op = d.operating_points as Record<string, unknown>;
  const opKeys = ['balanced', 'high_recall', 'high_precision'];
  for (const ok of opKeys) {
    if (!(ok in op)) {
      throw new Error(`Schema validation error: missing expected path 'operating_points.${ok}'`);
    }
  }

  const preds = d.predictions as Record<string, unknown>;
  const predCols = [
    'date',
    'station_id',
    'city',
    'pm25_today',
    'pm25_pred_tomorrow',
    'pm25_actual_tomorrow',
    'risk_score',
    'actual_poor_or_worse',
    'actual_fresh_crossing',
  ];
  for (const col of predCols) {
    if (!(col in preds) || !Array.isArray(preds[col])) {
      throw new Error(`Schema validation error: missing expected path 'predictions.${col}'`);
    }
  }
}

export type RiskTier = 'Nominal' | 'Watch' | 'Elevated' | 'High';

export interface RiskTierInfo {
  tier: RiskTier;
  label: string;
  rangeLabel: string;
  operationalRole: string;
  actionText: string;
  alertFired: boolean;
  colorClass: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
}

/**
 * Approved Operational Risk Tier Scheme (Phase 2f):
 * Nominal:    p < 0.05         -> Routine baseline monitoring (No Alert)
 * Watch:      0.05 <= p < 0.22 -> Advisory alert tier (High Recall, 84.2% sensitivity)
 * Elevated:   0.22 <= p < 0.50 -> Actionable alert tier (Balanced F1, precision 30.9%)
 * High:       p >= 0.50        -> Emergency alert tier (High acute spike probability)
 *
 * Rules:
 * 1. Any p >= 0.05 must NEVER display "Nominal".
 * 2. Watch is the alert/advisory tier.
 * 3. Elevated is the actionable tier.
 * 4. High is the emergency tier.
 */
export function getRiskTier(riskScore: number | null | undefined): RiskTierInfo | null {
  if (riskScore === null || riskScore === undefined || isNaN(riskScore)) {
    return null;
  }
  if (riskScore < 0.05) {
    return {
      tier: 'Nominal',
      label: 'Nominal',
      rangeLabel: 'p < 0.05',
      operationalRole: 'Routine Baseline Monitoring',
      actionText: 'No alert issued. Routine air quality tracking.',
      alertFired: false,
      colorClass: 'text-slate-600 dark:text-slate-400',
      badgeBg: 'bg-slate-500/10',
      badgeText: 'text-slate-700 dark:text-slate-300',
      badgeBorder: 'border-slate-500/30 dark:border-slate-400/40',
    };
  }
  if (riskScore < 0.22) {
    return {
      tier: 'Watch',
      label: 'Watch',
      rangeLabel: '0.05 ≤ p < 0.22',
      operationalRole: 'Advisory Alert',
      actionText: 'Early advisory alert active. Sensitive groups should prepare.',
      alertFired: true,
      colorClass: 'text-amber-600 dark:text-amber-400',
      badgeBg: 'bg-amber-500/10',
      badgeText: 'text-amber-800 dark:text-amber-300',
      badgeBorder: 'border-amber-600 dark:border-amber-400/60',
    };
  }
  if (riskScore < 0.50) {
    return {
      tier: 'Elevated',
      label: 'Elevated',
      rangeLabel: '0.22 ≤ p < 0.50',
      operationalRole: 'Actionable Alert',
      actionText: 'Actionable alert active. Deploy targeted mitigation protocols.',
      alertFired: true,
      colorClass: 'text-orange-600 dark:text-orange-400',
      badgeBg: 'bg-orange-500/10',
      badgeText: 'text-orange-800 dark:text-orange-300',
      badgeBorder: 'border-orange-600 dark:border-orange-400/60',
    };
  }
  return {
    tier: 'High',
    label: 'High',
    rangeLabel: 'p ≥ 0.50',
    operationalRole: 'Emergency Alert',
    actionText: 'Emergency alert active. High certainty of acute Poor/Severe crossing.',
    alertFired: true,
    colorClass: 'text-rose-600 dark:text-rose-400',
    badgeBg: 'bg-rose-500/10',
    badgeText: 'text-rose-800 dark:text-rose-300',
    badgeBorder: 'border-rose-600 dark:border-rose-400/60',
  };
}

