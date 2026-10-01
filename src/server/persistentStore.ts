/**
 * Persistent Station History Store (Server-Side)
 * ===============================================
 * File-backed persistence for ground station observations using Node.js fs.
 * Kept strictly in src/server/ so browser client bundles never pull in Node built-ins.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RawStationObservation,
  DailyStationAggregate,
  IStationHistoryStore,
} from '../services/historicalObservationStore';

export class PersistentStationHistoryStore implements IStationHistoryStore {
  private memoryStore: Map<string, RawStationObservation[]> = new Map();
  private filePath: string | null = null;
  private isPersisting: boolean = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? 'src/data/live_history/station_history.json';
    this.loadFromFile();
  }

  private loadFromFile(): void {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, RawStationObservation[]>;
        this.memoryStore.clear();
        for (const [sid, records] of Object.entries(data)) {
          this.memoryStore.set(sid, records);
        }
      }
    } catch {
      // Fallback to empty memory store
    }
  }

  private saveToFile(): void {
    if (!this.filePath || this.isPersisting) return;
    this.isPersisting = true;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized: Record<string, RawStationObservation[]> = {};
      for (const [sid, records] of this.memoryStore.entries()) {
        serialized[sid] = records;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(serialized, null, 2), 'utf8');
    } catch {
      // Best-effort file persistence
    } finally {
      this.isPersisting = false;
    }
  }

  public async addObservation(
    obs: RawStationObservation
  ): Promise<{ added: boolean; reason?: string }> {
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
      // Update with fresher ingestion if value differs
      records[existingIdx] = { ...obs };
      this.saveToFile();
      return { added: true, reason: 'Updated existing timestamp with revised reading' };
    }

    // Insert and maintain chronological ascending sort
    records.push({ ...obs });
    records.sort((a, b) => a.observed_at.localeCompare(b.observed_at));

    // Prune entries older than 7 days (168 hours)
    const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const pruned = records.filter((r) => new Date(r.observed_at).getTime() >= cutoffTime);
    this.memoryStore.set(obs.station_id, pruned);

    this.saveToFile();
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

    if (prunedTotal > 0) {
      this.saveToFile();
    }
    return prunedTotal;
  }

  public async clearHistory(stationId?: string): Promise<void> {
    if (stationId) {
      this.memoryStore.delete(stationId);
    } else {
      this.memoryStore.clear();
    }
    this.saveToFile();
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

let globalStore: PersistentStationHistoryStore | null = null;

export function getGlobalStationHistoryStore(filePath?: string): PersistentStationHistoryStore {
  if (!globalStore) {
    globalStore = new PersistentStationHistoryStore(filePath);
  }
  return globalStore;
}
