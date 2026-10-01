/**
 * Historical Observation Store & Canonical Phase 1 Feature Computation
 * ====================================================================
 * Maintains a 72-hour+ rolling observation buffer for ground monitoring stations
 * to enable genuine live model inference using the exact Phase 1 features:
 *   [0]: PM2.5 (instantaneous observation on day t)
 *   [1]: pm25_lag1 (daily average observation on day t-1)
 *   [2]: pm25_rolling3 (3-day backward rolling mean: [t-2, t-1, t])
 *   [3]: pm25_ratio_90 (PM2.5 / 90.0, ratio to CPCB acute spike threshold)
 *
 * Safety Policy:
 *   If historical telemetry is missing, incomplete, or contains date gaps,
 *   feature computation strictly fails and returns MODEL UNAVAILABLE.
 *   No synthetic, zero, or interpolated values are ever fabricated.
 */

export interface RawStationObservation {
  station_id: string;
  station_name: string;
  city: string;
  lat: number;
  lon: number;
  observed_at: string; // ISO 8601 timestamp
  ingested_at: string; // ISO 8601 timestamp
  pm25: number;        // µg/m³
  source: string;      // e.g. "WAQI"
  coord_quality: 'station' | 'manual' | 'suspect' | 'city_point';
}

export interface StationDailyObservation {
  station_id: string;
  date: string; // YYYY-MM-DD
  pm25: number;
}

export interface DailyStationAggregate {
  station_id: string;
  date: string; // YYYY-MM-DD
  mean_pm25: number;
  observation_count: number;
  min_pm25: number;
  max_pm25: number;
  first_observed_at: string;
  last_observed_at: string;
}

export interface Phase1FeatureResult {
  success: boolean;
  features?: {
    pm25: number;
    pm25_lag1: number;
    pm25_rolling3: number;
    pm25_ratio_90: number;
  };
  status:
    | 'complete'
    | 'insufficient_history'
    | 'missing_lag1'
    | 'missing_rolling3'
    | 'gap_detected'
    | 'invalid_current';
  reason: string;
  missingFeatures: string[];
  lastAvailableObservation: string | null;
  requiredHistoryWindow: string;
  historyDaysAvailable: number;
}

/**
 * Phase 1 Feature Definition for pm25_ratio_90:
 * In Phase 1 (scripts/phase1_final_model.py Line 141), pm25_ratio_90 is defined as:
 *   df["pm25_ratio_90"] = df["PM2.5"] / 90.0
 *
 * 90.0 is the fixed CPCB acute spike threshold (Poor/Severe boundary),
 * NOT a station-specific percentile, city-specific percentile, or 150.0.
 */
export function calculatePhase1Pm25Ratio90(pm25: number): number {
  if (pm25 == null || Number.isNaN(pm25) || pm25 < 0) {
    return NaN;
  }
  return pm25 / 90.0;
}

/**
 * Canonical Phase 1 feature computation function.
 * Evaluates whether genuine lag1 and rolling3 can be computed for the station on day t.
 */
export function computeLivePhase1Features(
  stationId: string,
  currentObservation: RawStationObservation,
  history: RawStationObservation[]
): Phase1FeatureResult {
  // 1. Validate current observation
  if (
    currentObservation.pm25 == null ||
    Number.isNaN(currentObservation.pm25) ||
    currentObservation.pm25 < 0
  ) {
    return {
      success: false,
      status: 'invalid_current',
      reason: 'Current observation PM2.5 is null, NaN, or negative.',
      missingFeatures: ['PM2.5', 'pm25_ratio_90', 'pm25_lag1', 'pm25_rolling3'],
      lastAvailableObservation: null,
      requiredHistoryWindow: '72 hours (days t-2 and t-1)',
      historyDaysAvailable: 0,
    };
  }

  const currentObsDate = new Date(currentObservation.observed_at);
  if (Number.isNaN(currentObsDate.getTime())) {
    return {
      success: false,
      status: 'invalid_current',
      reason: 'Current observation timestamp is malformed.',
      missingFeatures: ['PM2.5', 'pm25_ratio_90', 'pm25_lag1', 'pm25_rolling3'],
      lastAvailableObservation: null,
      requiredHistoryWindow: '72 hours (days t-2 and t-1)',
      historyDaysAvailable: 0,
    };
  }

  // Guard against future timestamps (> 5 min in future)
  if (currentObsDate.getTime() > Date.now() + 5 * 60 * 1000) {
    return {
      success: false,
      status: 'invalid_current',
      reason: 'Observation timestamp is in the future. Rejected to prevent temporal contamination.',
      missingFeatures: ['PM2.5', 'pm25_ratio_90', 'pm25_lag1', 'pm25_rolling3'],
      lastAvailableObservation: null,
      requiredHistoryWindow: '72 hours (days t-2 and t-1)',
      historyDaysAvailable: 0,
    };
  }

  const currentDateStr = currentObservation.observed_at.split('T')[0];

  // 2. Filter historical observations strictly belonging to this station prior to current observation
  const stationHistory = history
    .filter(
      (o) =>
        o.station_id === stationId &&
        o.observed_at < currentObservation.observed_at &&
        o.pm25 != null &&
        !Number.isNaN(o.pm25) &&
        o.pm25 >= 0
    )
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));

  if (stationHistory.length === 0) {
    return {
      success: false,
      status: 'insufficient_history',
      reason: `No prior historical observations exist for station ${stationId}. Minimum 72 hours of history required.`,
      missingFeatures: ['pm25_lag1', 'pm25_rolling3'],
      lastAvailableObservation: null,
      requiredHistoryWindow: '72 hours (days t-2 and t-1)',
      historyDaysAvailable: 0,
    };
  }

  // 3. Aggregate historical readings by calendar date (YYYY-MM-DD)
  const dateGroups: Record<string, number[]> = {};
  for (const obs of stationHistory) {
    const dStr = obs.observed_at.split('T')[0];
    if (dStr >= currentDateStr) continue; // Prior calendar days only
    if (!dateGroups[dStr]) {
      dateGroups[dStr] = [];
    }
    dateGroups[dStr].push(obs.pm25);
  }

  const uniqueHistoryDays = Object.keys(dateGroups).sort();
  const lastObs = stationHistory[stationHistory.length - 1];

  // Calculate target dates: yesterday (t-1) and day before yesterday (t-2)
  const oneDayMs = 24 * 60 * 60 * 1000;
  const t1Date = new Date(currentObsDate.getTime() - oneDayMs);
  const t2Date = new Date(currentObsDate.getTime() - 2 * oneDayMs);
  const t1DateStr = t1Date.toISOString().split('T')[0];
  const t2DateStr = t2Date.toISOString().split('T')[0];

  const t1Readings = dateGroups[t1DateStr];
  const t2Readings = dateGroups[t2DateStr];

  // Check lag1 (day t-1)
  if (!t1Readings || t1Readings.length === 0) {
    return {
      success: false,
      status: 'missing_lag1',
      reason: `Missing daily observation for yesterday (day t-1: ${t1DateStr}) on station ${stationId}. Required for pm25_lag1 and pm25_rolling3.`,
      missingFeatures: ['pm25_lag1', 'pm25_rolling3'],
      lastAvailableObservation: lastObs?.observed_at ?? null,
      requiredHistoryWindow: `72 hours (including ${t2DateStr} and ${t1DateStr})`,
      historyDaysAvailable: uniqueHistoryDays.length,
    };
  }

  // Check rolling3 history (day t-2)
  if (!t2Readings || t2Readings.length === 0) {
    return {
      success: false,
      status: 'missing_rolling3',
      reason: `Missing daily observation for day before yesterday (day t-2: ${t2DateStr}) on station ${stationId}. Required for 3-day backward rolling mean.`,
      missingFeatures: ['pm25_rolling3'],
      lastAvailableObservation: lastObs?.observed_at ?? null,
      requiredHistoryWindow: `72 hours (including ${t2DateStr} and ${t1DateStr})`,
      historyDaysAvailable: uniqueHistoryDays.length,
    };
  }

  // 4. Calculate exact Phase 1 daily values
  const lag1DailyAvg = t1Readings.reduce((sum, v) => sum + v, 0) / t1Readings.length;
  const lag2DailyAvg = t2Readings.reduce((sum, v) => sum + v, 0) / t2Readings.length;

  const pm25Current = currentObservation.pm25;
  const pm25Lag1 = lag1DailyAvg;
  const pm25Rolling3 = (lag2DailyAvg + lag1DailyAvg + pm25Current) / 3.0;
  const pm25Ratio90 = calculatePhase1Pm25Ratio90(pm25Current);

  return {
    success: true,
    status: 'complete',
    reason: `All 4 Phase 1 features successfully generated using ${t1Readings.length} readings on ${t1DateStr} and ${t2Readings.length} readings on ${t2DateStr}.`,
    features: {
      pm25: pm25Current,
      pm25_lag1: pm25Lag1,
      pm25_rolling3: pm25Rolling3,
      pm25_ratio_90: pm25Ratio90,
    },
    missingFeatures: [],
    lastAvailableObservation: lastObs.observed_at,
    requiredHistoryWindow: `72 hours (${t2DateStr} to ${currentDateStr})`,
    historyDaysAvailable: uniqueHistoryDays.length,
  };
}

/**
 * Service interface for station observation history storage
 */
export interface IStationHistoryStore {
  addObservation(obs: RawStationObservation): Promise<{ added: boolean; reason?: string }>;
  getStationObservations(stationId: string, minHours?: number): Promise<RawStationObservation[]>;
  getDailyAggregates(stationId: string, days?: number): Promise<DailyStationAggregate[]>;
  pruneStaleObservations(retentionHours?: number): Promise<number>;
  clearHistory(stationId?: string): Promise<void>;
  getStats(): Promise<{
    total_stations: number;
    total_observations: number;
    oldest_timestamp: string | null;
    newest_timestamp: string | null;
  }>;
}

/**
 * In-Memory Station History Store
 * Provides idempotent insertion, timestamp deduplication, out-of-order sorting,
 * and automatic age-based retention pruning.
 * (Persistent file-backed store lives in src/server/persistentStore.ts for server runtimes)
 */
export class InMemoryStationHistoryStore implements IStationHistoryStore {
  private memoryStore: Map<string, RawStationObservation[]> = new Map();

  public async addObservation(
    obs: RawStationObservation
  ): Promise<{ added: boolean; reason?: string }> {
    // Validation
    if (!obs.station_id || obs.station_id.trim() === '') {
      return { added: false, reason: 'Invalid station_id' };
    }
    if (obs.pm25 == null || Number.isNaN(obs.pm25) || obs.pm25 < 0) {
      return { added: false, reason: 'PM2.5 value must be a valid non-negative number' };
    }

    const obsTime = new Date(obs.observed_at).getTime();
    if (Number.isNaN(obsTime)) {
      return { added: false, reason: 'Malformed observed_at timestamp' };
    }

    // Future timestamp check (> 5 min in future)
    if (obsTime > Date.now() + 5 * 60 * 1000) {
      return { added: false, reason: 'Rejected observation: timestamp is in the future' };
    }

    let records = this.memoryStore.get(obs.station_id);
    if (!records) {
      records = [];
      this.memoryStore.set(obs.station_id, records);
    }

    // Deduplication check: same station + exact same observed_at
    const existingIdx = records.findIndex((r) => r.observed_at === obs.observed_at);
    if (existingIdx >= 0) {
      const existing = records[existingIdx];
      if (existing.pm25 === obs.pm25) {
        return { added: false, reason: 'Duplicate observation timestamp with identical value (ignored)' };
      }
      records[existingIdx] = { ...obs };
      return { added: true, reason: 'Updated existing timestamp with revised reading' };
    }

    // Insert and maintain chronological ascending sort
    records.push({ ...obs });
    records.sort((a, b) => a.observed_at.localeCompare(b.observed_at));

    // Prune entries older than 7 days (168 hours)
    const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const pruned = records.filter((r) => new Date(r.observed_at).getTime() >= cutoffTime);
    this.memoryStore.set(obs.station_id, pruned);

    return { added: true };
  }

  public async getStationObservations(
    stationId: string,
    minHours: number = 72
  ): Promise<RawStationObservation[]> {
    const records = this.memoryStore.get(stationId) ?? [];
    const cutoffTime = Date.now() - (minHours + 24) * 60 * 60 * 1000;
    return records.filter((r) => new Date(r.observed_at).getTime() >= cutoffTime);
  }

  public async getDailyAggregates(
    stationId: string,
    days: number = 7
  ): Promise<DailyStationAggregate[]> {
    const records = await this.getStationObservations(stationId, days * 24);
    const groups: Record<string, RawStationObservation[]> = {};

    for (const r of records) {
      const dStr = r.observed_at.split('T')[0];
      if (!groups[dStr]) groups[dStr] = [];
      groups[dStr].push(r);
    }

    const result: DailyStationAggregate[] = [];
    for (const [date, obsList] of Object.entries(groups)) {
      const vals = obsList.map((o) => o.pm25);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      result.push({
        station_id: stationId,
        date,
        mean_pm25: mean,
        observation_count: obsList.length,
        min_pm25: Math.min(...vals),
        max_pm25: Math.max(...vals),
        first_observed_at: obsList[0].observed_at,
        last_observed_at: obsList[obsList.length - 1].observed_at,
      });
    }

    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  public async pruneStaleObservations(retentionHours: number = 168): Promise<number> {
    const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000;
    let prunedTotal = 0;

    for (const [sid, records] of this.memoryStore.entries()) {
      const remaining = records.filter((r) => new Date(r.observed_at).getTime() >= cutoffTime);
      prunedTotal += records.length - remaining.length;
      this.memoryStore.set(sid, remaining);
    }

    return prunedTotal;
  }

  public async clearHistory(stationId?: string): Promise<void> {
    if (stationId) {
      this.memoryStore.delete(stationId);
    } else {
      this.memoryStore.clear();
    }
  }

  public async getStats(): Promise<{
    total_stations: number;
    total_observations: number;
    oldest_timestamp: string | null;
    newest_timestamp: string | null;
  }> {
    let totalObs = 0;
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const records of this.memoryStore.values()) {
      totalObs += records.length;
      for (const r of records) {
        if (!oldest || r.observed_at < oldest) oldest = r.observed_at;
        if (!newest || r.observed_at > newest) newest = r.observed_at;
      }
    }

    return {
      total_stations: this.memoryStore.size,
      total_observations: totalObs,
      oldest_timestamp: oldest,
      newest_timestamp: newest,
    };
  }
}

export const PersistentStationHistoryStore = InMemoryStationHistoryStore;
