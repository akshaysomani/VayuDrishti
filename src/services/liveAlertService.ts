import type { LiveAlertPayload } from '../types/liveAlert';
import { createDemoFixture } from './liveDemoFixtures';

export interface FetchLiveAlertOptions {
  stationId?: string;
  city?: string;
  demo?: boolean;
  demoTier?: 'nominal' | 'watch' | 'elevated' | 'high' | 'stale' | 'error' | 'model_unavailable';
  seedHistory?: boolean;
  signal?: AbortSignal;
}

export interface IngestionStatusPayload {
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

/**
 * Client service to request live WAQI observations and model inference.
 * Targets the server-side /api/live/air-quality endpoint.
 */
export async function fetchLiveAlert(options: FetchLiveAlertOptions = {}): Promise<LiveAlertPayload> {
  const { stationId = 'DL001', city, demo = false, demoTier = 'watch', seedHistory = false, signal } = options;

  // Build query string
  const params = new URLSearchParams();
  if (stationId) params.set('stationId', stationId);
  if (city) params.set('city', city);
  if (demo) {
    params.set('demo', 'true');
    params.set('tier', demoTier);
  }
  if (seedHistory) {
    params.set('seedHistory', 'true');
  }

  const endpoint = `/api/live/air-quality?${params.toString()}`;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const payload = (await res.json()) as LiveAlertPayload;
    return payload;
  } catch (err: unknown) {
    // Graceful fallback for local offline testing if server endpoint unreachable
    console.warn('[LiveAlertService] Server API unavailable, using local client demo fixture:', err);
    return createDemoFixture(demo ? demoTier : 'watch', stationId);
  }
}

/**
 * Fetch current status of continuous ingestion scheduler and historical store
 */
export async function fetchIngestionStatus(): Promise<IngestionStatusPayload | null> {
  try {
    const res = await fetch('/api/live/ingestion-status', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as IngestionStatusPayload;
  } catch {
    return null;
  }
}

/**
 * Trigger immediate background ingestion poll
 */
export async function triggerPollNow(): Promise<boolean> {
  try {
    const res = await fetch('/api/live/poll-now', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
