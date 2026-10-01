/**
 * VayuDrishti Phase 5 f3: Citizen Photo Report Domain Types
 * ==========================================================
 * Observational ground context submitted by citizens.
 * STRICT ISOLATION NOTE: Citizen reports are CONTEXT ONLY.
 * They MUST NOT be used in feature engineering, model training,
 * inference, or risk tier calculations.
 */

export type CitizenReportCategory =
  | 'smoke'
  | 'dust'
  | 'burning'
  | 'industrial_emission'
  | 'construction_dust'
  | 'other';

export type CitizenReportStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface CitizenReportRecord {
  id: string;
  status: CitizenReportStatus;
  category: CitizenReportCategory;
  description: string;
  lat: number;
  lon: number;
  nearest_station_id: string | null;
  nearest_station_name: string | null;
  nearest_station_distance_km: number | null;
  image_key: string;
  thumb_key: string;
  content_hash: string;
  client_timestamp: string | null;
  created_at: string;
  moderated_at: string | null;
  moderation_reason: string | null;
}

export interface PublicCitizenReport {
  id: string;
  category: CitizenReportCategory;
  description: string;
  lat: number;
  lon: number;
  nearest_station_id: string | null;
  nearest_station_name: string | null;
  nearest_station_distance_km: number | null;
  image_url: string;
  thumb_url: string;
  created_at: string;
  /** Explicit verification badge */
  is_verified: false;
  disclaimer: 'Citizen unverified observation. Not used in predictive risk models.';
}

export interface CreateReportRequestPayload {
  category: CitizenReportCategory;
  description?: string;
  lat: number;
  lon: number;
  client_timestamp?: string;
  honeypot?: string;
}

export interface ModerationReviewRequest {
  report_id: string;
  action: 'APPROVE' | 'REJECT';
  reason?: string;
}

export interface ModerationPrecheckResult {
  passed: boolean;
  reason?: string;
  contentHash: string;
  width: number;
  height: number;
  format: string;
}

export const CITIZEN_REPORT_CATEGORIES: {
  value: CitizenReportCategory;
  label: string;
  description: string;
}[] = [
  { value: 'smoke', label: 'Visible Smoke', description: 'Dense smoke plumes from unknown origins' },
  { value: 'burning', label: 'Open Biomass Burning', description: 'Agricultural stubble, leaves, or garbage fires' },
  { value: 'dust', label: 'Dust Storm / Road Dust', description: 'Suspended airborne dust or sweeping' },
  { value: 'construction_dust', label: 'Construction Dust', description: 'Uncovered construction materials or demolition' },
  { value: 'industrial_emission', label: 'Industrial Emission', description: 'Factory chimneys or industrial exhaust' },
  { value: 'other', label: 'Other Visible Haze', description: 'Other visible localized particulate matter' },
];
