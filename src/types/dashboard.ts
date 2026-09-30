/**
 * TypeScript interfaces for the India Air-Quality Early-Warning Platform
 * Defines both raw JSON schema and adapted display types.
 */

// ============================================================================
// 1. Raw JSON Types (strictly mirroring dashboard_data.json)
// ============================================================================

export type RawStationStatus = 'reporting' | 'silent';
export type RawCityStatus = 'all_reporting' | 'partial' | 'no_working_station';
export type RawGapCityType = 'never_registered' | 'registered_silent';

export interface RawStation {
  id: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  status: RawStationStatus;
  pop10km: number;
  days_with_data?: number;
  first_date?: string;
  last_date?: string;
  completeness?: number; // 0.0 to 1.0 (e.g. 0.895 = 89.5%)
  longest_gap_days?: number;
}

export interface RawCity {
  city: string;
  state: string;
  n_stations: number;
  n_reporting: number;
  lat: number;
  lon: number;
  pop10km: number;
  city_status: RawCityStatus;
  nearest_working_km: number;
  nearest_working_city: string;
}

export interface RawGapCity {
  city: string;
  state: string;
  lat: number;
  lon: number;
  type: RawGapCityType;
  approx_pop_m: number;
  nearest_working: string;
  dist_km: number;
}

export interface CoverageThreshold {
  within_km: number;
  people_m: number;
  share_pct: number;
}

export interface PopulationCell {
  lat: number;
  lon: number;
  pop: number;
  dist_km: number;
}

export interface AvailabilityMonthly {
  months: string[];
  days_with_data: Record<string, number[]>; // Station ID -> array of days per month
}

export interface DashboardMeta {
  data_period: string;
  population_source: string;
  coordinates: string;
  india_population_m: number;
  note: string;
}

export interface RawDashboardData {
  meta: DashboardMeta;
  stations: RawStation[];
  cities: RawCity[];
  gap_cities: RawGapCity[];
  coverage_thresholds: CoverageThreshold[];
  population_cells_025deg: PopulationCell[];
  availability_monthly: AvailabilityMonthly;
}

// ============================================================================
// 2. Standardized Display / Domain Types (Adapted by loader)
// ============================================================================

export type StationDisplayStatus = 'reporting_in_dataset' | 'no_usable_data';
export type CityDisplayStatus = 'all_reporting' | 'partial_reporting' | 'no_usable_data';
export type GapCityDisplayType = 'never_registered' | 'registered_no_usable_data';

export interface Station extends RawStation {
  displayStatus: StationDisplayStatus;
  displayStatusLabel: string;
  days_with_data: number;
  first_date: string;
  last_date: string;
  completeness: number;
  longest_gap_days: number;
}

export interface City extends RawCity {
  displayStatus: CityDisplayStatus;
  displayStatusLabel: string;
}

export interface GapCity extends RawGapCity {
  displayType: GapCityDisplayType;
  displayTypeLabel: string;
}

export interface DashboardData {
  meta: DashboardMeta;
  stations: Station[];
  cities: City[];
  gap_cities: GapCity[];
  coverage_thresholds: CoverageThreshold[];
  population_cells_025deg: PopulationCell[];
  availability_monthly: AvailabilityMonthly;
}

// Backward compatibility alias for raw station status
export type StationStatus = RawStationStatus;
export type CityStatus = RawCityStatus;
export type GapCityType = RawGapCityType;

// Visual and Semantic Types (Separating AQI Air Quality from Monitoring Infrastructure Health)
export type AQICategory = 
  | 'Good' 
  | 'Satisfactory' 
  | 'Moderate' 
  | 'Poor' 
  | 'Very Poor' 
  | 'Severe';

export interface AQIMetadata {
  category: AQICategory;
  range: [number, number];
  colorVar: string;
  bgVar: string;
  icon: string;
  description: string;
}

export type MonitorHealthCategory = 
  | 'Reporting in Dataset' 
  | 'Partial Coverage' 
  | 'No Usable Data in this Dataset' 
  | 'Unmonitored Gap';

export interface MonitorHealthMetadata {
  category: MonitorHealthCategory;
  symbol: string;
  pattern: 'solid' | 'half' | 'ring' | 'dashed';
  colorVar: string;
  bgVar: string;
  label: string;
  description: string;
}
