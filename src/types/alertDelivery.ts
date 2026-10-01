/**
 * Phase 5 f4: Alert Delivery to Authorities - Type Definitions
 * ============================================================
 */

import type { RiskTier } from './alert';
import type { LiveExposureContext } from './liveAlert';

export type AlertDeliveryMode = 'dry_run' | 'live';

export type AlertChannel = 'email' | 'webhook';

export type RecipientScopeType = 'all' | 'city' | 'station';

export type AlertMinTier = 'WATCH' | 'ELEVATED' | 'HIGH';

export interface RecipientRecord {
  id: string;
  name: string;
  channel: AlertChannel;
  destination: string;
  secret_key?: string | null;
  scope_type: RecipientScopeType;
  scope_value?: string | null;
  min_tier?: AlertMinTier | null;
  active: boolean;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type RecipientCreateInput = Omit<RecipientRecord, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>;

export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'DEAD' | 'DRY_RUN';

export interface StructuredAlertMessage {
  alert_id: string;
  station_id: string;
  station_name: string;
  city: string;
  probability: number;
  tier: RiskTier;
  expected_people_exposed: number;
  coord_quality: 'station' | 'manual' | 'suspect' | 'city_point';
  source_observation_timestamp: string;
  model_version: string;
  dashboard_url: string;
  is_test?: boolean;
  disclaimer: string;
  coord_quality_note?: string | null;
  exposure_context?: LiveExposureContext | null;
}

export interface AlertOutboxRecord {
  id: string;
  station_id: string;
  station_name: string | null;
  city: string;
  probability: number;
  tier: RiskTier;
  source_observation_timestamp: string;
  model_version: string;
  coord_quality: string;
  expected_people_exposed: number | null;
  payload: StructuredAlertMessage;
  dedupe_key: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_expires_at?: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type OutboxCreateInput = Omit<
  AlertOutboxRecord,
  'id' | 'attempts' | 'created_at' | 'updated_at' | 'last_error' | 'lease_expires_at'
>;

export interface AlertDeliveryRecord {
  id: string;
  outbox_id: string;
  recipient_id: string | null;
  channel: AlertChannel;
  recipient_destination: string;
  status: 'SENT' | 'FAILED' | 'DRY_RUN';
  provider_response_code: number | null;
  provider_response_body: string | null;
  error_message: string | null;
  delivered_at: string;
}

export type AlertDeliveryCreateInput = Omit<AlertDeliveryRecord, 'id' | 'delivered_at'>;

export interface StationCooldownState {
  station_id: string;
  last_alerted_tier: RiskTier;
  last_alerted_at: string;
  cooldown_expires_at: string;
  in_cooldown: boolean;
  active_tier: RiskTier;
}

export interface PublicRecentDelivery {
  channel: AlertChannel;
  status: 'SENT' | 'FAILED' | 'DRY_RUN';
  station: string;
  tier: RiskTier;
  timestamp: string;
}

export interface AlertDeliveryStats {
  mode: AlertDeliveryMode;
  is_dispatcher_running: boolean;
  last_dispatcher_run_at: string | null;
  counts_by_status: Record<OutboxStatus, number>;
  total_recipients: number;
  active_recipients: number;
  recent_deliveries: PublicRecentDelivery[];
  cooldowns: Record<string, StationCooldownState>;
}

export interface AdminAlertDeliveryStats extends Omit<AlertDeliveryStats, 'recent_deliveries'> {
  recent_deliveries: AlertDeliveryRecord[];
}

