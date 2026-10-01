import modelParams from '../data/shipped_model_parameters.json';
import { getRiskTier } from '../types/alert';
import type { LiveModelFeatures, LiveModelInference } from '../types/liveAlert';

import { calculatePhase1Pm25Ratio90 } from './historicalObservationStore';

/**
 * Mathematical evaluation of the shipped Calibrated Logistic Regression model.
 * Pipeline: StandardScaler -> LogisticRegression -> IsotonicRegression Calibrator.
 * Uses exact trained coefficients and knots from models/phase1_final_logreg.pkl.
 *
 * Shipped Model Features (strict order):
 *   [0]: PM2.5 (day t observation)
 *   [1]: pm25_lag1 (day t-1 observation)
 *   [2]: pm25_rolling3 (3-day rolling mean: [t-2, t-1, t])
 *   [3]: pm25_ratio_90 (PM2.5 / 90.0, ratio to CPCB acute spike threshold)
 */
export function runShippedModelInference(
  features: LiveModelFeatures,
  observedAt: string
): { inference: LiveModelInference | null; isComplete: boolean; missingFeatures: string[] } {
  const missing: string[] = [];

  if (features.pm25 === undefined || features.pm25 === null || isNaN(features.pm25)) {
    missing.push('PM2.5');
  }
  if (features.pm25_lag1 === undefined || features.pm25_lag1 === null || isNaN(features.pm25_lag1)) {
    missing.push('pm25_lag1');
  }
  if (features.pm25_rolling3 === undefined || features.pm25_rolling3 === null || isNaN(features.pm25_rolling3)) {
    missing.push('pm25_rolling3');
  }

  // Phase 1 definition: pm25_ratio_90 = PM2.5 / 90.0
  const ratio90 = features.pm25_ratio_90 ?? (features.pm25 != null ? calculatePhase1Pm25Ratio90(features.pm25) : NaN);
  if (ratio90 === undefined || ratio90 === null || isNaN(ratio90)) {
    missing.push('pm25_ratio_90');
  }

  if (missing.length > 0) {
    return {
      inference: null,
      isComplete: false,
      missingFeatures: missing,
    };
  }

  // Exact 4-feature vector preserving model order: [PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90]
  const rawVec = [features.pm25, features.pm25_lag1!, features.pm25_rolling3!, ratio90];

  // 1. StandardScaler transformation: z = (x - mean) / scale
  const mean = modelParams.scaler.mean;
  const scale = modelParams.scaler.scale;
  const coef = modelParams.classifier.coefficients;
  const intercept = modelParams.classifier.intercept;

  let logit = intercept;
  for (let i = 0; i < rawVec.length; i++) {
    const scaledVal = (rawVec[i] - mean[i]) / scale[i];
    logit += scaledVal * coef[i];
  }

  // 2. Logistic sigmoid: raw probability
  const rawProbability = 1.0 / (1.0 + Math.exp(-logit));

  // 3. Isotonic Regression Calibration: piecewise linear interpolation over knots
  const xKnots = modelParams.isotonic_calibrator.x_thresholds;
  const yKnots = modelParams.isotonic_calibrator.y_thresholds;

  let calibratedProb: number;
  if (rawProbability <= xKnots[0]) {
    calibratedProb = yKnots[0];
  } else if (rawProbability >= xKnots[xKnots.length - 1]) {
    calibratedProb = yKnots[yKnots.length - 1];
  } else {
    // Binary search for interval
    let low = 0;
    let high = xKnots.length - 1;
    let knotIdx = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (xKnots[mid] <= rawProbability && rawProbability <= xKnots[mid + 1]) {
        knotIdx = mid;
        break;
      }
      if (xKnots[mid] > rawProbability) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    const x0 = xKnots[knotIdx];
    const x1 = xKnots[knotIdx + 1];
    const y0 = yKnots[knotIdx];
    const y1 = yKnots[knotIdx + 1];
    const fraction = (rawProbability - x0) / (x1 - x0);
    calibratedProb = y0 + fraction * (y1 - y0);
  }

  // Bound probability between 0 and 1
  calibratedProb = Math.max(0.0, Math.min(1.0, calibratedProb));

  // 4. Map to Canonical Risk Tier (Phase 2f Scheme)
  const tierInfo = getRiskTier(calibratedProb);
  if (!tierInfo) {
    throw new Error(`[Model Error] Unable to determine risk tier for probability ${calibratedProb}`);
  }

  return {
    inference: {
      model_version: modelParams.version,
      model_name: modelParams.model_name,
      probability: calibratedProb,
      risk_tier: tierInfo,
      alert_fired: calibratedProb >= modelParams.alert_threshold,
      input_timestamp: new Date().toISOString(),
      source_timestamp: observedAt,
      features_used: {
        pm25: rawVec[0],
        pm25_lag1: rawVec[1],
        pm25_rolling3: rawVec[2],
        pm25_ratio_90: rawVec[3],
      },
      explanation: `Calibrated spike probability ${Math.round(calibratedProb * 100)}% based on day t PM2.5 (${rawVec[0].toFixed(1)} µg/m³), lag1 (${rawVec[1].toFixed(1)} µg/m³), and 3-day rolling (${rawVec[2].toFixed(1)} µg/m³).`,
    },
    isComplete: true,
    missingFeatures: [],
  };
}
