/**
 * WAQI Ingestion Scheduler & Continuous Background Service
 * ========================================================
 * Manages repeated, rate-limited polling of WAQI monitoring stations,
 * stores observations in the persistent historical buffer, and evaluates
 * the canonical Phase 1 feature completeness pipeline.
 */

import {
  computeLivePhase1Features,
  type RawStationObservation,
  type Phase1FeatureResult,
} from '../services/historicalObservationStore';
import { getGlobalStationHistoryStore } from './persistentStore';
import { runShippedModelInference } from '../services/shippedModelInference';
import alertDataRaw from '../data/alert_data.json';
import type { LiveAlertPayload, LiveExposureContext } from '../types/liveAlert';
import { getGlobalAlertDispatcher } from './services/alertDispatcher';
import { getGlobalTriageWorker } from './services/triageWorker';

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

export interface IngestionStatus {
  service_status: 'idle' | 'polling' | 'running' | 'stopped' | 'error';
  poll_interval_minutes: number;
  total_polls_count: number;
  total_observations_ingested: number;
  last_poll_started_at: string | null;
  last_poll_completed_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  tracked_stations_count: number;
  store_stats: {
    total_stations: number;
    total_observations: number;
    oldest_timestamp: string | null;
    newest_timestamp: string | null;
  };
}

export class WaqiIngestionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private pollIntervalMs: number = 15 * 60 * 1000; // Default 15 minutes
  private store = getGlobalStationHistoryStore();

  private status: IngestionStatus = {
    service_status: 'idle',
    poll_interval_minutes: 15,
    total_polls_count: 0,
    total_observations_ingested: 0,
    last_poll_started_at: null,
    last_poll_completed_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_errors: 0,
    tracked_stations_count: 0,
    store_stats: {
      total_stations: 0,
      total_observations: 0,
      oldest_timestamp: null,
      newest_timestamp: null,
    },
  };

  constructor() {
    const envInterval = process.env.WAQI_POLL_INTERVAL_MS;
    if (envInterval && !isNaN(parseInt(envInterval, 10))) {
      this.pollIntervalMs = Math.max(60 * 1000, parseInt(envInterval, 10)); // Min 1 minute
      this.status.poll_interval_minutes = Math.round(this.pollIntervalMs / 60000);
    }
  }

  public getToken(): string | null {
    let token = process.env.WAQI_API_TOKEN;
    if (!token || token.trim() === '') {
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf8');
          const match = content.match(/^WAQI_API_TOKEN\s*=\s*(.+)$/m);
          if (match) {
            token = match[1].trim().replace(/^['"]|['"]$/g, '');
            process.env.WAQI_API_TOKEN = token;
          }
        }
      } catch {
        // Fall through
      }
    }
    return token && token.trim() !== '' ? token.trim() : null;
  }

  /**
   * Fetch and ingest observation for a single station
   */
  public async fetchAndIngestStation(stationId: string): Promise<{
    success: boolean;
    observation?: RawStationObservation;
    features?: Phase1FeatureResult;
    alertPayload?: LiveAlertPayload;
    error?: string;
  }> {
    const token = this.getToken();
    if (!token) {
      return {
        success: false,
        error: 'WAQI_API_TOKEN environment variable is not configured.',
      };
    }

    const stationRecord = alertData.stations[stationId];
    const targetCity = stationRecord?.city ?? 'Delhi';

    let waqiUrl: string;
    if (stationRecord && stationRecord.coord_quality !== 'city_point') {
      waqiUrl = `https://api.waqi.info/feed/geo:${stationRecord.lat};${stationRecord.lon}/?token=${token}`;
    } else {
      waqiUrl = `https://api.waqi.info/feed/${encodeURIComponent(targetCity)}/?token=${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const resp = await fetch(waqiUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (!resp.ok) {
        throw new Error(`WAQI upstream HTTP ${resp.status}: ${resp.statusText}`);
      }

      const json = await resp.json();
      if (json.status !== 'ok' || !json.data) {
        const errReason =
          json.data === 'Unknown station'
            ? 'Station not found in WAQI network'
            : (json.data ?? 'WAQI feed error');
        throw new Error(`WAQI API status error: ${errReason}`);
      }

      const data = json.data;

      // Extract PM2.5 observation
      const pm25Value: number | null =
        data.iaqi?.pm25?.v != null
          ? Number(data.iaqi.pm25.v)
          : typeof data.aqi === 'number'
            ? data.aqi
            : null;

      if (pm25Value == null || isNaN(pm25Value) || pm25Value < 0) {
        throw new Error(`Station feed does not currently provide valid PM2.5 reading.`);
      }

      const obsTimeStr =
        data.time?.iso ??
        (data.time?.s ? new Date(data.time.s).toISOString() : new Date().toISOString());
      const now = new Date();
      const obsTime = new Date(obsTimeStr);
      const ageMinutes = Math.max(0, Math.round((now.getTime() - obsTime.getTime()) / (60 * 1000)));
      const isStale = ageMinutes > 6 * 60; // 6 hours

      const rawObs: RawStationObservation = {
        station_id: stationId,
        station_name: data.city?.name ?? stationRecord?.name ?? targetCity,
        city: targetCity,
        lat: Array.isArray(data.city?.geo) ? data.city.geo[0] : (stationRecord?.lat ?? 28.65),
        lon: Array.isArray(data.city?.geo) ? data.city.geo[1] : (stationRecord?.lon ?? 77.23),
        coord_quality: stationRecord?.coord_quality ?? 'city_point',
        pm25: pm25Value,
        observed_at: obsTime.toISOString(),
        ingested_at: now.toISOString(),
        source: 'WAQI',
      };

      // Ingest into persistent historical buffer
      await this.store.addObservation(rawObs);
      this.status.total_observations_ingested++;

      // Retrieve full history and compute Phase 1 features
      const history = await this.store.getStationObservations(stationId, 72);
      const featureResult = computeLivePhase1Features(stationId, rawObs, history);

      let inference = null;
      if (featureResult.success && featureResult.features) {
        const infRes = runShippedModelInference(featureResult.features, obsTime.toISOString());
        inference = infRes.inference;
      }

      const isComplete = featureResult.success && !isStale && inference !== null;
      const status: 'fresh' | 'stale' | 'model_unavailable' = isStale
        ? 'stale'
        : isComplete
          ? 'fresh'
          : 'model_unavailable';

      const payload: LiveAlertPayload = {
        status,
        is_demo: false,
        observation: {
          station_id: rawObs.station_id,
          station_name: rawObs.station_name,
          city: rawObs.city,
          latitude: rawObs.lat,
          longitude: rawObs.lon,
          coord_quality: rawObs.coord_quality,
          pm25: rawObs.pm25,
          observed_at: rawObs.observed_at,
          received_at: rawObs.ingested_at,
          is_stale: isStale,
          age_minutes: ageMinutes,
          source: 'WAQI',
          source_attribution: `WAQI Live Station Feed (@${data.idx ?? 'station'})`,
        },
        inference,
        exposure: getExposure(stationId, targetCity),
        error_message:
          !isComplete && !isStale
            ? `MODEL UNAVAILABLE: ${featureResult.reason}`
            : isStale
              ? `Observation timestamp is stale (${ageMinutes} minutes old). Alert suppressed.`
              : null,
        features_complete: isComplete,
        missing_features: featureResult.missingFeatures,
      };

      this.status.last_success_at = new Date().toISOString();
      this.status.consecutive_errors = 0;
      this.status.last_error = null;

      // Phase 5 f4: Authoritative Alert Delivery Post-Inference Hook
      try {
        const dispatcher = getGlobalAlertDispatcher();
        await dispatcher.handleInferenceResult(payload);
      } catch (dispatchErr) {
        console.error('[IngestionScheduler] Alert dispatch hook error:', dispatchErr);
      }

      return {
        success: true,
        observation: rawObs,
        features: featureResult,
        alertPayload: payload,
      };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const cleanMsg = rawMsg.replace(/token=[^&]+/g, 'token=[REDACTED]');
      this.status.last_error = cleanMsg;
      this.status.consecutive_errors++;
      return {
        success: false,
        error: cleanMsg,
      };
    }
  }

  /**
   * Run polling cycle across active reporting stations
   */
  public async pollCycle(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    this.status.service_status = 'polling';
    this.status.last_poll_started_at = new Date().toISOString();
    this.status.total_polls_count++;

    try {
      const targetStationIds = ['DL001', 'DL004', 'MH001', 'KA001', 'RJ001'];
      this.status.tracked_stations_count = targetStationIds.length;

      for (const sid of targetStationIds) {
        await this.fetchAndIngestStation(sid);
        // Rate-limit safety: 400ms delay between stations
        await new Promise((r) => setTimeout(r, 400));
      }

      this.status.service_status = 'running';
      this.status.last_poll_completed_at = new Date().toISOString();
      this.status.store_stats = await this.store.getStats();
    } catch (err) {
      this.status.service_status = 'error';
      this.status.last_error = err instanceof Error ? err.message : String(err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Seed station with verified historical observations (e.g. for testing / demonstration)
   */
  public async seedStationHistory(
    stationId: string,
    readings: Array<{ date: string; pm25: number }>
  ): Promise<number> {
    const stationRecord = alertData.stations[stationId];
    let inserted = 0;

    for (const r of readings) {
      const obs: RawStationObservation = {
        station_id: stationId,
        station_name: stationRecord?.name ?? stationId,
        city: stationRecord?.city ?? 'Delhi',
        lat: stationRecord?.lat ?? 28.65,
        lon: stationRecord?.lon ?? 77.23,
        coord_quality: stationRecord?.coord_quality ?? 'station',
        pm25: r.pm25,
        observed_at: `${r.date}T12:00:00.000Z`,
        ingested_at: new Date().toISOString(),
        source: 'WAQI_VERIFIED_HISTORY',
      };
      const res = await this.store.addObservation(obs);
      if (res.added) inserted++;
    }

    this.status.store_stats = await this.store.getStats();
    return inserted;
  }

  public startScheduler(): void {
    if (this.timer) return;
    this.status.service_status = 'running';
    // Start alert delivery dispatcher
    getGlobalAlertDispatcher().startDispatcher();
    // Start AI triage queue worker
    getGlobalTriageWorker().startWorker();
    // Run initial poll cycle immediately in background
    this.pollCycle().catch(() => {});
    // Schedule periodic execution
    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
  }

  public stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    getGlobalAlertDispatcher().stopDispatcher();
    getGlobalTriageWorker().stopWorker();
    this.status.service_status = 'stopped';
  }

  public async getStatus(): Promise<IngestionStatus> {
    this.status.store_stats = await this.store.getStats();
    return { ...this.status };
  }
}

/**
 * Singleton scheduler instance
 */
let globalScheduler: WaqiIngestionScheduler | null = null;

export function getGlobalIngestionScheduler(): WaqiIngestionScheduler {
  if (!globalScheduler) {
    globalScheduler = new WaqiIngestionScheduler();
  }
  return globalScheduler;
}
