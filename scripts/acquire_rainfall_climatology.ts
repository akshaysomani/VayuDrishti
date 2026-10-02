/**
 * Open-Meteo 1991-2020 Rainfall Acquisition & Climatology Generator
 * ================================================================
 * Derives 26 city centroids from Phase 2 monitoring networks,
 * acquires daily precipitation_sum (ERA5) for WMO normal period 1991-2020,
 * saves raw files to git-ignored cache with SHA-256 manifest,
 * and compiles a compact, git-tracked climatology summary (<100 KB).
 *
 * Rules:
 * - Polite use: concurrency <= 2, 400ms delay, exponential backoff, honors 429
 * - Resumable: skips already downloaded valid files
 * - Pure arithmetic for percentiles
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  OPEN_METEO_ATTRIBUTION,
  CityCentroid,
  CityClimatologySummary,
  ClimatologyDatasetSummary,
  PrecipitationPercentiles,
  RainfallManifest,
  RainfallManifestItem,
} from '../src/types/rainfall';

const WMO_START_DATE = '1991-01-01';
const WMO_END_DATE = '2020-12-31';
const MODEL = 'era5';
const WET_DAY_THRESHOLD = 1.0; // mm

const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'open_meteo_rainfall');
const DATA_DIR = path.resolve(process.cwd(), 'data', 'rainfall_climatology');

/**
 * Derives the 26 city centroids from Phase 2 monitor records.
 */
export function deriveCityCentroids(): Record<string, CityCentroid> {
  const alertDataPath = path.resolve(process.cwd(), 'src', 'data', 'alert_data.json');
  if (!fs.existsSync(alertDataPath)) {
    throw new Error(`alert_data.json not found at ${alertDataPath}`);
  }

  const raw = fs.readFileSync(alertDataPath, 'utf8');
  const alertData = JSON.parse(raw);
  const stations: Record<string, any> = alertData.stations || {};

  const cityCoords: Record<string, Array<{ lat: number; lon: number }>> = {};
  for (const s of Object.values(stations)) {
    if (!cityCoords[s.city]) {
      cityCoords[s.city] = [];
    }
    cityCoords[s.city].push({ lat: s.lat, lon: s.lon });
  }

  const centroids: Record<string, CityCentroid> = {};
  for (const [city, coords] of Object.entries(cityCoords).sort()) {
    const sumLat = coords.reduce((acc, c) => acc + c.lat, 0);
    const sumLon = coords.reduce((acc, c) => acc + c.lon, 0);
    centroids[city] = {
      city,
      latitude: Number((sumLat / coords.length).toFixed(4)),
      longitude: Number((sumLon / coords.length).toFixed(4)),
      stationCount: coords.length,
    };
  }

  return centroids;
}

/**
 * Calculates empirical percentile using linear interpolation between closest ranks.
 */
export function calculatePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  if (p <= 0) return sortedValues[0];
  if (p >= 100) return sortedValues[sortedValues.length - 1];

  // Rank index: 0-indexed float position
  const rank = (p / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const fraction = rank - lowerIndex;

  if (lowerIndex === upperIndex) {
    return Number(sortedValues[lowerIndex].toFixed(2));
  }

  const val = sortedValues[lowerIndex] + fraction * (sortedValues[upperIndex] - sortedValues[lowerIndex]);
  return Number(val.toFixed(2));
}

export function computePercentiles(values: number[]): PrecipitationPercentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p80_mm: calculatePercentile(sorted, 80),
    p90_mm: calculatePercentile(sorted, 90),
    p95_mm: calculatePercentile(sorted, 95),
    p98_mm: calculatePercentile(sorted, 98),
  };
}

/**
 * Computes 3-day backward rolling sums.
 */
export function computeRolling3DaySums(dailyPrecip: number[]): number[] {
  const rolling: number[] = [];
  for (let i = 2; i < dailyPrecip.length; i++) {
    const sum = dailyPrecip[i] + dailyPrecip[i - 1] + dailyPrecip[i - 2];
    rolling.push(Number(sum.toFixed(2)));
  }
  return rolling;
}

/**
 * Polite fetch with exponential backoff and 429 Retry-After handling.
 */
export async function fetchWithRetry(url: string, retries = 6, delayMs = 1500): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitSec = retryAfter ? Math.max(parseInt(retryAfter, 10), 1) : Math.max(10, Math.pow(2, attempt + 1));
        console.warn(`[Open-Meteo 429 Rate Limit] Waiting ${waitSec}s before retry (attempt ${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      const backoff = delayMs * Math.pow(2, attempt - 1);
      console.warn(`[Network Error] Attempt ${attempt} failed: ${String(err)}. Retrying in ${backoff}ms...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

/**
 * Computes climatological summary for a single city from daily timeseries.
 */
export function analyzeCityClimatology(
  centroid: CityCentroid,
  dates: string[],
  precip: number[]
): CityClimatologySummary {
  const totalDays = dates.length;
  let allWetDays: number[] = [];
  let monsoonWetDays: number[] = [];

  let totalRain = 0;
  let monsoonRain = 0;

  // Annual max daily tracking
  const annualMaxDaily: Record<string, number> = {};
  const monsoonAnnualMaxDaily: Record<string, number> = {};

  let allTimeMax = -1;
  let allTimeMaxDate = '';
  let monsoonMax = -1;
  let monsoonMaxDate = '';

  for (let i = 0; i < totalDays; i++) {
    const date = dates[i];
    const val = precip[i] ?? 0;
    const year = date.slice(0, 4);
    const month = parseInt(date.slice(5, 7), 10);
    const isMonsoon = month >= 6 && month <= 9; // JJAS

    totalRain += val;
    if (val >= WET_DAY_THRESHOLD) {
      allWetDays.push(val);
    }

    if (val > (annualMaxDaily[year] ?? -1)) {
      annualMaxDaily[year] = val;
    }
    if (val > allTimeMax) {
      allTimeMax = val;
      allTimeMaxDate = date;
    }

    if (isMonsoon) {
      monsoonRain += val;
      if (val >= WET_DAY_THRESHOLD) {
        monsoonWetDays.push(val);
      }
      if (val > (monsoonAnnualMaxDaily[year] ?? -1)) {
        monsoonAnnualMaxDaily[year] = val;
      }
      if (val > monsoonMax) {
        monsoonMax = val;
        monsoonMaxDate = date;
      }
    }
  }

  // Rolling 3-day sums
  const rollingAll = computeRolling3DaySums(precip);
  const wetRollingAll = rollingAll.filter((r) => r >= WET_DAY_THRESHOLD);

  // Filter rolling 3-day sums for monsoon (middle day falls in JJAS)
  const rollingMonsoon: number[] = [];
  for (let i = 2; i < totalDays; i++) {
    const m = parseInt(dates[i].slice(5, 7), 10);
    if (m >= 6 && m <= 9) {
      const sum = precip[i] + precip[i - 1] + precip[i - 2];
      if (sum >= WET_DAY_THRESHOLD) {
        rollingMonsoon.push(Number(sum.toFixed(2)));
      }
    }
  }

  // Mean annual maxima
  const annualMaxValues = Object.values(annualMaxDaily);
  const meanAnnualMax =
    annualMaxValues.length > 0
      ? annualMaxValues.reduce((a, b) => a + b, 0) / annualMaxValues.length
      : 0;

  const monsoonMaxValues = Object.values(monsoonAnnualMaxDaily);
  const meanMonsoonAnnualMax =
    monsoonMaxValues.length > 0
      ? monsoonMaxValues.reduce((a, b) => a + b, 0) / monsoonMaxValues.length
      : 0;

  const yearsCount = Math.max(1, Object.keys(annualMaxDaily).length);
  const meanAnnualPrecip = totalRain / yearsCount;
  const monsoonSharePct = totalRain > 0 ? (monsoonRain / totalRain) * 100 : 0;

  return {
    city: centroid.city,
    latitude: centroid.latitude,
    longitude: centroid.longitude,
    stationCount: centroid.stationCount,
    period: `${WMO_START_DATE.slice(0, 4)}-${WMO_END_DATE.slice(0, 4)}`,
    total_days: totalDays,
    wet_day_threshold_mm: WET_DAY_THRESHOLD,
    all_year: {
      wet_day_count: allWetDays.length,
      wet_day_percentage: Number(((allWetDays.length / totalDays) * 100).toFixed(2)),
      mean_annual_precipitation_mm: Number(meanAnnualPrecip.toFixed(1)),
      daily_percentiles: computePercentiles(allWetDays),
      rolling_3day_percentiles: computePercentiles(wetRollingAll),
      mean_annual_max_daily_mm: Number(meanAnnualMax.toFixed(1)),
      all_time_max_daily_mm: Number(allTimeMax.toFixed(1)),
      all_time_max_daily_date: allTimeMaxDate,
    },
    monsoon: {
      wet_day_count: monsoonWetDays.length,
      wet_day_percentage: Number(
        ((monsoonWetDays.length / (yearsCount * 122)) * 100).toFixed(2)
      ), // 122 days in JJAS
      monsoon_precipitation_share_pct: Number(monsoonSharePct.toFixed(1)),
      daily_percentiles: computePercentiles(monsoonWetDays),
      rolling_3day_percentiles: computePercentiles(rollingMonsoon),
      mean_annual_max_daily_mm: Number(meanMonsoonAnnualMax.toFixed(1)),
      max_daily_mm: Number(monsoonMax.toFixed(1)),
      max_daily_date: monsoonMaxDate,
    },
  };
}

async function main() {
  console.log('================================================================');
  console.log('VAYU DRISHTI: OPEN-METEO 1991-2020 RAINFALL ACQUISITION & CLIMATOLOGY');
  console.log('================================================================\n');

  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const centroids = deriveCityCentroids();
  const cityNames = Object.keys(centroids).sort();
  console.log(`Derived centroids for ${cityNames.length} Phase 2 cities.\n`);

  let totalCalls = 0;
  let totalDownloadedBytes = 0;
  const manifestItems: Record<string, RainfallManifestItem> = {};
  const citySummaries: Record<string, CityClimatologySummary> = {};
  const fullPercentileArrays: Record<string, any> = {};

  for (let i = 0; i < cityNames.length; i++) {
    const cityName = cityNames[i];
    const centroid = centroids[cityName];
    const safeCity = cityName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cacheFile = path.join(CACHE_DIR, `${safeCity}_1991_2020.json`);

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${centroid.latitude}&longitude=${centroid.longitude}&start_date=${WMO_START_DATE}&end_date=${WMO_END_DATE}&daily=precipitation_sum&timezone=UTC&models=${MODEL}`;

    let jsonContent: string;
    let fromCache = false;

    // Resumable check
    if (fs.existsSync(cacheFile)) {
      try {
        const existing = fs.readFileSync(cacheFile, 'utf8');
        const parsed = JSON.parse(existing);
        const days = parsed.daily?.precipitation_sum?.length ?? 0;
        if (days >= 10957) {
          jsonContent = existing;
          fromCache = true;
        } else {
          throw new Error('Incomplete cache file');
        }
      } catch {
        fromCache = false;
      }
    }

    if (fromCache) {
      console.log(`[${i + 1}/${cityNames.length}] ${cityName.padEnd(20)}: Cached (${cacheFile})`);
    } else {
      console.log(`[${i + 1}/${cityNames.length}] ${cityName.padEnd(20)}: Downloading from Open-Meteo...`);
      // Pacing delay (2000ms)
      await new Promise((r) => setTimeout(r, 2000));
      jsonContent = await fetchWithRetry(url);
      fs.writeFileSync(cacheFile, jsonContent, 'utf8');
      totalCalls++;
      totalDownloadedBytes += Buffer.byteLength(jsonContent, 'utf8');
    }

    // Hash for manifest
    const sha256 = crypto.createHash('sha256').update(jsonContent).digest('hex');
    const parsedData = JSON.parse(jsonContent);
    const dates: string[] = parsedData.daily.time;
    const precip: number[] = parsedData.daily.precipitation_sum;

    manifestItems[cityName] = {
      city: cityName,
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      url_template: url,
      start_date: WMO_START_DATE,
      end_date: WMO_END_DATE,
      model: MODEL,
      total_days: dates.length,
      sha256,
      cached_filename: path.basename(cacheFile),
      acquired_at: new Date().toISOString(),
    };

    // Analyze climatology
    const summary = analyzeCityClimatology(centroid, dates, precip);
    citySummaries[cityName] = summary;

    fullPercentileArrays[cityName] = {
      all_wet_days_sorted: precip.filter((p) => p >= WET_DAY_THRESHOLD).sort((a, b) => a - b),
      rolling_3day_sorted: computeRolling3DaySums(precip).filter((r) => r >= WET_DAY_THRESHOLD).sort((a, b) => a - b),
    };
  }

  // Write Manifest
  const manifest: RainfallManifest = {
    period: `${WMO_START_DATE.slice(0, 4)}-${WMO_END_DATE.slice(0, 4)}`,
    model: MODEL,
    source: 'Open-Meteo Historical Weather API',
    attribution: OPEN_METEO_ATTRIBUTION,
    total_cities: cityNames.length,
    total_calls_made: totalCalls,
    created_at: new Date().toISOString(),
    cities: manifestItems,
  };
  const manifestPath = path.join(DATA_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✓ Manifest written to: ${manifestPath}`);

  // Write Compact Summary JSON
  const summaryDataset: ClimatologyDatasetSummary = {
    generated_at: new Date().toISOString(),
    wmo_normal_period: `${WMO_START_DATE.slice(0, 4)}-${WMO_END_DATE.slice(0, 4)}`,
    model: `ECMWF ${MODEL.toUpperCase()} via Open-Meteo`,
    attribution: OPEN_METEO_ATTRIBUTION,
    wet_day_threshold_mm: WET_DAY_THRESHOLD,
    cities: citySummaries,
  };
  const summaryPath = path.join(DATA_DIR, 'climatology_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summaryDataset, null, 2), 'utf8');
  const summarySizeBytes = fs.statSync(summaryPath).size;
  console.log(`✓ Compact summary written to: ${summaryPath} (${(summarySizeBytes / 1024).toFixed(1)} KB)`);

  // Write full arrays to git-ignored cache
  const fullArraysPath = path.join(CACHE_DIR, 'climatology_full_arrays.json');
  fs.writeFileSync(fullArraysPath, JSON.stringify(fullPercentileArrays), 'utf8');
  console.log(`✓ Full percentile arrays written to cache: ${fullArraysPath}`);

  // Print Summary Table
  console.log('\n========================================================================================');
  console.log('WMO STANDARD NORMAL (1991-2020) CLIMATOLOGY SUMMARY TABLE (26 CITIES)');
  console.log('========================================================================================');
  console.log(
    'City'.padEnd(20) +
    'WetDays'.padStart(9) +
    'WetDay%'.padStart(9) +
    'P80(mm)'.padStart(10) +
    'P90(mm)'.padStart(10) +
    'P95(mm)'.padStart(10) +
    'P98(mm)'.padStart(10) +
    'AnnMax(mm)'.padStart(12) +
    'AllTimeMax'.padStart(12)
  );
  console.log('-'.repeat(102));

  for (const cityName of cityNames) {
    const s = citySummaries[cityName];
    console.log(
      cityName.padEnd(20) +
      String(s.all_year.wet_day_count).padStart(9) +
      `${s.all_year.wet_day_percentage}%`.padStart(9) +
      String(s.all_year.daily_percentiles.p80_mm).padStart(10) +
      String(s.all_year.daily_percentiles.p90_mm).padStart(10) +
      String(s.all_year.daily_percentiles.p95_mm).padStart(10) +
      String(s.all_year.daily_percentiles.p98_mm).padStart(10) +
      String(s.all_year.mean_annual_max_daily_mm).padStart(12) +
      String(s.all_year.all_time_max_daily_mm).padStart(12)
    );
  }

  console.log('\nTotal network calls made: ' + totalCalls);
  console.log('Total downloaded bytes: ' + totalDownloadedBytes + ' (' + (totalDownloadedBytes / 1024 / 1024).toFixed(2) + ' MB)');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('acquire_rainfall_climatology.ts')) {
  main().catch((err) => {
    console.error('Acquisition error:', err);
    process.exit(1);
  });
}
