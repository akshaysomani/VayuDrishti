import { runShippedModelInference } from '../src/services/shippedModelInference';
import { getRiskTier } from '../src/types/alert';
import { createDemoFixture } from '../src/services/liveDemoFixtures';
import {
  calculatePhase1Pm25Ratio90,
  computeLivePhase1Features,
  PersistentStationHistoryStore,
  type RawStationObservation,
} from '../src/services/historicalObservationStore';
import { WaqiIngestionScheduler } from '../src/server/ingestionScheduler';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

console.log('================================================================');
console.log('PHASE 5 (f1 + f2) CONTINUOUS INGESTION & FEATURE BUFFER SUITE');
console.log('================================================================\n');

// -----------------------------------------------------------------------------
// 1. Exact Tier Boundaries Test (Phase 2f Canonical Scheme)
// -----------------------------------------------------------------------------
console.log('TEST 1: Exact Tier Boundaries (Phase 2f Canonical Scheme)');
const b1 = getRiskTier(0.049);
assert(b1 !== null && b1.tier === 'Nominal' && !b1.alertFired, '0.049 -> Nominal, Alert Inactive');

const b2 = getRiskTier(0.050);
assert(b2 !== null && b2.tier === 'Watch' && b2.alertFired, '0.050 -> Watch, Alert Active');

const b3 = getRiskTier(0.099);
assert(b3 !== null && b3.tier === 'Watch' && b3.alertFired, '0.099 -> Watch, Alert Active');

const b4 = getRiskTier(0.220);
assert(b4 !== null && b4.tier === 'Elevated' && b4.alertFired, '0.220 -> Elevated, Alert Active');

const b5 = getRiskTier(0.499);
assert(b5 !== null && b5.tier === 'Elevated' && b5.alertFired, '0.499 -> Elevated, Alert Active');

const b6 = getRiskTier(0.500);
assert(b6 !== null && b6.tier === 'High' && b6.alertFired, '0.500 -> High, Alert Active');

// -----------------------------------------------------------------------------
// 2. Alert Boolean Behavior Test
// -----------------------------------------------------------------------------
console.log('\nTEST 2: Alert Boolean Verification (Threshold p >= 0.050)');
assert(getRiskTier(0.01)?.alertFired === false, 'p = 0.01: alertFired === false');
assert(getRiskTier(0.05)?.alertFired === true, 'p = 0.05: alertFired === true');
assert(getRiskTier(0.25)?.alertFired === true, 'p = 0.25: alertFired === true');
assert(getRiskTier(0.75)?.alertFired === true, 'p = 0.75: alertFired === true');

// -----------------------------------------------------------------------------
// 3. Exact Phase 1 Definition of pm25_ratio_90 (PM2.5 / 90.0)
// -----------------------------------------------------------------------------
console.log('\nTEST 3: Exact Phase 1 Definition of pm25_ratio_90 (PM2.5 / 90.0)');
const pmVal = 81.0;
const expectedRatio = pmVal / 90.0; // 0.90
assert(calculatePhase1Pm25Ratio90(pmVal) === expectedRatio, 'pm25_ratio_90 is strictly PM2.5 / 90.0');
assert(calculatePhase1Pm25Ratio90(90.0) === 1.0, 'pm25 = 90.0 yields exact ratio 1.0');
assert(calculatePhase1Pm25Ratio90(45.0) === 0.5, 'pm25 = 45.0 yields exact ratio 0.5');
assert(calculatePhase1Pm25Ratio90(pmVal) !== pmVal / 150.0, 'Rejects erroneous 150.0 denominator');

// -----------------------------------------------------------------------------
// 4. Rejection of Unavailable / Invalid Ratio Baseline
// -----------------------------------------------------------------------------
console.log('\nTEST 4: Rejection of Unavailable Ratio Baseline');
assert(Number.isNaN(calculatePhase1Pm25Ratio90(NaN)), 'NaN PM2.5 produces NaN ratio');
assert(Number.isNaN(calculatePhase1Pm25Ratio90(-5)), 'Negative PM2.5 rejected as NaN ratio');
const infNoRatio = runShippedModelInference(
  { pm25: NaN, pm25_lag1: 50, pm25_rolling3: 50 },
  new Date().toISOString()
);
assert(infNoRatio.isComplete === false, 'Missing ratio baseline flags isComplete === false');
assert(infNoRatio.missingFeatures.includes('pm25_ratio_90'), 'Identifies pm25_ratio_90 as missing when PM2.5 is invalid');

// -----------------------------------------------------------------------------
// 5. Canonical Phase 1 Feature Computation from 72h History Buffer
// -----------------------------------------------------------------------------
console.log('\nTEST 5: Canonical Phase 1 Feature Computation (72h buffer math)');
const now = new Date();
const oneDayMs = 24 * 60 * 60 * 1000;
const t0Iso = now.toISOString();
const t1Date = new Date(now.getTime() - oneDayMs);
const t2Date = new Date(now.getTime() - 2 * oneDayMs);
const t1Str = t1Date.toISOString().split('T')[0];
const t2Str = t2Date.toISOString().split('T')[0];

const currentReading: RawStationObservation = {
  station_id: 'DL001',
  station_name: 'Alipur',
  city: 'Delhi',
  lat: 28.815,
  lon: 77.152,
  observed_at: t0Iso,
  ingested_at: t0Iso,
  pm25: 75.0,
  source: 'WAQI',
  coord_quality: 'station',
};

const fullHistory: RawStationObservation[] = [
  { ...currentReading, observed_at: `${t2Str}T06:00:00.000Z`, pm25: 80.0 },
  { ...currentReading, observed_at: `${t2Str}T18:00:00.000Z`, pm25: 84.0 }, // t-2 avg = 82.0
  { ...currentReading, observed_at: `${t1Str}T08:00:00.000Z`, pm25: 70.0 },
  { ...currentReading, observed_at: `${t1Str}T20:00:00.000Z`, pm25: 74.0 }, // t-1 avg = 72.0
];

const featureRes = computeLivePhase1Features('DL001', currentReading, fullHistory);
assert(featureRes.success === true, 'Complete 72h history produces success');
assert(featureRes.features?.pm25 === 75.0, 'Feature 0: PM2.5 === 75.0');
assert(featureRes.features?.pm25_lag1 === 72.0, 'Feature 1: pm25_lag1 === 72.0 (yesterday average)');
assert(
  Math.abs((featureRes.features?.pm25_rolling3 ?? 0) - (82.0 + 72.0 + 75.0) / 3.0) < 1e-9,
  'Feature 2: pm25_rolling3 correctly computes 3-day backward rolling mean'
);
assert(featureRes.features?.pm25_ratio_90 === 75.0 / 90.0, 'Feature 3: pm25_ratio_90 === PM2.5 / 90.0');

// -----------------------------------------------------------------------------
// 6. Insufficient History & Gap Detection
// -----------------------------------------------------------------------------
console.log('\nTEST 6: Gap Detection & Missing History Safety');
// Gap: t-1 missing
const historyMissingLag1 = fullHistory.filter((o) => !o.observed_at.startsWith(t1Str));
const resMissingLag1 = computeLivePhase1Features('DL001', currentReading, historyMissingLag1);
assert(resMissingLag1.success === false, 'Missing t-1 returns failure');
assert(resMissingLag1.status === 'missing_lag1', 'Status flags missing_lag1');
assert(resMissingLag1.missingFeatures.includes('pm25_lag1'), 'missingFeatures lists pm25_lag1');

// Gap: t-2 missing
const historyMissingRolling3 = fullHistory.filter((o) => !o.observed_at.startsWith(t2Str));
const resMissingRolling3 = computeLivePhase1Features('DL001', currentReading, historyMissingRolling3);
assert(resMissingRolling3.success === false, 'Missing t-2 returns failure');
assert(resMissingRolling3.status === 'missing_rolling3', 'Status flags missing_rolling3');
assert(resMissingRolling3.missingFeatures.includes('pm25_rolling3'), 'missingFeatures lists pm25_rolling3');

// Zero history
const resZeroHistory = computeLivePhase1Features('DL001', currentReading, []);
assert(resZeroHistory.success === false, 'Zero history returns failure');
assert(resZeroHistory.status === 'insufficient_history', 'Status flags insufficient_history');

// Future timestamp rejection
const futureReading: RawStationObservation = {
  ...currentReading,
  observed_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour in future
};
const resFuture = computeLivePhase1Features('DL001', futureReading, fullHistory);
assert(resFuture.success === false, 'Future timestamp strictly rejected');
assert(resFuture.reason.includes('future'), 'Failure reason explains future timestamp rejection');

// -----------------------------------------------------------------------------
// 7. Persistent Station History Store (Idempotency, Deduplication, Pruning)
// -----------------------------------------------------------------------------
console.log('\nTEST 7: Persistent Station History Store Verification');
const store = new PersistentStationHistoryStore();
await store.clearHistory();

// Insertion
const ins1 = await store.addObservation(fullHistory[0]);
assert(ins1.added === true, 'Initial observation inserted');

// Duplicate insertion (same station + same timestamp)
const insDup = await store.addObservation(fullHistory[0]);
assert(insDup.added === false, 'Duplicate observation timestamp safely ignored (idempotent)');

// Out of order insertion
await store.addObservation(fullHistory[3]); // newest
await store.addObservation(fullHistory[1]); // older
const storedDL001 = await store.getStationObservations('DL001', 120);
assert(storedDL001.length === 3, 'Stored 3 distinct observations');
assert(
  storedDL001[0].observed_at <= storedDL001[1].observed_at &&
    storedDL001[1].observed_at <= storedDL001[2].observed_at,
  'Store maintains chronological ascending order despite out-of-order insertions'
);

// Station isolation
const otherStationObs: RawStationObservation = {
  ...currentReading,
  station_id: 'MH001',
  station_name: 'Bandra',
  city: 'Mumbai',
  observed_at: t0Iso,
};
await store.addObservation(otherStationObs);
const storedMH001 = await store.getStationObservations('MH001');
assert(storedMH001.length === 1, 'Station MH001 has only its own observation');
assert((await store.getStationObservations('DL001')).length === 3, 'Station DL001 remains completely isolated from MH001');

// Pruning stale observations
const prunedCount = await store.pruneStaleObservations(1); // prune older than 1 hour
assert(prunedCount >= 2, 'Pruning successfully cleans up records older than retention threshold');

// -----------------------------------------------------------------------------
// 8. End-to-End Live Pipeline: Store -> Features -> Shipped Model Inference
// -----------------------------------------------------------------------------
console.log('\nTEST 8: End-to-End Pipeline: History Store -> Shipped Model Inference');
await store.clearHistory();
for (const h of fullHistory) {
  await store.addObservation(h);
}
const freshHistory = await store.getStationObservations('DL001', 72);
const featuresFromStore = computeLivePhase1Features('DL001', currentReading, freshHistory);
assert(featuresFromStore.success === true, 'Features successfully generated from store');

const liveInference = runShippedModelInference(featuresFromStore.features!, currentReading.observed_at);
assert(liveInference.isComplete === true, 'Shipped model executes on genuine features');
assert(liveInference.inference !== null, 'Model produces genuine inference output');
assert(
  liveInference.inference?.features_used.pm25 === 75.0 &&
    liveInference.inference?.features_used.pm25_lag1 === 72.0 &&
    liveInference.inference?.features_used.pm25_ratio_90 === 75.0 / 90.0,
  'Feature vector matches Phase 1 parameters exactly'
);
assert(typeof liveInference.inference?.probability === 'number', 'Model probability is valid float');
assert(
  liveInference.inference?.probability! >= 0.0 && liveInference.inference?.probability! <= 1.0,
  'Probability is strictly bounded in [0.0, 1.0]'
);
assert(
  ['Nominal', 'Watch', 'Elevated', 'High'].includes(liveInference.inference?.risk_tier.tier!),
  'Risk tier maps to canonical Phase 2f tier'
);

// -----------------------------------------------------------------------------
// 9. WaqiIngestionScheduler Concurrency & Status
// -----------------------------------------------------------------------------
console.log('\nTEST 9: Ingestion Scheduler Service & Concurrency Guard');
const scheduler = new WaqiIngestionScheduler();
const initialStatus = await scheduler.getStatus();
assert(['idle', 'running', 'polling'].includes(initialStatus.service_status), 'Scheduler status is valid enum');
assert(typeof initialStatus.poll_interval_minutes === 'number', 'Poll interval is configured');

// Seeding station history
const testStationId = `DL_TEST_${Date.now()}`;
const seededCount = await scheduler.seedStationHistory(testStationId, [
  { date: t2Str, pm25: 65.0 },
  { date: t1Str, pm25: 70.0 },
]);
assert(seededCount === 2, 'Scheduler seeds 2 days of historical observations for testing');

// -----------------------------------------------------------------------------
// 10. Demo Fixtures Labeling & Fallbacks
// -----------------------------------------------------------------------------
console.log('\nTEST 10: Demo Fixture Labeling & Offline Safety');
for (const tier of ['nominal', 'watch', 'elevated', 'high', 'stale', 'error', 'model_unavailable'] as const) {
  const fix = createDemoFixture(tier, 'DL001');
  assert(fix.is_demo === true, `Demo fixture for ${tier} is explicitly flagged is_demo === true`);
  assert(fix.observation.source === 'DEMO', `Demo fixture for ${tier} source === "DEMO"`);
}

// -----------------------------------------------------------------------------
// 11. Security Audit (Zero Secrets in Bundle & Git Hygiene)
// -----------------------------------------------------------------------------
console.log('\nTEST 11: Security Audit (Secrets & Bundle Hygiene)');
const gitignoreContent = fs.readFileSync(path.resolve('.gitignore'), 'utf8');
assert(gitignoreContent.includes('.env'), '.gitignore excludes .env');
assert(gitignoreContent.includes('.env.*'), '.gitignore excludes .env.*');

const liveToken = process.env.WAQI_API_TOKEN || '';
const envExampleContent = fs.readFileSync(path.resolve('.env.example'), 'utf8');
assert(!liveToken || !envExampleContent.includes(liveToken), '.env.example does NOT contain live token');
assert(envExampleContent.includes('your_waqi_api_token_here'), '.env.example contains placeholder');

// Check dist assets if dist exists
if (fs.existsSync('dist/assets')) {
  const assetFiles = fs.readdirSync('dist/assets').filter((f) => f.endsWith('.js'));
  let bundleHasToken = false;
  if (liveToken) {
    for (const f of assetFiles) {
      const code = fs.readFileSync(path.join('dist/assets', f), 'utf8');
      if (code.includes(liveToken)) {
        bundleHasToken = true;
      }
    }
  }
  assert(!bundleHasToken, 'Production client bundle in dist/assets contains ZERO API tokens');
}

// -----------------------------------------------------------------------------
// 12. Coordinate Quality & Exposure Association
// -----------------------------------------------------------------------------
console.log('\nTEST 12: Coordinate Quality & Exposure Association');
const dlFixture = createDemoFixture('watch', 'DL001');
assert(
  ['station', 'manual', 'suspect', 'city_point'].includes(dlFixture.observation.coord_quality),
  'Coordinate quality is valid enum'
);
assert(dlFixture.exposure !== null, 'Exposure context attached');
assert((dlFixture.exposure?.station_population_5km ?? 0) > 0, 'Station 5km population > 0');
assert((dlFixture.exposure?.city_population_5km_union ?? 0) > 0, 'City 5km union population > 0');

console.log('\n----------------------------------------------------------------');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('----------------------------------------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
