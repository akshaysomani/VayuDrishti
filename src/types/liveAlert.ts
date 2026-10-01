import type { RiskTierInfo } from './alert';

export const LIVE_ALERT_STALE_HOURS = 6;

export type LiveDataStatus = 'fresh' | 'stale' | 'error' | 'model_unavailable';

export type LiveDataSource = 'WAQI' | 'DEMO';

export interface NormalizedLiveObservation {
  station_id: string;
  station_name: string;
  city: string;
  latitude: number;
  longitude: number;
  coord_quality: 'station' | 'manual' | 'suspect' | 'city_point';
  pm25: number | null;
  observed_at: string; // ISO 8601 string
  received_at: string; // ISO 8601 string
  is_stale: boolean;
  age_minutes: number;
  source: LiveDataSource;
  source_attribution: string;
}

export interface LiveModelFeatures {
  pm25: number;
  pm25_ratio_90: number;
  pm25_lag1?: number;
  pm25_rolling3?: number;
}

export interface LiveModelInference {
  model_version: string;
  model_name: string;
  probability: number;
  risk_tier: RiskTierInfo;
  alert_fired: boolean;
  input_timestamp: string;
  source_timestamp: string;
  features_used: LiveModelFeatures;
  missing_features?: string[];
  explanation: string;
}

export interface LiveExposureContext {
  station_population_5km: number;
  station_population_2km: number;
  city_population_5km_union: number;
  city_mean_daily_expected_exposed: number;
  people_in_already_poor_areas: number;
  already_poor_share_pct: number;
}

export interface LiveAlertPayload {
  status: LiveDataStatus;
  is_demo: boolean;
  demo_fixture_tier?: 'nominal' | 'watch' | 'elevated' | 'high' | 'stale' | 'error' | 'model_unavailable';
  observation: NormalizedLiveObservation;
  inference: LiveModelInference | null;
  exposure: LiveExposureContext | null;
  error_message: string | null;
  features_complete: boolean;
  missing_features: string[];
}
