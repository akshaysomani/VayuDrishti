import rawData from './dashboard_data.json';
import type {
  RawDashboardData,
  DashboardData,
  Station,
  City,
  GapCity,
  CoverageThreshold,
  PopulationCell,
  AvailabilityMonthly,
  DashboardMeta,
  StationDisplayStatus,
  CityDisplayStatus,
  GapCityDisplayType,
} from '../types/dashboard';

const raw = rawData as RawDashboardData;

// ============================================================================
// Explicit Adapters & Runtime Assertions
// ============================================================================

/**
 * Adapts raw station status ('reporting' | 'silent') to standardized display status.
 * Throws with a descriptive error if an unknown status is encountered.
 */
export function adaptStationStatus(
  status: string,
  stationId: string
): { displayStatus: StationDisplayStatus; displayStatusLabel: string } {
  switch (status) {
    case 'reporting':
      return {
        displayStatus: 'reporting_in_dataset',
        displayStatusLabel: 'Reporting in dataset',
      };
    case 'silent':
      return {
        displayStatus: 'no_usable_data',
        displayStatusLabel: 'No usable data in this dataset',
      };
    default:
      throw new Error(
        `[Adapter Error] Unrecognized station status: "${status}" for station "${stationId}". ` +
          `Recognized raw values are "reporting" and "silent".`
      );
  }
}

/**
 * Adapts raw city status ('all_reporting' | 'partial' | 'no_working_station') to display status.
 * Throws with a descriptive error if an unknown status is encountered.
 */
export function adaptCityStatus(
  cityStatus: string,
  cityName: string
): { displayStatus: CityDisplayStatus; displayStatusLabel: string } {
  switch (cityStatus) {
    case 'all_reporting':
      return {
        displayStatus: 'all_reporting',
        displayStatusLabel: 'All reporting in dataset',
      };
    case 'partial':
      return {
        displayStatus: 'partial_reporting',
        displayStatusLabel: 'Partial reporting in dataset',
      };
    case 'no_working_station':
      return {
        displayStatus: 'no_usable_data',
        displayStatusLabel: 'No usable data in this dataset',
      };
    default:
      throw new Error(
        `[Adapter Error] Unrecognized city status: "${cityStatus}" for city "${cityName}". ` +
          `Recognized raw values are "all_reporting", "partial", and "no_working_station".`
      );
  }
}

/**
 * Adapts raw gap city type ('never_registered' | 'registered_silent') to display type.
 * Throws with a descriptive error if an unknown type is encountered.
 */
export function adaptGapCityType(
  type: string,
  cityName: string
): { displayType: GapCityDisplayType; displayTypeLabel: string } {
  switch (type) {
    case 'never_registered':
      return {
        displayType: 'never_registered',
        displayTypeLabel: 'Not listed in this dataset',
      };
    case 'registered_silent':
      return {
        displayType: 'registered_no_usable_data',
        displayTypeLabel: 'Listed in this dataset, but no usable data',
      };
    default:
      throw new Error(
        `[Adapter Error] Unrecognized gap city type: "${type}" for gap city "${cityName}". ` +
          `Recognized raw values are "never_registered" and "registered_silent".`
      );
  }
}

// ============================================================================
// Runtime Validation & Translation of Raw Data
// ============================================================================

const adaptedStations: Station[] = raw.stations.map((s) => {
  const adaptation = adaptStationStatus(s.status, s.id);
  return {
    ...s,
    ...adaptation,
    days_with_data: s.days_with_data ?? 0,
    first_date: s.first_date ?? '—',
    last_date: s.last_date ?? '—',
    completeness: s.completeness ?? 0,
    longest_gap_days: s.longest_gap_days ?? 0,
  };
});

const adaptedCities: City[] = raw.cities.map((c) => {
  const adaptation = adaptCityStatus(c.city_status, c.city);
  return {
    ...c,
    ...adaptation,
  };
});

const adaptedGapCities: GapCity[] = raw.gap_cities.map((g) => {
  const adaptation = adaptGapCityType(g.type, g.city);
  return {
    ...g,
    ...adaptation,
  };
});

const data: DashboardData = {
  meta: raw.meta,
  stations: adaptedStations,
  cities: adaptedCities,
  gap_cities: adaptedGapCities,
  coverage_thresholds: raw.coverage_thresholds,
  population_cells_025deg: raw.population_cells_025deg,
  availability_monthly: raw.availability_monthly,
};

// ============================================================================
// Status Counts Verification Helper
// ============================================================================

export function getStatusCounts() {
  const stations = {
    reporting: 0,
    no_usable_data: 0,
  };
  for (const s of data.stations) {
    if (s.displayStatus === 'reporting_in_dataset') {
      stations.reporting += 1;
    } else if (s.displayStatus === 'no_usable_data') {
      stations.no_usable_data += 1;
    }
  }

  const gapCities = {
    total: data.gap_cities.length,
    never_registered: 0,
    registered_silent: 0,
  };
  for (const g of data.gap_cities) {
    if (g.displayType === 'never_registered') {
      gapCities.never_registered += 1;
    } else if (g.displayType === 'registered_no_usable_data') {
      gapCities.registered_silent += 1;
    }
  }

  const cities = {
    total: data.cities.length,
    no_working_station: 0,
    all_reporting: 0,
    partial: 0,
  };
  for (const c of data.cities) {
    if (c.city_status === 'no_working_station') {
      cities.no_working_station += 1;
    } else if (c.city_status === 'all_reporting') {
      cities.all_reporting += 1;
    } else if (c.city_status === 'partial') {
      cities.partial += 1;
    }
  }

  return {
    stations,
    gapCities,
    cities,
  };
}

// ============================================================================
// Public Loaders
// ============================================================================

export async function getDashboardData(): Promise<DashboardData> {
  return data;
}

export async function getStations(): Promise<Station[]> {
  return data.stations;
}

export async function getCities(): Promise<City[]> {
  return data.cities;
}

export async function getGapCities(): Promise<GapCity[]> {
  return data.gap_cities;
}

export async function getCoverageThresholds(): Promise<CoverageThreshold[]> {
  return data.coverage_thresholds;
}

export async function getPopulationCells(): Promise<PopulationCell[]> {
  return data.population_cells_025deg;
}

export async function getAvailabilityMonthly(): Promise<AvailabilityMonthly> {
  return data.availability_monthly;
}

export async function getMeta(): Promise<DashboardMeta> {
  return data.meta;
}

export function getHeadlineCoverageStat(): {
  threshold: CoverageThreshold;
  statText: string;
  sourceNote: string;
} {
  const threshold10km = data.coverage_thresholds.find((t) => t.within_km === 10) ?? {
    within_km: 10,
    people_m: 64.3,
    share_pct: 4.8,
  };

  return {
    threshold: threshold10km,
    statText: `Only ${threshold10km.share_pct}% of India's population lives within ${threshold10km.within_km} km of a monitoring station in this dataset (${threshold10km.people_m}M of 1,339M)`,
    sourceNote: `Population is WorldPop 2017 (1 km). Station set is the CPCB extract in this dataset (historical data from 2015-01-01 to 2020-07-01).`,
  };
}

export function getNetworkSummary() {
  const counts = getStatusCounts();
  const totalStations = data.stations.length;
  const reportingStations = counts.stations.reporting;
  const noDataStations = counts.stations.no_usable_data;
  const reportingPct = totalStations > 0 ? (reportingStations / totalStations) * 100 : 0;

  return {
    totalStations,
    reportingStations,
    noDataStations,
    reportingPct: Math.round(reportingPct * 10) / 10,
    totalCities: counts.cities.total,
    fullCities: counts.cities.all_reporting,
    partialCities: counts.cities.partial,
    unmonitoredCities: counts.cities.no_working_station,
    gapCitiesCount: counts.gapCities.total,
    dataPeriod: data.meta.data_period,
  };
}

export default data;
