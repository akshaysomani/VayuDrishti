import type { IncomingMessage, ServerResponse } from 'node:http';
import alertDataRaw from '../data/alert_data.json';
import { runShippedModelInference } from '../services/shippedModelInference';
import { createDemoFixture } from '../services/liveDemoFixtures';
import type { LiveAlertPayload, NormalizedLiveObservation, LiveExposureContext } from '../types/liveAlert';
import { calculatePhase1Pm25Ratio90 } from '../services/historicalObservationStore';

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

import { getGlobalIngestionScheduler } from './ingestionScheduler';

/**
 * Server-side request handler for /api/live/air-quality and /api/live/ingestion-status.
 * Kept strictly on the backend to safeguard the WAQI API token.
 */
export async function handleLiveAirQualityRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    const host = req.headers.host ?? 'localhost:5173';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const scheduler = getGlobalIngestionScheduler();

    // Route A: Ingestion Service Status & Statistics
    if (url.pathname.endsWith('/ingestion-status')) {
      const status = await scheduler.getStatus();
      res.statusCode = 200;
      res.end(JSON.stringify(status));
      return;
    }

    // Route B: Manual On-Demand Poll Trigger
    if (url.pathname.endsWith('/poll-now')) {
      await scheduler.pollCycle();
      const status = await scheduler.getStatus();
      res.statusCode = 200;
      res.end(JSON.stringify({ polled: true, status }));
      return;
    }

    // Route C: Seed Station History (Deterministic 72h telemetry for demonstration)
    if (url.pathname.endsWith('/seed-history') || url.searchParams.has('seedHistory')) {
      const stationId = url.searchParams.get('stationId') ?? 'DL001';
      const now = new Date();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const t1Str = new Date(now.getTime() - oneDayMs).toISOString().split('T')[0];
      const t2Str = new Date(now.getTime() - 2 * oneDayMs).toISOString().split('T')[0];
      const p1 = parseFloat(url.searchParams.get('lag1') ?? '68.0');
      const p2 = parseFloat(url.searchParams.get('lag2') ?? '74.0');

      const count = await scheduler.seedStationHistory(stationId, [
        { date: t2Str, pm25: isNaN(p2) ? 74.0 : p2 },
        { date: t1Str, pm25: isNaN(p1) ? 68.0 : p1 },
      ]);
      if (url.pathname.endsWith('/seed-history')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ seeded: true, stationId, observations_added: count }));
        return;
      }
    }

    const stationId = url.searchParams.get('stationId') ?? 'DL001';
    const cityParam = url.searchParams.get('city') ?? '';
    const demoParam = url.searchParams.get('demo');
    const demoTier = (url.searchParams.get('tier') ?? 'watch') as
      | 'nominal'
      | 'watch'
      | 'elevated'
      | 'high'
      | 'stale'
      | 'error'
      | 'model_unavailable';

    // 1. If explicit demo mode requested, return deterministic demo fixture
    if (demoParam === 'true' || demoParam === '1' || url.searchParams.has('tier')) {
      const payload = createDemoFixture(demoTier, stationId);
      res.statusCode = 200;
      res.end(JSON.stringify(payload));
      return;
    }

    // 2. Fetch and ingest station through continuous ingestion scheduler
    const ingestResult = await scheduler.fetchAndIngestStation(stationId);
    if (ingestResult.success && ingestResult.alertPayload) {
      res.statusCode = 200;
      res.end(JSON.stringify(ingestResult.alertPayload));
      return;
    }

    // Fallback if token is missing or upstream failed
    const token = scheduler.getToken();
    if (!token) {
      // If no token is set in server environment, return a helpful structured response
      const fallbackPayload: LiveAlertPayload = {
        status: 'error',
        is_demo: false,
        observation: {
          station_id: stationId,
          station_name: alertData.stations[stationId]?.name ?? stationId,
          city: alertData.stations[stationId]?.city ?? cityParam ?? 'Delhi',
          latitude: alertData.stations[stationId]?.lat ?? 28.65,
          longitude: alertData.stations[stationId]?.lon ?? 77.23,
          coord_quality: alertData.stations[stationId]?.coord_quality ?? 'city_point',
          pm25: null,
          observed_at: new Date().toISOString(),
          received_at: new Date().toISOString(),
          is_stale: false,
          age_minutes: 0,
          source: 'WAQI',
          source_attribution: 'WAQI (Live Feed Adapter)',
        },
        inference: null,
        exposure: getExposure(stationId, alertData.stations[stationId]?.city ?? 'Delhi'),
        error_message:
          'WAQI_API_TOKEN environment variable is not configured on the server. Please set WAQI_API_TOKEN or switch to Demo Mode to explore all alert tiers.',
        features_complete: false,
        missing_features: ['PM2.5', 'pm25_lag1', 'pm25_rolling3'],
      };
      res.statusCode = 200; // Return 200 with structured error status
      res.end(JSON.stringify(fallbackPayload));
      return;
    }

    // 3. Resolve target station or city coordinates for WAQI
    const stationRecord = alertData.stations[stationId];
    const targetCity = cityParam || (stationRecord ? stationRecord.city : 'Delhi');

    let waqiUrl: string;
    if (stationRecord && stationRecord.coord_quality !== 'city_point') {
      // Use exact geo-coordinates query
      waqiUrl = `https://api.waqi.info/feed/geo:${stationRecord.lat};${stationRecord.lon}/?token=${token}`;
    } else {
      // Use city query
      waqiUrl = `https://api.waqi.info/feed/${encodeURIComponent(targetCity)}/?token=${token}`;
    }

    // 4. Request WAQI API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const waqiResp = await fetch(waqiUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!waqiResp.ok) {
      throw new Error(`WAQI upstream HTTP ${waqiResp.status}: ${waqiResp.statusText}`);
    }

    const waqiJson = await waqiResp.json();
    if (waqiJson.status !== 'ok' || !waqiJson.data) {
      const errReason = waqiJson.data === 'Unknown station' ? 'Station not found in WAQI network' : (waqiJson.data ?? 'WAQI feed error');
      throw new Error(`WAQI API status error: ${errReason}`);
    }

    const data = waqiJson.data;

    // 5. Parse PM2.5 observation
    // WAQI provides data.iaqi.pm25.v (instantaneous/hourly reading)
    const pm25Value: number | null = data.iaqi?.pm25?.v != null ? Number(data.iaqi.pm25.v) : (typeof data.aqi === 'number' ? data.aqi : null);

    // 6. Evaluate timestamp and freshness
    const obsTimeStr = data.time?.iso ?? (data.time?.s ? new Date(data.time.s).toISOString() : new Date().toISOString());
    const obsTime = new Date(obsTimeStr);
    const now = new Date();
    const ageMinutes = Math.max(0, Math.round((now.getTime() - obsTime.getTime()) / (60 * 1000)));
    const isStale = ageMinutes > 6 * 60; // Flag as stale if older than 6 hours

    // 7. Check model feature completeness and evaluate shipped model
    // The shipped model requires ['PM2.5', 'pm25_lag1', 'pm25_rolling3', 'pm25_ratio_90'].
    // Phase 1 definition: pm25_ratio_90 = PM2.5 / 90.0 (ratio to CPCB 90.0 µg/m³ acute spike threshold).
    // A single live WAQI observation only provides the current instantaneous observation.
    // Daily lag (t-1) and 3-day rolling mean (t-2, t-1, t) require historical telemetry (min 72h).
    const lag1Param = url.searchParams.get('pm25_lag1');
    const rolling3Param = url.searchParams.get('pm25_rolling3');
    const ratio90Param = url.searchParams.get('pm25_ratio_90');

    const featureInput = {
      pm25: pm25Value ?? NaN,
      pm25_ratio_90: ratio90Param ? parseFloat(ratio90Param) : (pm25Value != null ? calculatePhase1Pm25Ratio90(pm25Value) : NaN),
      pm25_lag1: lag1Param ? parseFloat(lag1Param) : undefined,
      pm25_rolling3: rolling3Param ? parseFloat(rolling3Param) : undefined,
    };

    const inferenceResult = runShippedModelInference(featureInput, obsTime.toISOString());

    const normObs: NormalizedLiveObservation = {
      station_id: stationId,
      station_name: data.city?.name ?? stationRecord?.name ?? targetCity,
      city: targetCity,
      latitude: Array.isArray(data.city?.geo) ? data.city.geo[0] : (stationRecord?.lat ?? 28.65),
      longitude: Array.isArray(data.city?.geo) ? data.city.geo[1] : (stationRecord?.lon ?? 77.23),
      coord_quality: stationRecord?.coord_quality ?? 'city_point',
      pm25: pm25Value,
      observed_at: obsTime.toISOString(),
      received_at: now.toISOString(),
      is_stale: isStale,
      age_minutes: ageMinutes,
      source: 'WAQI',
      source_attribution: `WAQI Live Station Feed (@${data.idx ?? 'station'})`,
    };

    const isComplete = inferenceResult.isComplete && !isStale;
    const finalStatus: 'fresh' | 'stale' | 'model_unavailable' = isStale
      ? 'stale'
      : isComplete
        ? 'fresh'
        : 'model_unavailable';

    const responsePayload: LiveAlertPayload = {
      status: finalStatus,
      is_demo: false,
      observation: normObs,
      inference: inferenceResult.inference,
      exposure: getExposure(stationId, targetCity),
      error_message:
        !isComplete && !isStale
          ? 'Live observation captured, but full model inference is unavailable: Shipped Calibrated Logistic Regression requires past daily lag (pm25_lag1) and 3-day backward rolling mean (pm25_rolling3) which cannot be derived safely from an isolated WAQI reading.'
          : isStale
            ? `Observation timestamp is stale (${ageMinutes} minutes old). Alert suppressed.`
            : null,
      features_complete: inferenceResult.isComplete,
      missing_features: inferenceResult.missingFeatures,
    };

    res.statusCode = 200;
    res.end(JSON.stringify(responsePayload));
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Sanitize any potential token from error string
    const cleanMsg = rawMsg.replace(/token=[^&]+/g, 'token=[REDACTED]');

    const errorPayload: LiveAlertPayload = {
      status: 'error',
      is_demo: false,
      observation: {
        station_id: 'unknown',
        station_name: 'Unknown Station',
        city: 'India',
        latitude: 28.61,
        longitude: 77.23,
        coord_quality: 'city_point',
        pm25: null,
        observed_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        is_stale: false,
        age_minutes: 0,
        source: 'WAQI',
        source_attribution: 'WAQI (Live Feed Adapter)',
      },
      inference: null,
      exposure: null,
      error_message: `Live data retrieval failed: ${cleanMsg}`,
      features_complete: false,
      missing_features: ['PM2.5', 'pm25_lag1', 'pm25_rolling3'],
    };

    res.statusCode = 200;
    res.end(JSON.stringify(errorPayload));
  }
}
