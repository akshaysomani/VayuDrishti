/**
 * Alert Delivery Policy Engine
 * ============================
 * Evaluates live observation and inference results against authoritative delivery rules:
 *
 * 1. Genuine Inference Guard:
 *    - Rejects DEMO/fixture payloads.
 *    - Rejects stale observations (is_stale = true).
 *    - Rejects MODEL UNAVAILABLE or incomplete features.
 *
 * 2. Minimum Tier Policy:
 *    - Uses canonical tier classification from getRiskTier().
 *    - Configurable ALERT_MIN_TIER env var (default: ELEVATED, p >= 0.22).
 *    - Preserves dashboard threshold (p >= 0.05) untouched.
 *
 * 3. Cooldown & Escalation Logic:
 *    - Per-station cooldown window (default: 6 hours).
 *    - Allows immediate re-notification within cooldown ONLY if tier escalates (e.g. Elevated -> High).
 *
 * 4. Deduplication:
 *    - Computes unique deterministic key (station_id:tier:source_observation_timestamp).
 *
 * 5. Honest Disclaimers:
 *    - Explicitly attaches model-based early warning notice and coordinate fallback warnings.
 */

import { getRiskTier, type RiskTier } from '../../types/alert';
import { LIVE_ALERT_STALE_HOURS, type LiveAlertPayload } from '../../types/liveAlert';
import type {
  OutboxCreateInput,
  StructuredAlertMessage,
  AlertMinTier,
} from '../../types/alertDelivery';
import type { IAlertDeliveryStore } from '../storage/alertDeliveryStore';

export const TIER_RANKS: Record<RiskTier, number> = {
  Nominal: 0,
  Watch: 1,
  Elevated: 2,
  High: 3,
};

export function getAlertMaxAgeHours(): number {
  const envVal = process.env.ALERT_MAX_AGE_HOURS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return LIVE_ALERT_STALE_HOURS;
}

export function calculateObservationAgeHours(
  sourceTimestamp: string | Date,
  atTime: Date = new Date()
): number {
  const obsMs = new Date(sourceTimestamp).getTime();
  const diffMs = atTime.getTime() - obsMs;
  return Math.max(0, diffMs / (3600 * 1000));
}

export function formatObservationAge(ageHours: number): string {
  const rounded = Math.round(ageHours * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
}

export function formatObservationAgeNote(
  sourceTimestamp: string,
  ageHours: number
): string {
  return `Source observation: ${sourceTimestamp}, ${formatObservationAge(ageHours)} h ago at send time`;
}

export function formatIssuedLateNote(sourceTimestamp: string): string {
  return `Issued late: source observation at ${sourceTimestamp}`;
}

export function generateDedupeKey(stationId: string, tier: string, sourceTimestamp: string): string {
  return `${stationId}:${tier}:${sourceTimestamp}`;
}

export interface PolicyEvaluationResult {
  shouldDeliver: boolean;
  reason?: string;
  isEscalation?: boolean;
  outboxItem?: OutboxCreateInput;
}

export class AlertDeliveryPolicy {
  private store: IAlertDeliveryStore;
  private minTierOption?: AlertMinTier;
  private cooldownHoursOption?: number;

  constructor(store: IAlertDeliveryStore, options?: { minTier?: AlertMinTier; cooldownHours?: number }) {
    this.store = store;
    this.minTierOption = options?.minTier;
    this.cooldownHoursOption = options?.cooldownHours;
  }

  /**
   * Resolves configured minimum alert tier for delivery.
   * Default: ELEVATED (p >= 0.22).
   */
  public getMinTier(): AlertMinTier {
    if (this.minTierOption) return this.minTierOption;
    const raw = (process.env.ALERT_MIN_TIER || 'ELEVATED').toUpperCase().trim();
    if (raw === 'WATCH') return 'WATCH';
    if (raw === 'HIGH') return 'HIGH';
    return 'ELEVATED';
  }

  public getCooldownHours(): number {
    if (this.cooldownHoursOption !== undefined) return this.cooldownHoursOption;
    const val = parseInt(process.env.ALERT_COOLDOWN_HOURS || '6', 10);
    return isNaN(val) || val <= 0 ? 6 : val;
  }

  public async evaluate(payload: LiveAlertPayload): Promise<PolicyEvaluationResult> {
    return this.evaluatePayload(payload);
  }

  public async evaluatePayload(payload: LiveAlertPayload): Promise<PolicyEvaluationResult> {
    // -------------------------------------------------------------------------
    // Rule 1: Genuine Model Inference Only
    // -------------------------------------------------------------------------
    if (payload.is_demo) {
      return { shouldDeliver: false, reason: 'Suppressed: Demo or fixture payload is not eligible for delivery.' };
    }

    if (payload.status !== 'fresh') {
      return { shouldDeliver: false, reason: `Suppressed: Non-fresh status "${payload.status}".` };
    }

    if (payload.observation.is_stale) {
      return { shouldDeliver: false, reason: `Suppressed: Observation timestamp is stale (${payload.observation.age_minutes}m old).` };
    }

    if (!payload.features_complete || !payload.inference) {
      return { shouldDeliver: false, reason: 'Suppressed: Features incomplete or model inference unavailable.' };
    }

    if (payload.error_message && payload.error_message.includes('MODEL UNAVAILABLE')) {
      return { shouldDeliver: false, reason: `Suppressed: ${payload.error_message}` };
    }

    const inference = payload.inference;
    const probability = inference.probability;
    const tierInfo = getRiskTier(probability);

    if (!tierInfo || !tierInfo.alertFired || tierInfo.tier === 'Nominal') {
      return { shouldDeliver: false, reason: `Suppressed: Nominal tier (p = ${probability.toFixed(3)}) does not fire alerts.` };
    }

    const currentTier = tierInfo.tier;
    const currentTierRank = TIER_RANKS[currentTier];

    // -------------------------------------------------------------------------
    // Rule 2: Minimum Tier Delivery Policy
    // -------------------------------------------------------------------------
    const minTierSetting = this.getMinTier();
    const minRank = minTierSetting === 'WATCH' ? 1 : minTierSetting === 'HIGH' ? 3 : 2;

    if (currentTierRank < minRank) {
      return {
        shouldDeliver: false,
        reason: `Suppressed by delivery policy: Current tier "${currentTier}" is below configured ALERT_MIN_TIER "${minTierSetting}".`,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 3: Cooldown & Escalation Check
    // -------------------------------------------------------------------------
    const stationId = payload.observation.station_id;
    const lastAlert = await this.store.getStationLastAlert(stationId);
    let isEscalation = false;

    if (lastAlert) {
      const cooldownHours = this.getCooldownHours();
      const lastAlertTimeMs = lastAlert.createdAt.getTime();
      const nowMs = Date.now();
      const cooldownExpiresAtMs = lastAlertTimeMs + cooldownHours * 60 * 60 * 1000;

      if (nowMs < cooldownExpiresAtMs) {
        const lastTierRank = TIER_RANKS[lastAlert.tier] ?? 0;
        if (currentTierRank > lastTierRank) {
          // Tier escalated (e.g. Elevated -> High)! Escalation bypasses cooldown window.
          isEscalation = true;
        } else {
          const remainingMinutes = Math.ceil((cooldownExpiresAtMs - nowMs) / (60 * 1000));
          return {
            shouldDeliver: false,
            reason: `Suppressed by cooldown: Station "${stationId}" alerted ${lastAlert.tier} recently. Cooldown active for ${remainingMinutes} more minutes.`,
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Rule 4: Construct Structured Message & Dedupe Key
    // -------------------------------------------------------------------------
    const sourceTimestamp = payload.observation.observed_at;
    const dedupeKey = `${stationId}:${currentTier}:${sourceTimestamp}`;
    const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:5173';

    let coordQualityNote: string | null = null;
    if (payload.observation.coord_quality === 'city_point' || payload.observation.coord_quality === 'suspect') {
      coordQualityNote =
        'Notice: Monitoring coordinates use city-point centroid or suspect location. Spatial population exposure is an estimate.';
    }

    const message: StructuredAlertMessage = {
      alert_id: '', // Will be assigned by outbox row ID
      station_id: stationId,
      station_name: payload.observation.station_name,
      city: payload.observation.city,
      probability,
      tier: currentTier,
      expected_people_exposed: payload.exposure?.station_population_5km ?? 0,
      coord_quality: payload.observation.coord_quality,
      source_observation_timestamp: sourceTimestamp,
      model_version: inference.model_version || 'Phase 1 Calibrated LR v1.0',
      dashboard_url: `${dashboardBaseUrl}/#alerts`,
      disclaimer: 'Model-based early-warning estimate, not a confirmed measurement.',
      coord_quality_note: coordQualityNote,
      exposure_context: payload.exposure,
    };

    const outboxItem: OutboxCreateInput = {
      station_id: stationId,
      station_name: payload.observation.station_name,
      city: payload.observation.city,
      probability,
      tier: currentTier,
      source_observation_timestamp: sourceTimestamp,
      model_version: inference.model_version || 'Phase 1 Calibrated LR v1.0',
      coord_quality: payload.observation.coord_quality,
      expected_people_exposed: payload.exposure?.station_population_5km ?? null,
      payload: message,
      dedupe_key: dedupeKey,
      status: 'PENDING',
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
    };

    return {
      shouldDeliver: true,
      isEscalation,
      outboxItem,
    };
  }
}
