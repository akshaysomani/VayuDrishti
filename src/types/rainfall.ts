/**
 * Rainfall & Heavy-Rain Hazard Type Definitions
 * ============================================
 * Provides data structures for Open-Meteo rainfall acquisition,
 * climatological baselines, and IMD-aligned heavy-rain classification.
 */

/**
 * Mandatory Open-Meteo Attribution per CC BY 4.0 license terms.
 * Must be referenced in documentation and user-facing dashboards.
 */
export const OPEN_METEO_ATTRIBUTION = {
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  citation: 'Weather data by Open-Meteo.com under CC BY 4.0 (https://open-meteo.com/)',
} as const;

export const OPEN_METEO_ATTRIBUTION_STRING =
  'Weather data by Open-Meteo.com under CC BY 4.0 (https://open-meteo.com/)';

/**
 * Mandatory label for all rainfall hazard module outputs.
 */
export const HEAVY_RAIN_HAZARD_LABEL =
  'Unvalidated Heavy-Rain Hazard Index - model-based estimate, not an inundation forecast';

/**
 * Geographic Centroid for a Monitoring City derived from Phase 2 station locations.
 */
export interface CityCentroid {
  city: string;
  latitude: number;
  longitude: number;
  stationCount: number;
}

/**
 * Daily Precipitation Record from Open-Meteo Historical Archive API (ERA5).
 */
export interface DailyPrecipitationRecord {
  date: string; // YYYY-MM-DD
  precipitation_sum_mm: number;
}

/**
 * Download Manifest Entry for Reproducibility and Cache Validation.
 */
export interface RainfallManifestItem {
  city: string;
  latitude: number;
  longitude: number;
  url_template: string;
  start_date: string;
  end_date: string;
  model: string;
  total_days: number;
  sha256: string;
  cached_filename: string;
  acquired_at: string;
}

export interface RainfallManifest {
  period: string; // '1991-2020'
  model: string; // 'era5'
  source: string; // 'Open-Meteo Historical Weather API'
  attribution: typeof OPEN_METEO_ATTRIBUTION;
  total_cities: number;
  total_calls_made: number;
  created_at: string;
  cities: Record<string, RainfallManifestItem>;
}

/**
 * Climatological Quantiles for a Given Precipitation Series.
 */
export interface PrecipitationPercentiles {
  p80_mm: number;
  p90_mm: number;
  p95_mm: number;
  p98_mm: number;
}

/**
 * Comprehensive Climatological Baseline per City (WMO Standard Normal 1991-2020).
 */
export interface CityClimatologySummary {
  city: string;
  latitude: number;
  longitude: number;
  stationCount: number;
  period: string; // '1991-2020'
  total_days: number;
  wet_day_threshold_mm: number; // 1.0 mm/day
  
  // All-year metrics
  all_year: {
    wet_day_count: number;
    wet_day_percentage: number;
    mean_annual_precipitation_mm: number;
    daily_percentiles: PrecipitationPercentiles;
    rolling_3day_percentiles: PrecipitationPercentiles;
    mean_annual_max_daily_mm: number;
    all_time_max_daily_mm: number;
    all_time_max_daily_date: string;
  };

  // Monsoon season metrics (June - September, JJAS)
  monsoon: {
    wet_day_count: number;
    wet_day_percentage: number;
    monsoon_precipitation_share_pct: number;
    daily_percentiles: PrecipitationPercentiles;
    rolling_3day_percentiles: PrecipitationPercentiles;
    mean_annual_max_daily_mm: number;
    max_daily_mm: number;
    max_daily_date: string;
  };
}

export interface ClimatologyDatasetSummary {
  generated_at: string;
  wmo_normal_period: string; // '1991-2020'
  model: string; // 'ERA5 via Open-Meteo'
  attribution: typeof OPEN_METEO_ATTRIBUTION;
  wet_day_threshold_mm: number;
  cities: Record<string, CityClimatologySummary>;
}
