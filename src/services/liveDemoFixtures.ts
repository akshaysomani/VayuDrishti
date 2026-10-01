import alertDataRaw from '../data/alert_data.json';
import { runShippedModelInference } from './shippedModelInference';
import type { LiveAlertPayload, LiveExposureContext } from '../types/liveAlert';

const alertData = alertDataRaw as {
  stations: Record<
    string,
    {
      id: string;
      name: string;
      city: string;
      lat: number;
      lon: number;
      coord_quality: 'station' | 'manual' | 'suspect' | 'city_point';
      population_2km: number;
      population_5km: number;
      population_within_5km_of_monitors: number;
      population_within_2km_of_monitors?: number;
    }
  >;
  city_exposure: Record<
    string,
    {
      city: string;
      population_within_5km_of_monitors: number;
      mean_daily_expected_exposed: number;
      people_in_already_poor_areas?: number;
      already_poor_share_pct?: number;
    }
  >;
};

function getExposure(stationId: string, city: string): LiveExposureContext | null {
  const st = alertData.stations[stationId];
  const ce = alertData.city_exposure[city];
  if (!st && !ce) return null;

  return {
    station_population_5km: st?.population_5km ?? ce?.population_within_5km_of_monitors ?? 0,
    station_population_2km: st?.population_2km ?? 0,
    city_population_5km_union: ce?.population_within_5km_of_monitors ?? st?.population_5km ?? 0,
    city_mean_daily_expected_exposed: ce?.mean_daily_expected_exposed ?? 0,
    people_in_already_poor_areas: ce?.people_in_already_poor_areas ?? 0,
    already_poor_share_pct: ce?.already_poor_share_pct ?? 0,
  };
}

export function createDemoFixture(
  tier: 'nominal' | 'watch' | 'elevated' | 'high' | 'stale' | 'error' | 'model_unavailable',
  stationId = 'DL001'
): LiveAlertPayload {
  const stationRecord = alertData.stations[stationId] ?? alertData.stations['DL001'];
  const city = stationRecord.city;
  const now = new Date();

  if (tier === 'error') {
    return {
      status: 'error',
      is_demo: true,
      demo_fixture_tier: 'error',
      observation: {
        station_id: stationRecord.id,
        station_name: stationRecord.name,
        city: city,
        latitude: stationRecord.lat,
        longitude: stationRecord.lon,
        coord_quality: stationRecord.coord_quality,
        pm25: null,
        observed_at: now.toISOString(),
        received_at: now.toISOString(),
        is_stale: false,
        age_minutes: 0,
        source: 'DEMO',
        source_attribution: 'DEMO FIXTURE — NOT LIVE DATA (Simulated Network / Upstream Failure)',
      },
      inference: null,
      exposure: getExposure(stationRecord.id, city),
      error_message: 'Simulated upstream error: WAQI endpoint returned HTTP 504 Gateway Timeout.',
      features_complete: false,
      missing_features: ['PM2.5', 'pm25_lag1', 'pm25_rolling3'],
    };
  }

  if (tier === 'model_unavailable') {
    return {
      status: 'model_unavailable',
      is_demo: true,
      demo_fixture_tier: 'model_unavailable',
      observation: {
        station_id: stationRecord.id,
        station_name: stationRecord.name,
        city: city,
        latitude: stationRecord.lat,
        longitude: stationRecord.lon,
        coord_quality: stationRecord.coord_quality,
        pm25: 64.5,
        observed_at: now.toISOString(),
        received_at: now.toISOString(),
        is_stale: false,
        age_minutes: 4,
        source: 'DEMO',
        source_attribution: 'DEMO FIXTURE — NOT LIVE DATA (Simulated Incomplete Feature Vector)',
      },
      inference: null,
      exposure: getExposure(stationRecord.id, city),
      error_message:
        'Model inference unavailable: Real-time observation provides current PM2.5 (64.5 µg/m³), but required historical lag features (pm25_lag1, pm25_rolling3) cannot be safely derived from an isolated WAQI observation.',
      features_complete: false,
      missing_features: ['pm25_lag1', 'pm25_rolling3'],
    };
  }

  if (tier === 'stale') {
    // 18 hours ago
    const staleTime = new Date(now.getTime() - 18 * 60 * 60 * 1000);
    // Elevated risk features
    const features = { pm25: 78.0, pm25_ratio_90: 78.0 / 90.0, pm25_lag1: 72.0, pm25_rolling3: 75.0 };
    const { inference } = runShippedModelInference(features, staleTime.toISOString());

    return {
      status: 'stale',
      is_demo: true,
      demo_fixture_tier: 'stale',
      observation: {
        station_id: stationRecord.id,
        station_name: stationRecord.name,
        city: city,
        latitude: stationRecord.lat,
        longitude: stationRecord.lon,
        coord_quality: stationRecord.coord_quality,
        pm25: 78.0,
        observed_at: staleTime.toISOString(),
        received_at: now.toISOString(),
        is_stale: true,
        age_minutes: 18 * 60,
        source: 'DEMO',
        source_attribution: 'DEMO FIXTURE — NOT LIVE DATA (Simulated Stale Observation > 6 Hours)',
      },
      inference,
      exposure: getExposure(stationRecord.id, city),
      error_message: 'Observation is stale (18 hours old). Alert suppressed to prevent false urgency.',
      features_complete: true,
      missing_features: [],
    };
  }

  // Active fresh tiers: nominal, watch, elevated, high
  let features = { pm25: 35.0, pm25_ratio_90: 35.0 / 90.0, pm25_lag1: 34.0, pm25_rolling3: 34.5 }; // nominal: p ~ 0.007 < 0.05
  if (tier === 'watch') {
    // Calibrated probability ~ 0.14 (0.05 <= p < 0.22)
    features = { pm25: 68.0, pm25_ratio_90: 68.0 / 90.0, pm25_lag1: 60.0, pm25_rolling3: 63.0 };
  } else if (tier === 'elevated') {
    // Calibrated probability ~ 0.32 (0.22 <= p < 0.50)
    features = { pm25: 82.0, pm25_ratio_90: 82.0 / 90.0, pm25_lag1: 74.0, pm25_rolling3: 78.0 };
  } else if (tier === 'high') {
    // Calibrated probability ~ 0.72 (p >= 0.50)
    features = { pm25: 89.0, pm25_ratio_90: 89.0 / 90.0, pm25_lag1: 88.0, pm25_rolling3: 88.5 };
  }

  const { inference } = runShippedModelInference(features, now.toISOString());

  return {
    status: 'fresh',
    is_demo: true,
    demo_fixture_tier: tier,
    observation: {
      station_id: stationRecord.id,
      station_name: stationRecord.name,
      city: city,
      latitude: stationRecord.lat,
      longitude: stationRecord.lon,
      coord_quality: stationRecord.coord_quality,
      pm25: features.pm25,
      observed_at: now.toISOString(),
      received_at: now.toISOString(),
      is_stale: false,
      age_minutes: 8,
      source: 'DEMO',
      source_attribution: `DEMO FIXTURE — NOT LIVE DATA (${tier.toUpperCase()} Tier Scenario)`,
    },
    inference,
    exposure: getExposure(stationRecord.id, city),
    error_message: null,
    features_complete: true,
    missing_features: [],
  };
}
