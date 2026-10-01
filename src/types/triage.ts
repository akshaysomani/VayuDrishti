/**
 * AI-Assisted Citizen Report Triage Types (Phase 5 f3b)
 * =====================================================
 * Advisory triage classifications for moderator efficiency.
 * Strictly internal to moderation: NEVER exposed publicly, NEVER feeds risk models.
 */

import type { CitizenReportCategory } from './citizenReport';

export type TriageLabel =
  | 'smoke'
  | 'fire'
  | 'haze_fog'
  | 'dust'
  | 'clear_normal'
  | 'not_relevant';

export type TriageStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'UNAVAILABLE';

export interface TriageResult {
  topLabel: TriageLabel;
  confidence: number;
  scores: Record<TriageLabel, number>;
  modelName: string;
  modelVersion: string;
}

export interface ReportTriageRecord {
  id: string;
  report_id: string;
  status: TriageStatus;
  model_name: string | null;
  model_version: string | null;
  suggested_label: TriageLabel | null;
  confidence: number | null;
  scores: Record<TriageLabel, number> | null;
  category_mismatch: boolean;
  error: string | null;
  attempts: number;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  lease_timeout_at?: string | null;
}

/**
 * Natural language prompts per label for zero-shot image classification
 */
export const TRIAGE_LABEL_PROMPTS: Record<TriageLabel, string> = {
  smoke: 'a photo of thick smoke rising from a chimney, factory, vehicle exhaust, or outdoor burning',
  fire: 'a photo of visible fire, flames, open burning, or agricultural crop residue burning',
  haze_fog: 'a photo of hazy foggy smoggy sky, low visibility urban atmosphere, or air pollution haze',
  dust: 'a photo of dust storm, blowing sand, loose soil, or construction dust in the air',
  clear_normal: 'a photo of clear blue sky, clean air, bright daylight, and normal outdoor visibility',
  not_relevant: 'an indoor scene, selfie, screenshot, text document, diagram, receipt, or unrelated object',
};

/**
 * Citizen category compatibility mapping:
 * Defines which model suggested labels are compatible with each citizen-selected category.
 * If model's top label is NOT in compatible list and confidence >= TRIAGE_MISMATCH_MIN_CONFIDENCE,
 * category_mismatch is flagged as true.
 */
export const CATEGORY_COMPATIBILITY_MAP: Record<CitizenReportCategory, TriageLabel[]> = {
  smoke: ['smoke', 'fire', 'haze_fog'],
  dust: ['dust', 'haze_fog'],
  burning: ['fire', 'smoke'],
  industrial_emission: ['smoke', 'dust', 'haze_fog'],
  construction_dust: ['dust', 'haze_fog'],
  other: ['smoke', 'fire', 'haze_fog', 'dust', 'clear_normal'], // 'other' compatible with any outdoor scene, mismatches only on 'not_relevant'
};

/**
 * Determines whether a triage suggestion conflicts with the citizen-selected category.
 * Invariant: Never flags mismatch if confidence is below mismatchThreshold or if label is null.
 */
export function evaluateCategoryMismatch(
  citizenCategory: CitizenReportCategory,
  suggestedLabel: TriageLabel | null,
  confidence: number | null,
  mismatchThreshold: number = 0.60,
  uncertainThreshold: number = 0.40
): { categoryMismatch: boolean; isUncertain: boolean } {
  if (!suggestedLabel || confidence === null) {
    return { categoryMismatch: false, isUncertain: true };
  }

  const isUncertain = confidence < uncertainThreshold;
  if (isUncertain) {
    return { categoryMismatch: false, isUncertain: true };
  }

  if (confidence < mismatchThreshold) {
    return { categoryMismatch: false, isUncertain: false };
  }

  const compatible = CATEGORY_COMPATIBILITY_MAP[citizenCategory] || [];
  const categoryMismatch = !compatible.includes(suggestedLabel);

  return { categoryMismatch, isUncertain: false };
}
