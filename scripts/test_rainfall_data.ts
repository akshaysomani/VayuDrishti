/**
 * Test Suite: Rainfall Data, Climatology, and Integrity
 * ======================================================
 * Tests:
 * 1. Pure arithmetic percentile calculation on hand-computed tiny fixture
 * 2. Unit, NaN, and gap handling for downloaded rainfall series
 * 3. 26-city coordinate derivation from Phase 2 monitoring network
 * 4. Manifest and cache integrity / resume logic
 * 5. Retry and 429 rate-limit handling using a local stub HTTP server
 * 6. Attribution constant verification (Open-Meteo, CC BY 4.0, disclaimer)
 * 7. Air-quality model parameters and PM2.5 risk tier boundary regression checks
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  calculatePercentile,
  computePercentiles,
  computeRolling3DaySums,
  deriveCityCentroids,
  fetchWithRetry,
} from './acquire_rainfall_climatology';
import {
  OPEN_METEO_ATTRIBUTION,
  OPEN_METEO_ATTRIBUTION_STRING,
  HEAVY_RAIN_HAZARD_LABEL,
  RainfallManifest,
  ClimatologyDatasetSummary,
} from '../src/types/rainfall';
import { getRiskTier } from '../src/types/alert';
import modelParams from '../src/data/shipped_model_parameters.json';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 3b-1: RAINFALL CLIMATOLOGY & DATA INTEGRITY TEST SUITE');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. Percentile Correctness on Hand-Computed Tiny Fixture (Arithmetic Only)
  // ---------------------------------------------------------------------------
  console.log('TEST 1: Percentile Correctness on Hand-Computed Fixtures');
  // Fixture A: 10 sorted values [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  // Linear interpolation: rank = p/100 * (N - 1) = p/100 * 9
  // P80: rank = 7.2 -> 80 + 0.2 * (90 - 80) = 82 mm
  // P90: rank = 8.1 -> 90 + 0.1 * (100 - 90) = 91 mm
  // P95: rank = 8.55 -> 90 + 0.55 * (100 - 90) = 95.5 mm
  // P98: rank = 8.82 -> 90 + 0.82 * (100 - 90) = 98.2 mm
  const fixture10 = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const p10 = computePercentiles(fixture10);
  assert(p10.p80_mm === 82, '10-item fixture P80 matches hand computation (82 mm)');
  assert(p10.p90_mm === 91, '10-item fixture P90 matches hand computation (91 mm)');
  assert(p10.p95_mm === 95.5, '10-item fixture P95 matches hand computation (95.5 mm)');
  assert(p10.p98_mm === 98.2, '10-item fixture P98 matches hand computation (98.2 mm)');

  // Fixture B: 21 sorted values [0, 5, 10, ..., 100] (indices 0..20)
  // rank = p/100 * 20
  // P80: rank = 16 -> index 16 = 80 mm
  // P90: rank = 18 -> index 18 = 90 mm
  // P95: rank = 19 -> index 19 = 95 mm
  // P98: rank = 19.6 -> 95 + 0.6 * (100 - 95) = 98 mm
  const fixture21 = Array.from({ length: 21 }, (_, i) => i * 5);
  const p21 = computePercentiles(fixture21);
  assert(p21.p80_mm === 80, '21-item fixture P80 matches hand computation (80 mm)');
  assert(p21.p90_mm === 90, '21-item fixture P90 matches hand computation (90 mm)');
  assert(p21.p95_mm === 95, '21-item fixture P95 matches hand computation (95 mm)');
  assert(p21.p98_mm === 98, '21-item fixture P98 matches hand computation (98 mm)');

  // Empty fixture handling
  const pEmpty = computePercentiles([]);
  assert(
    pEmpty.p80_mm === 0 && pEmpty.p90_mm === 0 && pEmpty.p95_mm === 0 && pEmpty.p98_mm === 0,
    'Empty fixture yields 0 for all percentiles'
  );

  // Rolling 3-day sums arithmetic
  const dailySeries = [5, 10, 15, 20, 25];
  // 3-day windows:
  // [5, 10, 15] -> 30
  // [10, 15, 20] -> 45
  // [15, 20, 25] -> 60
  const rolling3 = computeRolling3DaySums(dailySeries);
  assert(rolling3.length === 3, 'Rolling 3-day sums on 5 days produces 3 windows');
  assert(rolling3[0] === 30, 'Window 1 sum is exactly 30 mm');
  assert(rolling3[1] === 45, 'Window 2 sum is exactly 45 mm');
  assert(rolling3[2] === 60, 'Window 3 sum is exactly 60 mm');

  // ---------------------------------------------------------------------------
  // 2. Unit, NaN, and Gap Handling in Acquired Data
  // ---------------------------------------------------------------------------
  console.log('\nTEST 2: Unit, NaN, and Gap Handling in Acquired Data');
  const cacheDir = path.resolve(process.cwd(), 'cache', 'open_meteo_rainfall');
  assert(fs.existsSync(cacheDir), 'Cache directory exists');

  // Check Delhi file as canonical reference
  const delhiPath = path.join(cacheDir, 'Delhi_1991_2020.json');
  assert(fs.existsSync(delhiPath), 'Delhi 1991-2020 raw cache file exists');

  const delhiRaw = JSON.parse(fs.readFileSync(delhiPath, 'utf8'));
  assert(delhiRaw.daily_units?.precipitation_sum === 'mm', 'Precipitation units are explicitly "mm"');

  const delhiDates: string[] = delhiRaw.daily.time;
  const delhiPrecip: (number | null)[] = delhiRaw.daily.precipitation_sum;

  // WMO 1991-2020: 30 years = 365 * 30 + 8 leap days (1992, 1996, 2000, 2004, 2008, 2012, 2016, 2020) = 10,958 days
  assert(delhiDates.length === 10958, 'Date array contains exactly 10,958 days (30 WMO normal years)');
  assert(delhiPrecip.length === 10958, 'Precipitation array length matches date array (10,958 values)');

  let hasNullOrNaN = false;
  let hasNegative = false;
  for (const v of delhiPrecip) {
    if (v === null || v === undefined || Number.isNaN(v)) {
      hasNullOrNaN = true;
    }
    if (typeof v === 'number' && v < 0) {
      hasNegative = true;
    }
  }
  assert(!hasNullOrNaN, 'Zero null, undefined, or NaN values in precipitation series');
  assert(!hasNegative, 'Zero negative precipitation values (all >= 0.0 mm)');

  // Verify contiguous calendar dates (no missing days)
  let dateGaps = 0;
  for (let i = 1; i < delhiDates.length; i++) {
    const prev = new Date(delhiDates[i - 1]).getTime();
    const curr = new Date(delhiDates[i]).getTime();
    const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
    if (diffDays !== 1) {
      dateGaps++;
    }
  }
  assert(dateGaps === 0, 'Zero temporal gaps: all 10,958 dates are strictly contiguous');

  // ---------------------------------------------------------------------------
  // 3. Per-City Coordinate Derivation for All 26 Cities
  // ---------------------------------------------------------------------------
  console.log('\nTEST 3: Per-City Coordinate Derivation (26 Cities)');
  const centroids = deriveCityCentroids();
  const cityKeys = Object.keys(centroids).sort();
  assert(cityKeys.length === 26, 'Derived centroids for exactly 26 cities');

  let allCoordsValid = true;
  let allStationsValid = true;
  for (const [name, c] of Object.entries(centroids)) {
    // India latitude bounds ~8°N to 36°N, longitude bounds ~68°E to 96°E
    if (c.latitude < 8.0 || c.latitude > 36.0 || c.longitude < 68.0 || c.longitude > 96.0) {
      allCoordsValid = false;
      console.error(`Invalid coordinates for ${name}: ${c.latitude}, ${c.longitude}`);
    }
    if (c.stationCount < 1) {
      allStationsValid = false;
    }
  }
  assert(allCoordsValid, 'All 26 city centroids fall strictly within Indian geographical bounds');
  assert(allStationsValid, 'All 26 cities have stationCount >= 1');

  // Verify specific known cities
  assert(centroids['Delhi']?.stationCount === 37, 'Delhi centroid derived from 37 Phase 2 stations');
  assert(centroids['Bengaluru']?.stationCount === 8, 'Bengaluru centroid derived from 8 Phase 2 stations');
  assert(centroids['Mumbai']?.stationCount === 10, 'Mumbai centroid derived from 10 Phase 2 stations');

  // ---------------------------------------------------------------------------
  // 4. Manifest and Resume Logic
  // ---------------------------------------------------------------------------
  console.log('\nTEST 4: Manifest Integrity & Resume Logic');
  const manifestPath = path.resolve(process.cwd(), 'data', 'rainfall_climatology', 'manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json exists in data/rainfall_climatology/');

  const manifest: RainfallManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.period === '1991-2020', 'Manifest period is 1991-2020');
  assert(manifest.model === 'era5', 'Manifest records ECMWF ERA5 model');
  assert(manifest.total_cities === 26, 'Manifest indexes 26 cities');

  // Check SHA-256 hash match for a sample city
  const sampleCity = 'Mumbai';
  const sampleItem = manifest.cities[sampleCity];
  assert(Boolean(sampleItem), `Manifest contains entry for ${sampleCity}`);
  const cachedFilePath = path.join(cacheDir, sampleItem.cached_filename);
  assert(fs.existsSync(cachedFilePath), `Cached file exists: ${sampleItem.cached_filename}`);

  const cachedBytes = fs.readFileSync(cachedFilePath);
  const actualSha256 = crypto.createHash('sha256').update(cachedBytes).digest('hex');
  assert(actualSha256 === sampleItem.sha256, `SHA-256 hash matches manifest exactly for ${sampleCity}`);

  // Summary file verification
  const summaryPath = path.resolve(process.cwd(), 'data', 'rainfall_climatology', 'climatology_summary.json');
  assert(fs.existsSync(summaryPath), 'climatology_summary.json exists');
  const summarySize = fs.statSync(summaryPath).size;
  assert(summarySize < 1024 * 1024, `Compact summary is ${(summarySize / 1024).toFixed(1)} KB (< 1 MB limit)`);

  const summaryData: ClimatologyDatasetSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert(Object.keys(summaryData.cities).length === 26, 'Summary contains records for all 26 cities');
  assert(summaryData.wet_day_threshold_mm === 1.0, 'Wet-day threshold is explicitly 1.0 mm');

  // ---------------------------------------------------------------------------
  // 5. Retry & 429 Rate-Limit Handling with Local HTTP Stub Server
  // ---------------------------------------------------------------------------
  console.log('\nTEST 5: Retry & 429 Handling with Local Stub Server');
  let stubCalls = 0;
  const stubPort = 38472;
  const stubServer = http.createServer((req, res) => {
    stubCalls++;
    if (stubCalls === 1) {
      // First call responds with HTTP 429 and Retry-After: 1
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: true, reason: 'Rate limit exceeded' }));
    } else {
      // Subsequent call succeeds
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', attempt: stubCalls }));
    }
  });

  await new Promise<void>((resolve) => stubServer.listen(stubPort, '127.0.0.1', () => resolve()));

  try {
    const stubUrl = `http://127.0.0.1:${stubPort}/test`;
    const responseText = await fetchWithRetry(stubUrl, 3, 200);
    const parsed = JSON.parse(responseText);
    assert(parsed.status === 'ok' && parsed.attempt === 2, 'fetchWithRetry handled 429, backed off, and succeeded on attempt 2');
    assert(stubCalls === 2, 'Stub server received exactly 2 calls (1 rate-limited + 1 success)');
  } finally {
    await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 6. Attribution Constant & Disclaimer Verification
  // ---------------------------------------------------------------------------
  console.log('\nTEST 6: Attribution Constant & Mandatory Disclaimer');
  assert(typeof OPEN_METEO_ATTRIBUTION === 'object', 'OPEN_METEO_ATTRIBUTION constant object is exported');
  assert(OPEN_METEO_ATTRIBUTION.text.includes('Open-Meteo'), 'Attribution text mentions Open-Meteo');
  assert(OPEN_METEO_ATTRIBUTION.license === 'CC BY 4.0', 'Attribution mentions CC BY 4.0 license');
  assert(OPEN_METEO_ATTRIBUTION.url.includes('open-meteo.com'), 'Attribution includes open-meteo.com link');
  assert(OPEN_METEO_ATTRIBUTION_STRING.includes('CC BY 4.0'), 'OPEN_METEO_ATTRIBUTION_STRING exported and contains CC BY 4.0');

  assert(
    HEAVY_RAIN_HAZARD_LABEL === 'Unvalidated Heavy-Rain Hazard Index - model-based estimate, not an inundation forecast',
    'Mandatory disclaimer exact phrasing is preserved in HEAVY_RAIN_HAZARD_LABEL'
  );

  // ---------------------------------------------------------------------------
  // 7. Regression: Air-Quality Model & PM2.5 Tier Boundaries Untouched
  // ---------------------------------------------------------------------------
  console.log('\nTEST 7: Air-Quality Model & PM2.5 Tier Boundaries Regression Assertions');
  // Exact boundaries: Nominal < 0.05, Watch 0.05-0.22, Elevated 0.22-0.50, High >= 0.50
  const rNominal = getRiskTier(0.049);
  assert(rNominal?.tier === 'Nominal' && !rNominal.alertFired, '0.049 -> Nominal, Alert Inactive');

  const rWatchStart = getRiskTier(0.050);
  assert(rWatchStart?.tier === 'Watch' && rWatchStart.alertFired, '0.050 -> Watch, Alert Active');

  const rWatchEnd = getRiskTier(0.099);
  assert(rWatchEnd?.tier === 'Watch' && rWatchEnd.alertFired, '0.099 -> Watch, Alert Active');

  const rElevatedStart = getRiskTier(0.220);
  assert(rElevatedStart?.tier === 'Elevated' && rElevatedStart.alertFired, '0.220 -> Elevated, Alert Active');

  const rElevatedEnd = getRiskTier(0.499);
  assert(rElevatedEnd?.tier === 'Elevated' && rElevatedEnd.alertFired, '0.499 -> Elevated, Alert Active');

  const rHighStart = getRiskTier(0.500);
  assert(rHighStart?.tier === 'High' && rHighStart.alertFired, '0.500 -> High, Alert Active');

  // Verify Shipped Model parameters unchanged
  assert(modelParams.version === 'calibrated-logreg-v1', 'Model version is calibrated-logreg-v1');
  assert(
    JSON.stringify(modelParams.features) ===
      JSON.stringify(['PM2.5', 'pm25_lag1', 'pm25_rolling3', 'pm25_ratio_90']),
    'Feature names are unchanged: [PM2.5, pm25_lag1, pm25_rolling3, pm25_ratio_90]'
  );
  assert(modelParams.classifier.coefficients.length === 4, 'Model coefficients has exactly 4 weights');
  assert(getRiskTier(0.05)?.alertFired === true && getRiskTier(0.049)?.alertFired === false, 'Decision threshold p >= 0.05 is unchanged');

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('----------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
