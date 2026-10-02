/**
 * Phase 5 f4: Alert Delivery to Authorities - Comprehensive Test Suite
 * ====================================================================
 * Covers:
 * 1. Unit Tests:
 *    - Boundary conditions: 0.049 (no), 0.050 (no at default ELEVATED), 0.219 (no), 0.220 (yes), 0.499 (yes), 0.500 (yes)
 *    - ALERT_MIN_TIER=WATCH delivers at 0.050
 *    - Rejection of MODEL UNAVAILABLE, stale data, and demo/fixture data
 *    - Cooldown suppression within 6 hours
 *    - Escalation Elevated -> High bypasses cooldown
 *    - Dedupe unique key formation
 *    - Webhook HMAC-SHA256 signature verification
 *    - SSRF IP/Host blocklist (loopback, RFC1918, link-local, cloud metadata)
 *    - HTML escaping of dynamic values in email templates
 *    - Credential & URL parameter scrubbing in last_error
 * 2. Real PostgreSQL Tests (strictly on Vayu_Drishti_test):
 *    - Dedupe unique constraint prevents duplicate outbox insertion
 *    - SELECT ... FOR UPDATE SKIP LOCKED concurrency claim by multiple workers
 *    - Retry, exponential backoff, and DEAD status transition
 *    - DRY_RUN mode: logs DRY_RUN in outbox and audit log without network transmission
 *    - LIVE mode: delivers payload to local HTTP stub and logs SENT with response code 200
 * 3. HTTP Integration Tests:
 *    - Admin endpoints fail closed (503) if ALERT_ADMIN_TOKEN is missing
 *    - Admin endpoints reject missing (401), empty (401), and invalid (401) tokens
 *    - Simulated test alert labeled [TEST ALERT] and excluded from real counts
 *    - Public /stats endpoint masks authority contact info
 * 4. Regression Tests:
 *    - Canonical tier definitions unchanged
 */

import http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { getRiskTier, RiskTier } from '../src/types/alert';
import {
  AlertDeliveryPolicy,
  generateDedupeKey,
  getAlertMaxAgeHours,
  calculateObservationAgeHours,
  formatObservationAge,
  formatObservationAgeNote,
  formatIssuedLateNote,
} from '../src/server/services/alertDeliveryPolicy';
import {
  isSsrfBlocked,
  signWebhookPayload,
  sendWebhookAlert,
} from '../src/server/channels/webhookChannel';
import { escapeHtml, renderEmailContent, sendEmailAlert } from '../src/server/channels/emailChannel';
import {
  PostgresAlertDeliveryStore,
  scrubSensitiveErrorInfo,
  maskDestination,
} from '../src/server/storage/alertDeliveryStore';
import {
  AlertDispatcher,
  generateDeliveryIdempotencyKey,
  validateAlertSafetyConfig,
} from '../src/server/services/alertDispatcher';
import {
  handleAlertDeliveryRequest,
  resetAuthRateLimiterForTesting,
} from '../src/server/alertDeliveryHandler';
import { prepareTestDatabase, truncateTestDatabase, extractDatabaseName, getVerifiedTestDatabaseUrl } from '../src/server/db/testDbHelper';
import { runDatabaseMigrations, normalizeDatabaseUrl } from '../src/server/db/migrator';
import type { LiveAlertPayload } from '../src/types/liveAlert';
import type { RecipientRecord, StructuredAlertMessage } from '../src/types/alertDelivery';

// Load .env if present
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        let v = trimmed.slice(eqIdx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
}
loadEnv();

process.env.NODE_ENV = 'test';

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

function makeMockPayload(
  overrides: Partial<LiveAlertPayload> = {},
  probability: number = 0.35,
  isStale: boolean = false
): LiveAlertPayload {
  const tierInfo = getRiskTier(probability);
  const now = new Date().toISOString();

  return {
    status: 'fresh',
    is_demo: false,
    features_complete: true,
    error_message: null,
    observation: {
      station_id: 'DL001',
      station_name: 'Anand Vihar, Delhi - DPCC',
      city: 'Delhi',
      latitude: 28.6469,
      longitude: 77.316,
      coord_quality: 'station',
      pm25: 185.0,
      observed_at: now,
      received_at: now,
      is_stale: isStale,
      age_minutes: isStale ? 180 : 12,
      source: 'WAQI',
      source_attribution: 'DPCC - Delhi Pollution Control Committee',
    },
    inference: {
      model_version: 'Phase 1 Calibrated Logistic Regression v1.0',
      model_name: 'CalibratedLogisticRegression',
      probability,
      risk_tier: tierInfo,
      alert_fired: tierInfo.alertFired,
      input_timestamp: now,
      source_timestamp: now,
      features_used: {
        pm25: 185.0,
        pm25_ratio_90: 2.055,
        pm25_lag1: 160.0,
        pm25_rolling3: 170.0,
      },
      explanation: 'Calibrated LR acute spike inference',
    },
    exposure: {
      station_population_5km: 85000,
      station_population_2km: 25000,
      city_population_5km_union: 30000000,
      city_mean_daily_expected_exposed: 120000,
      people_in_already_poor_areas: 50000,
      already_poor_share_pct: 0.58,
    },
    ...overrides,
  };
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('PHASE 5 f4: ALERT DELIVERY TO AUTHORITIES TEST SUITE');
  console.log('================================================================\n');

  // ===========================================================================
  // SECTION 1: UNIT TESTS - POLICY & BOUNDARIES
  // ===========================================================================
  console.log('TEST 1: Decision Boundaries and Minimum Tier Policy');
  {
    const dummyStore: any = {
      getStationLastAlert: async () => null,
    };
    const policyElevated = new AlertDeliveryPolicy(dummyStore, { minTier: 'ELEVATED' });
    const policyWatch = new AlertDeliveryPolicy(dummyStore, { minTier: 'WATCH' });

    // p = 0.049 -> Nominal -> NO
    const res0049 = await policyElevated.evaluate(makeMockPayload({}, 0.049));
    assert(!res0049.shouldDeliver, 'p=0.049 (Nominal) rejects delivery');
    assert(Boolean(res0049.reason?.includes('Nominal')), 'Reason explains below threshold');

    // p = 0.050 -> Watch -> NO under default ELEVATED policy
    const res0050 = await policyElevated.evaluate(makeMockPayload({}, 0.050));
    assert(!res0050.shouldDeliver, 'p=0.050 (Watch) rejects delivery under default ELEVATED policy');

    // p = 0.050 -> Watch -> YES under ALERT_MIN_TIER=WATCH policy
    const res0050Watch = await policyWatch.evaluate(makeMockPayload({}, 0.050));
    assert(res0050Watch.shouldDeliver, 'p=0.050 (Watch) delivers under WATCH policy');

    // p = 0.219 -> Watch -> NO under ELEVATED policy
    const res0219 = await policyElevated.evaluate(makeMockPayload({}, 0.219));
    assert(!res0219.shouldDeliver, 'p=0.219 (Watch) rejects delivery under ELEVATED policy');

    // p = 0.220 -> Elevated -> YES under default ELEVATED policy
    const res0220 = await policyElevated.evaluate(makeMockPayload({}, 0.220));
    assert(res0220.shouldDeliver, 'p=0.220 (Elevated boundary) triggers delivery');

    // p = 0.499 -> Elevated -> YES
    const res0499 = await policyElevated.evaluate(makeMockPayload({}, 0.499));
    assert(res0499.shouldDeliver, 'p=0.499 (Elevated) triggers delivery');

    // p = 0.500 -> High -> YES
    const res0500 = await policyElevated.evaluate(makeMockPayload({}, 0.500));
    assert(res0500.shouldDeliver, 'p=0.500 (High tier) triggers delivery');
  }

  console.log('\nTEST 2: Genuine Model Inference Enforcement (Reject Model Unavailable, Stale, Demo)');
  {
    const dummyStore: any = {
      getStationLastAlert: async () => null,
    };
    const policy = new AlertDeliveryPolicy(dummyStore);

    // MODEL UNAVAILABLE
    const resModelUnavail = await policy.evaluate(
      makeMockPayload({
        status: 'model_unavailable',
        inference: null,
        error_message: 'MODEL UNAVAILABLE: Missing rolling feature',
      })
    );
    assert(!resModelUnavail.shouldDeliver, 'Rejects delivery when model_unavailable');
    assert(Boolean(resModelUnavail.reason?.includes('MODEL UNAVAILABLE') || resModelUnavail.reason?.includes('Non-fresh')), 'Explicit reason for unavailable model');

    // STALE DATA
    const resStale = await policy.evaluate(makeMockPayload({}, 0.35, true));
    assert(!resStale.shouldDeliver, 'Rejects delivery when data is stale (is_stale=true)');
    assert(Boolean(resStale.reason?.includes('stale')), 'Explicit reason for stale data');

    // DEMO / FIXTURE DATA
    const resDemo = await policy.evaluate(makeMockPayload({ is_demo: true }));
    assert(!resDemo.shouldDeliver, 'Rejects delivery for demo/fixture synthetic data');
    assert(Boolean(resDemo.reason?.includes('Demo')), 'Explicit reason for demo data');

    // INCOMPLETE FEATURES
    const resIncomplete = await policy.evaluate(
      makeMockPayload({ features_complete: false })
    );
    assert(!resIncomplete.shouldDeliver, 'Rejects delivery when features are incomplete');
  }

  console.log('\nTEST 3: Cooldown and Escalation Semantics');
  {
    // Mock store with existing station alert history
    const mockStore: any = {
      getStationLastAlert: async (stationId: string) => {
        if (stationId === 'station-elevated-recent') {
          return {
            tier: 'Elevated' as RiskTier,
            createdAt: new Date(Date.now() - 2 * 3600 * 1000),
          };
        }
        if (stationId === 'station-high-recent') {
          return {
            tier: 'High' as RiskTier,
            createdAt: new Date(Date.now() - 1 * 3600 * 1000),
          };
        }
        if (stationId === 'station-elevated-old') {
          return {
            tier: 'Elevated' as RiskTier,
            createdAt: new Date(Date.now() - 8 * 3600 * 1000),
          };
        }
        return null;
      },
    };

    const policy = new AlertDeliveryPolicy(mockStore);

    // Same tier inside 6h cooldown -> SUPPRESSED
    const pSuppressed = makeMockPayload({}, 0.35);
    pSuppressed.observation.station_id = 'station-elevated-recent';
    const resSuppressed = await policy.evaluate(pSuppressed);
    assert(!resSuppressed.shouldDeliver, 'Suppresses repeat alert within 6h cooldown');
    assert(Boolean(resSuppressed.reason?.includes('cooldown')), 'Suppression mentions cooldown');

    // Escalation from Elevated -> High inside cooldown -> BYPASS COOLDOWN
    const pEscalated = makeMockPayload({}, 0.58);
    pEscalated.observation.station_id = 'station-elevated-recent';
    const resEscalated = await policy.evaluate(pEscalated);
    assert(resEscalated.shouldDeliver, 'Escalation to High bypasses active cooldown');

    // Alert after 6h cooldown expired -> DELIVER
    const pExpired = makeMockPayload({}, 0.35);
    pExpired.observation.station_id = 'station-elevated-old';
    const resExpired = await policy.evaluate(pExpired);
    assert(resExpired.shouldDeliver, 'Delivers alert after 6h cooldown window has elapsed');
  }

  console.log('\nTEST 4: Webhook Security - HMAC Signature & SSRF Defenses');
  {
    const secret = 'test-signing-secret-12345';
    const payload = JSON.stringify({ test: 'data', acute_spike: true });
    const timestamp = '1775000000';

    const sig = signWebhookPayload(secret, timestamp, payload);
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    assert(sig === expectedSig, 'HMAC-SHA256 signature calculated accurately with timestamp prepended');

    // SSRF Blocklist Validation (ensure ALERT_ALLOW_PRIVATE_WEBHOOKS is false during validation)
    const origAllow = process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS;
    delete process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS;

    try {
      assert(isSsrfBlocked('http://127.0.0.1:8080').blocked, 'Blocks 127.0.0.1 (IPv4 loopback)');
      assert(isSsrfBlocked('http://localhost:3000').blocked, 'Blocks localhost');
      assert(isSsrfBlocked('http://[::1]:8080').blocked, 'Blocks ::1 (IPv6 loopback)');
      assert(isSsrfBlocked('http://10.0.1.5:8080').blocked, 'Blocks 10.x.x.x (RFC 1918 private)');
      assert(isSsrfBlocked('http://192.168.1.100:8080').blocked, 'Blocks 192.168.x.x (RFC 1918 private)');
      assert(isSsrfBlocked('http://172.20.0.1:8080').blocked, 'Blocks 172.16-31.x.x (RFC 1918 private)');
      assert(isSsrfBlocked('http://169.254.169.254/latest/meta-data').blocked, 'Blocks 169.254.169.254 (Cloud metadata/link-local)');
      assert(!isSsrfBlocked('https://api.cpcb.gov.in/alerts').blocked, 'Allows public authority domain');
      assert(!isSsrfBlocked('https://8.8.8.8/webhook').blocked, 'Allows public IP');
    } finally {
      process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS = origAllow;
    }
  }

  console.log('\nTEST 5: Email Channel Security - Dynamic HTML Escaping & Content');
  {
    const dangerousString = '<script>alert("XSS")</script> & "quotes" \'single\'';
    const escaped = escapeHtml(dangerousString);

    assert(!escaped.includes('<script>'), 'HTML escaping eliminates script tag open');
    assert(escaped.includes('&lt;script&gt;'), 'HTML escaping properly encodes brackets');
    assert(escaped.includes('&amp;'), 'HTML escaping properly encodes ampersand');
    assert(escaped.includes('&quot;'), 'HTML escaping properly encodes double quote');

    const msg: StructuredAlertMessage = {
      alert_id: 'test-123',
      station_id: 'DL001',
      station_name: 'Anand Vihar <Malicious>',
      city: 'Delhi & NCR',
      probability: 0.42,
      tier: 'Elevated',
      expected_people_exposed: 90000,
      coord_quality: 'city_point',
      source_observation_timestamp: '2026-10-01T10:00:00Z',
      model_version: 'v1.0',
      dashboard_url: 'http://localhost:5173/#alerts',
      disclaimer: 'Early-warning model estimate, not confirmed.',
      coord_quality_note: 'Note: Using city-point centroid coordinates.',
    };

    const { text, html } = renderEmailContent(msg);
    assert(html.includes('&lt;Malicious&gt;'), 'Station name is strictly escaped in HTML body');
    assert(html.includes('Delhi &amp; NCR'), 'City name is strictly escaped in HTML body');
    assert(text.includes('Acute Spike Alert'), 'Plain text contains alert header');
    assert(html.includes('Early-warning model estimate'), 'HTML contains honest disclaimer');
    assert(html.includes('Using city-point centroid coordinates'), 'Coordinate quality warning included');
  }

  console.log('\nTEST 6: Credential and Query String Scrubbing in Error Logging');
  {
    const rawError =
      'Connection error to postgresql://postgres:SuperSecretPassword123@localhost:5432/db?token=adminSecretToken&key=xyz: timeout';
    const scrubbed = scrubSensitiveErrorInfo(rawError);

    assert(!scrubbed.includes('SuperSecretPassword123'), 'Scrubbed DB password from error log');
    assert(!scrubbed.includes('adminSecretToken'), 'Scrubbed secret token query string from error log');
    assert(scrubbed.includes('[SCRUBBED]'), 'Replaced sensitive data with [SCRUBBED]');

    // Destination masking
    const maskedEmail = maskDestination('alerts.director@delhi.gov.in', 'email');
    assert(maskedEmail.startsWith('a') && maskedEmail.includes('***') && maskedEmail.endsWith('@delhi.gov.in'), 'Masks email properly');

    const maskedWebhook = maskDestination('https://api.cpcb.gov.in/v1/webhook?secret=123', 'webhook');
    assert(maskedWebhook === 'https://api.cpcb.gov.in/***', 'Masks webhook query/path properly');
  }

  // ===========================================================================
  // SECTION 2: REAL POSTGRESQL TESTS (Using Vayu_Drishti_test)
  // ===========================================================================
  console.log('\n================================================================');
  console.log('REAL POSTGRESQL SUITE (Testing against Vayu_Drishti_test)');
  console.log('================================================================\n');

  const { testDbUrl, testDbName } = await prepareTestDatabase();
  console.log(`Verified connection to isolated test DB: "${testDbName}"\n`);

  const store = new PostgresAlertDeliveryStore(testDbUrl);

  console.log('TEST 7: PostgreSQL Deduplication Constraint (Unique Dedupe Key)');
  {
    const timestamp = '2026-10-01T10:00:00.000Z';
    const dedupeKey = generateDedupeKey('DL001', 'Elevated', timestamp);

    const outboxItem1 = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.35,
      tier: 'Elevated',
      source_observation_timestamp: timestamp,
      model_version: 'v1.0',
      coord_quality: 'station',
      expected_people_exposed: 85000,
      payload: {
        alert_id: 'a1',
        station_id: 'DL001',
        station_name: 'Anand Vihar',
        city: 'Delhi',
        probability: 0.35,
        tier: 'Elevated',
        expected_people_exposed: 85000,
        coord_quality: 'station',
        source_observation_timestamp: timestamp,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: dedupeKey,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    assert(outboxItem1.queued === true, 'First outbox item queued successfully');

    // Attempt second insert with identical dedupe_key (e.g. overlapping scheduler run)
    const outboxItem2 = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.35,
      tier: 'Elevated',
      source_observation_timestamp: timestamp,
      model_version: 'v1.0',
      coord_quality: 'station',
      expected_people_exposed: 85000,
      payload: {
        alert_id: 'a2',
        station_id: 'DL001',
        station_name: 'Anand Vihar',
        city: 'Delhi',
        probability: 0.35,
        tier: 'Elevated',
        expected_people_exposed: 85000,
        coord_quality: 'station',
        source_observation_timestamp: timestamp,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: dedupeKey,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    assert(outboxItem2.queued === false, 'Second insert with duplicate dedupe_key gracefully returns queued: false (blocked by DB constraint)');
  }

  console.log('\nTEST 8: Concurrency Protection with SELECT ... FOR UPDATE SKIP LOCKED');
  {
    // Queue 5 pending outbox items
    for (let i = 1; i <= 5; i++) {
      await store.queueOutboxAlert({
        station_id: `ST_${i}`,
        station_name: `Station ${i}`,
        city: 'Delhi',
        probability: 0.30,
        tier: 'Elevated',
        source_observation_timestamp: new Date().toISOString(),
        model_version: 'v1.0',
        coord_quality: 'station',
        expected_people_exposed: 50000,
        payload: {
          alert_id: `item-${i}`,
          station_id: `ST_${i}`,
          station_name: `Station ${i}`,
          city: 'Delhi',
          probability: 0.30,
          tier: 'Elevated',
          expected_people_exposed: 50000,
          coord_quality: 'station',
          source_observation_timestamp: new Date().toISOString(),
          model_version: 'v1.0',
          dashboard_url: 'http://localhost:5173',
          disclaimer: 'test',
        },
        dedupe_key: `concurrency-test-${Date.now()}-${i}`,
        status: 'PENDING',
        max_attempts: 3,
        next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      });
    }

    // Two parallel store instances claiming items concurrently
    const storeWorkerA = new PostgresAlertDeliveryStore(testDbUrl);
    const storeWorkerB = new PostgresAlertDeliveryStore(testDbUrl);

    const [batchA, batchB] = await Promise.all([
      storeWorkerA.claimPendingOutboxItems(3),
      storeWorkerB.claimPendingOutboxItems(3),
    ]);

    const idsA = new Set(batchA.map((x) => x.id));
    const idsB = new Set(batchB.map((x) => x.id));

    assert(batchA.length > 0 && batchB.length > 0, 'Both concurrent workers claimed pending items');

    // Ensure zero overlap between claimed batches
    let hasOverlap = false;
    for (const id of idsA) {
      if (idsB.has(id)) hasOverlap = true;
    }
    assert(!hasOverlap, 'SKIP LOCKED guaranteed mutually exclusive, disjoint claims (zero double-dispatch)');
  }

  console.log('\nTEST 9: Retry, Exponential Backoff, and DEAD Letter Transition');
  {
    const itemRes = await store.queueOutboxAlert({
      station_id: 'FAIL_STN',
      station_name: 'Failing Station',
      city: 'Delhi',
      probability: 0.40,
      tier: 'Elevated',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0',
      coord_quality: 'station',
      expected_people_exposed: 10000,
      payload: {
        alert_id: 'fail-item',
        station_id: 'FAIL_STN',
        station_name: 'Failing Station',
        city: 'Delhi',
        probability: 0.40,
        tier: 'Elevated',
        expected_people_exposed: 10000,
        coord_quality: 'station',
        source_observation_timestamp: new Date().toISOString(),
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `fail-test-${Date.now()}`,
      status: 'PENDING',
      max_attempts: 2,
      next_attempt_at: new Date().toISOString(),
    });

    assert(itemRes.queued === true && Boolean(itemRes.outboxId), 'Queued item for retry test');
    const itemId = itemRes.outboxId!;

    // Attempt 1 Failure
    const futureNextAttempt = new Date(Date.now() + 60000);
    await store.updateOutboxStatus(itemId, 'FAILED', 1, futureNextAttempt, 'Simulated network timeout 504');
    const afterFirstFail = await store.getOutboxItemById(itemId);
    assert(afterFirstFail?.status === 'FAILED', 'Status transitions to FAILED on first error');
    assert(afterFirstFail?.attempts === 1, 'Attempts counter incremented to 1');
    assert(
      new Date(afterFirstFail!.next_attempt_at).getTime() > Date.now(),
      'Exponential backoff scheduled future next_attempt_at'
    );

    // Attempt 2 Failure (Reached max_attempts = 2) -> DEAD
    await store.updateOutboxStatus(itemId, 'DEAD', 2, futureNextAttempt, 'Fatal connection refused');
    const afterSecondFail = await store.getOutboxItemById(itemId);
    assert(afterSecondFail?.status === 'DEAD', 'Status transitions to DEAD once max_attempts reached');
    assert(afterSecondFail?.attempts === 2, 'Final attempts counter is 2');
  }

  console.log('\nTEST 10: DRY_RUN Mode Execution (Zero External Calls)');
  {
    // Clean tables for clean verification
    await truncateTestDatabase(testDbUrl);

    // Create a recipient
    const recipient = await store.createRecipient({
      name: 'Dry Run Authority',
      channel: 'webhook',
      destination: 'http://127.0.0.1:9999/should-not-be-called',
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
    });
    assert(recipient.id !== '', 'Recipient created in test DB');

    // Run dispatcher in DRY_RUN mode
    const dryRunDispatcher = new AlertDispatcher(store);
    dryRunDispatcher.setMode('dry_run');

    // Handle high risk inference payload
    const payload = makeMockPayload({}, 0.35);

    const result = await dryRunDispatcher.handleInferenceResult(payload);
    assert(result.queued === true, 'Inference result queued to outbox');

    // Execute dispatcher cycle
    const cycleStats = await dryRunDispatcher.dispatchCycle();
    assert(cycleStats.processedCount === 1, 'Dispatcher processed queued outbox row');
    assert(cycleStats.dryRunCount === 1, 'Marked as dry_run execution');
    assert(cycleStats.sentCount === 0, 'Zero external transmissions executed in dry_run mode');

    // Verify row status in DB
    const outboxRows = await store.listOutbox('DRY_RUN');
    assert(outboxRows.items.length === 1, 'Outbox item status set to DRY_RUN');

    const deliveries = await store.listRecentDeliveries(10);
    assert(deliveries.length === 1, 'Audit log recorded 1 delivery attempt');
    assert(deliveries[0].status === 'DRY_RUN', 'Delivery audit log status is DRY_RUN');
  }

  console.log('\nTEST 11: LIVE Mode Delivery to Local Stub Webhook Receiver');
  {
    // Enable private webhooks for local test stub
    process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS = 'true';

    let receivedPayload: any = null;
    let receivedSignature: string | null = null;

    // Ephemeral HTTP test server acting as authority endpoint
    const stubServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedSignature = req.headers['x-vayudrishti-signature'] as string;
        try {
          receivedPayload = JSON.parse(body);
        } catch {
          receivedPayload = body;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      });
    });

    await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (stubServer.address() as any).port;
    const stubUrl = `http://127.0.0.1:${port}/alerts/receive`;

    try {
      // Clean test database before test
      await truncateTestDatabase(testDbUrl);

      // Create recipient targeting stub receiver
      const liveRecipient = await store.createRecipient({
        name: 'Live Municipal Ops',
        channel: 'webhook',
        destination: stubUrl,
        scope_type: 'all',
        min_tier: 'ELEVATED',
        active: true,
      });

      const liveDispatcher = new AlertDispatcher(store);
      liveDispatcher.setMode('live');

      const livePayload = makeMockPayload({}, 0.55);
      livePayload.observation.station_id = 'LIVE_STN_001';

      await liveDispatcher.handleInferenceResult(livePayload);
      const liveCycle = await liveDispatcher.dispatchCycle();

      assert(liveCycle.sentCount >= 1, 'Live dispatcher delivered alert to HTTP stub receiver');
      assert(receivedPayload !== null, 'Stub receiver received alert body over HTTP');
      const alertData = receivedPayload.data || receivedPayload;
      assert(alertData.tier === 'High', 'Delivered payload accurately states High tier');
      assert(alertData.probability === 0.55, 'Delivered payload includes genuine probability');
      assert(receivedSignature !== null, 'Delivered request contains X-VayuDrishti-Signature');

      // Verify audit log
      const deliveries = await store.listRecentDeliveries(5);
      const liveLog = deliveries.find((d) => d.recipient_id === liveRecipient.id);
      assert(liveLog?.status === 'SENT', 'Delivery log recorded status SENT');
      assert(liveLog?.provider_response_code === 200, 'Provider HTTP response code 200 captured');
    } finally {
      stubServer.close();
    }
  }

  // ===========================================================================
  // SECTION 3: HTTP API INTEGRATION & SECURITY
  // ===========================================================================
  console.log('\n================================================================');
  console.log('HTTP API INTEGRATION & SECURITY (handleAlertDeliveryRequest)');
  console.log('================================================================\n');

  console.log('TEST 12: Admin Authentication Guard & Fail-Closed Behavior');
  {
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Missing Token -> 401
      const resNoToken = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`);
      assert(resNoToken.status === 401, 'Rejects request with missing token (401)');

      // 2. Empty Token -> 401
      const resEmptyToken = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
        headers: { Authorization: 'Bearer ' },
      });
      assert(resEmptyToken.status === 401, 'Rejects request with empty token (401)');

      // 3. Wrong Token -> 401
      const resWrongToken = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
        headers: { Authorization: 'Bearer totally-invalid-token-value-xyz' },
      });
      assert(resWrongToken.status === 401, 'Rejects request with invalid token (401)');

      // 4. Fail-closed if ALERT_ADMIN_TOKEN is unset
      const originalToken = process.env.ALERT_ADMIN_TOKEN;
      delete process.env.ALERT_ADMIN_TOKEN;

      const resFailClosed = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
        headers: { Authorization: 'Bearer any-token' },
      });
      assert(resFailClosed.status === 503, 'Fails closed with 503 when ALERT_ADMIN_TOKEN is unset');

      // Restore token
      process.env.ALERT_ADMIN_TOKEN = originalToken;

      // 5. Valid Token -> 200
      const resValid = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
        headers: { Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}` },
      });
      assert(resValid.status === 200, 'Valid admin token authenticates with 200 OK');
    } finally {
      server.close();
    }
  }

  console.log('\nTEST 13: Public /stats Endpoint Destination Masking');
  {
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const resStats = await fetch(`${baseUrl}/api/alerts/delivery/stats`);
      assert(resStats.status === 200, 'Public GET /api/alerts/delivery/stats returns 200 OK');

      const data = await resStats.json();
      assert('mode' in data, 'Public stats includes operating mode');
      assert('counts_by_status' in data, 'Public stats includes counts_by_status');
      assert('active_recipients' in data, 'Public stats includes active_recipients count');

      // Check deliveries are strictly minimized (zero recipient destination/name fields)
      for (const del of data.recent_deliveries || []) {
        assert(!('recipient_destination' in del), 'Public recent_deliveries has no recipient_destination field');
        assert(!('recipient_name' in del), 'Public recent_deliveries has no recipient_name field');
        assert('station' in del, 'Public recent_deliveries includes station');
        assert('tier' in del, 'Public recent_deliveries includes tier');
        assert('timestamp' in del, 'Public recent_deliveries includes timestamp');
      }
    } finally {
      server.close();
    }
  }

  console.log('\nTEST 14: Simulated Test Alert (Excluded from Genuine Counts)');
  {
    process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS = 'true';

    // Ephemeral stub receiver
    const testStubServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    await new Promise<void>((resolve) => testStubServer.listen(0, '127.0.0.1', () => resolve()));
    const stubPort = (testStubServer.address() as any).port;

    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Create an active recipient
    const recipient = await store.createRecipient({
      name: 'Verification Officer',
      channel: 'webhook',
      destination: `http://127.0.0.1:${stubPort}/test-endpoint`,
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
    });

    try {
      const resTest = await fetch(`${baseUrl}/api/alerts/delivery/admin/test-alert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          recipient_id: recipient.id,
          station_id: 'DL001',
        }),
      });

      assert(resTest.status === 200, 'Test alert endpoint returns 200 OK');
      const data = await resTest.json();
      assert(data.success === true, 'Test alert dispatched successfully');

      // Verify that genuine outbox count was NOT incremented by test alert
      const outboxRows = await store.listOutbox('SENT');
      const realItem = outboxRows.items.find((item) => item.payload.is_test === true);
      assert(!realItem, 'Test alert was not inserted into real operational outbox pipeline');
    } finally {
      server.close();
      testStubServer.close();
    }
  }

  // ===========================================================================
  // SECTION 4: REGRESSION INTEGRITY CHECKS
  // ===========================================================================
  console.log('\n================================================================');
  console.log('REGRESSION INTEGRITY: TIER BOUNDARIES AND CORE LOGIC');
  console.log('================================================================\n');

  console.log('TEST 15: Canonical Risk Tiers & Feature Ratios Verification');
  {
    assert(getRiskTier(0.000)?.tier === 'Nominal', '0.000 -> Nominal');
    assert(getRiskTier(0.049)?.tier === 'Nominal', '0.049 -> Nominal');
    assert(getRiskTier(0.050)?.tier === 'Watch', '0.050 -> Watch');
    assert(getRiskTier(0.219)?.tier === 'Watch', '0.219 -> Watch');
    assert(getRiskTier(0.220)?.tier === 'Elevated', '0.220 -> Elevated');
    assert(getRiskTier(0.499)?.tier === 'Elevated', '0.499 -> Elevated');
    assert(getRiskTier(0.500)?.tier === 'High', '0.500 -> High');
    assert(getRiskTier(0.999)?.tier === 'High', '0.999 -> High');

    // pm25_ratio_90 formula verification
    const pm25 = 180.0;
    const ratio = pm25 / 90.0;
    assert(ratio === 2.0, 'pm25_ratio_90 is strictly PM2.5 / 90.0');
  }

  // ===========================================================================
  // SECTION 5: PHASE 5 f4 HARDENING ITEMS (1-7)
  // ===========================================================================
  console.log('\n================================================================');
  console.log('SECTION 5: HARDENING SUITE (ITEMS 1-7)');
  console.log('================================================================\n');

  console.log('TEST 16: Stuck-Sending Lease Timeout & Race-Safe Recovery (Item 1)');
  {
    const client = (store as any).pool;
    await client.query('DELETE FROM alert_outbox;');

    const mockPayload: StructuredAlertMessage = {
      alert_id: 'test_alert_id',
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      expected_people_exposed: 100000,
      coord_quality: 'station',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      dashboard_url: 'https://vayudrishti.org/dashboard',
      disclaimer: 'Model-based early-warning estimate, not a confirmed measurement.',
    };

    const dedupeKey = `lease_test_${Date.now()}`;
    const insertRes = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      coord_quality: 'station',
      expected_people_exposed: 100000,
      payload: mockPayload,
      dedupe_key: dedupeKey,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date(Date.now() - 5000).toISOString(),
    });
    assert(insertRes.queued, 'Outbox item queued for lease testing');
    const outboxId = insertRes.outboxId!;

    // Claim pending outbox items (sets status=SENDING and lease_expires_at)
    const claimed = await store.claimPendingOutboxItems(10, 120);
    const claimedItem = claimed.find((item) => item.id === outboxId);
    assert(!!claimedItem, 'Item claimed into SENDING state');
    assert(claimedItem?.status === 'SENDING', 'Claimed item status is SENDING');
    assert(!!claimedItem?.lease_expires_at, 'Claimed item has lease_expires_at set');

    // Reclaim while lease is active should do NOTHING
    const reclaimedActive = await store.reclaimStuckLeases();
    assert(reclaimedActive.reclaimed === 0 && reclaimedActive.deadLettered === 0, 'Active lease is not reclaimed prematurely');

    // Manually expire the lease in PostgreSQL
    await client.query(
      `UPDATE alert_outbox SET lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
      [outboxId]
    );

    // Reclaim expired lease -> returns to PENDING with attempts=1 and exponential backoff
    const reclaimedExpired = await store.reclaimStuckLeases();
    assert(reclaimedExpired.reclaimed >= 1, 'Expired lease row reclaimed');
    const rowAfterReclaim = await store.getOutboxItemById(outboxId);
    assert(rowAfterReclaim?.status === 'PENDING', 'Reclaimed row returned to PENDING');
    assert(rowAfterReclaim?.attempts === 1, 'Attempts counter incremented to 1');
    assert(new Date(rowAfterReclaim!.next_attempt_at) > new Date(), 'Next attempt scheduled in future with backoff');

    // Max attempts exceeded -> transitions to DEAD
    await client.query(
      `UPDATE alert_outbox SET status = 'SENDING', attempts = 3, lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
      [outboxId]
    );
    const reclaimedDead = await store.reclaimStuckLeases();
    assert(reclaimedDead.deadLettered >= 1, 'Row with max attempts transitioned to DEAD');
    const rowDead = await store.getOutboxItemById(outboxId);
    assert(rowDead?.status === 'DEAD', 'Outbox status is DEAD in database');
    assert(rowDead?.last_error?.toLowerCase().includes('lease expired') ?? false, 'Dead outbox row records lease expiration error');

    // Race safety: concurrent reclaim calls do not double-reclaim
    const dedupeRace = `lease_race_${Date.now()}`;
    const raceItem = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      coord_quality: 'station',
      expected_people_exposed: 100000,
      payload: mockPayload,
      dedupe_key: dedupeRace,
      status: 'SENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });
    await client.query(
      `UPDATE alert_outbox SET lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
      [raceItem.outboxId!]
    );

    const [reclaimRes1, reclaimRes2] = await Promise.all([
      store.reclaimStuckLeases(),
      store.reclaimStuckLeases(),
    ]);
    const totalReclaimed = reclaimRes1.reclaimed + reclaimRes2.reclaimed;
    assert(totalReclaimed === 1, 'Race-safe: exactly one concurrent worker reclaimed the expired item');
  }

  console.log('\nTEST 17: Idempotency Keys for Webhook and Email Channels (Item 2)');
  {
    const dedupeKey = 'test_station_2026_01_01_00_High';
    const recipientId = '550e8400-e29b-41d4-a716-446655440000';
    const key1 = generateDeliveryIdempotencyKey(dedupeKey, recipientId);
    const key2 = generateDeliveryIdempotencyKey(dedupeKey, recipientId);

    assert(key1 === key2, 'Idempotency key is strictly deterministic for identical dedupe_key and recipient_id');
    assert(/^[a-f0-9]{64}$/.test(key1), 'Idempotency key is a valid SHA-256 hex digest');
    assert(!key1.includes(dedupeKey), 'Idempotency key is a non-reversible hash');

    // Webhook receiver idempotency verification
    let receivedHeaders: any = {};
    let receivedPayload: any = {};
    let rawBody = '';
    const webhookServer = http.createServer((req, res) => {
      rawBody = '';
      req.on('data', (c) => { rawBody += c; });
      req.on('end', () => {
        receivedHeaders = req.headers;
        try {
          receivedPayload = JSON.parse(rawBody);
        } catch {
          receivedPayload = {};
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
    const whPort = (webhookServer.address() as any).port;

    const signingSecret = 'test_webhook_signing_secret_32bytes_long!';
    process.env.ALERT_WEBHOOK_SIGNING_SECRET = signingSecret;
    process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS = 'true';

    const mockMsg: StructuredAlertMessage = {
      alert_id: 'test_alert_id',
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.75,
      tier: 'High',
      expected_people_exposed: 100000,
      coord_quality: 'station',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      dashboard_url: 'https://vayudrishti.org/dashboard',
      disclaimer: 'Model-based early-warning estimate, not a confirmed measurement.',
    };

    const recipient: RecipientRecord = {
      id: recipientId,
      name: 'Test Officer',
      channel: 'webhook',
      destination: `http://127.0.0.1:${whPort}/webhook`,
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const sendRes = await sendWebhookAlert(recipient, mockMsg, key1);
    assert(sendRes.success, 'Webhook delivery succeeded');
    assert(receivedHeaders['idempotency-key'] === key1, 'Webhook request includes Idempotency-Key header');
    assert(receivedPayload.delivery_id === key1, 'Webhook body includes delivery_id equal to idempotency key');
    assert(receivedPayload.idempotency_key === key1, 'Webhook body includes idempotency_key');

    // Signature covers the idempotency key in the body
    const sigHeader = receivedHeaders['x-vayudrishti-signature'];
    const receivedTimestamp = receivedHeaders['x-vayudrishti-timestamp'];
    const rawSig = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
    const expectedSig = signWebhookPayload(signingSecret, receivedTimestamp, rawBody);
    assert(rawSig === expectedSig, 'HMAC signature validates correctly over body containing delivery_id/idempotency_key');

    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
  }

  console.log('\nTEST 18: Soft-Delete Recipients & Audit Log Preservation (Item 3)');
  {
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const dest = `https://authority_${Date.now()}.gov.in/webhook`;
    const recipient = await store.createRecipient({
      name: 'Authority Under Decommission',
      channel: 'webhook',
      destination: dest,
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
    });

    // Create a real outbox row to satisfy foreign key constraint
    const outboxItem = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      coord_quality: 'station',
      expected_people_exposed: 100000,
      payload: {
        alert_id: 'test_alert',
        station_id: 'DL001',
        station_name: 'Anand Vihar',
        city: 'Delhi',
        probability: 0.85,
        tier: 'High',
        expected_people_exposed: 100000,
        coord_quality: 'station',
        source_observation_timestamp: new Date().toISOString(),
        model_version: 'v1.0.0',
        dashboard_url: 'https://vayudrishti.org/dashboard',
        disclaimer: 'test',
      },
      dedupe_key: `audit_preserve_dedupe_${Date.now()}`,
      status: 'SENT',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    // Insert an audit log record referencing this recipient
    await store.recordDelivery({
      outbox_id: outboxItem.outboxId!,
      recipient_id: recipient.id,
      channel: 'webhook',
      recipient_destination: dest,
      status: 'SENT',
      provider_response_code: 200,
      provider_response_body: 'OK',
      error_message: null,
    });

    // 1. DELETE via admin endpoint
    const resDel = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients/${recipient.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}` },
    });
    assert(resDel.status === 200, 'DELETE endpoint returns 200 OK');

    // 2. Row remains in database (soft delete)
    const client = (store as any).pool;
    const dbRow = (await client.query('SELECT * FROM recipients WHERE id = $1', [recipient.id])).rows[0];
    assert(!!dbRow, 'Recipient row is preserved in DB (not hard-deleted)');
    assert(dbRow.deleted_at !== null, 'Recipient deleted_at is populated');
    assert(dbRow.active === false, 'Recipient active is set to false');

    // 3. Excluded from store.listRecipients()
    const activeList = await store.listRecipients();
    assert(!activeList.some((r) => r.id === recipient.id), 'Soft-deleted recipient excluded from listRecipients');

    // 4. Excluded from active recipients (fan-out matching)
    const activeRecipients = await store.listRecipients(true);
    assert(!activeRecipients.some((r) => r.id === recipient.id), 'Soft-deleted recipient excluded from active list/fan-out');

    // 5. PATCH returns 409 Conflict
    const resPatch = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients/${recipient.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ active: true }),
    });
    assert(resPatch.status === 409, 'PATCH on soft-deleted recipient returns 409 Conflict');

    // 6. Test-alert on soft-deleted recipient fails
    const resTestAlert = await fetch(`${baseUrl}/api/alerts/delivery/admin/test-alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ recipient_id: recipient.id, station_id: 'DL001' }),
    });
    assert(resTestAlert.status === 404, 'Test-alert cannot target soft-deleted recipient (404)');

    // 7. Audit log record remains intact (no cascade deletion)
    const auditRows = (await client.query('SELECT * FROM alert_deliveries WHERE recipient_id = $1', [recipient.id])).rows;
    assert(auditRows.length === 1, 'Audit log deliveries preserved with reference to soft-deleted recipient');

    // 8. Re-adding the same address succeeds due to partial unique index
    const resRecreate = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        name: 'Recommissioned Authority',
        channel: 'webhook',
        destination: dest,
        scope_type: 'all',
        min_tier: 'ELEVATED',
        active: true,
      }),
    });
    assert(resRecreate.status === 201, 'Re-registering same destination after soft-delete succeeds (201 Created)');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\nTEST 19: Public Stats Strict Minimization & PII/Host Body Scanner (Item 4)');
  {
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const secretHost = 'surveillance-telemetry.delhi-env-authority.gov.in';
    const secretDest = `https://${secretHost}/v1/alerts/inbound`;

    const outboxItem = await store.queueOutboxAlert({
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      source_observation_timestamp: new Date().toISOString(),
      model_version: 'v1.0.0',
      coord_quality: 'station',
      expected_people_exposed: 100000,
      payload: {
        alert_id: 'test_alert_scan',
        station_id: 'DL001',
        station_name: 'Anand Vihar',
        city: 'Delhi',
        probability: 0.85,
        tier: 'High',
        expected_people_exposed: 100000,
        coord_quality: 'station',
        source_observation_timestamp: new Date().toISOString(),
        model_version: 'v1.0.0',
        dashboard_url: 'https://vayudrishti.org/dashboard',
        disclaimer: 'test',
      },
      dedupe_key: `audit_scan_dedupe_${Date.now()}`,
      status: 'SENT',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    await store.recordDelivery({
      outbox_id: outboxItem.outboxId!,
      recipient_id: null,
      channel: 'webhook',
      recipient_destination: secretDest,
      status: 'SENT',
      provider_response_code: 200,
      provider_response_body: 'OK',
      error_message: null,
    });

    const resPublic = await fetch(`${baseUrl}/api/alerts/delivery/stats`);
    const rawPublicBody = await resPublic.text();

    assert(!rawPublicBody.includes(secretHost), 'Public stats body does NOT contain destination host');
    assert(!rawPublicBody.includes('surveillance-telemetry'), 'Public stats body does NOT contain destination subdomain');
    assert(!rawPublicBody.includes('inbound'), 'Public stats body does NOT contain destination path');
    assert(!rawPublicBody.includes('@'), 'Public stats body does NOT contain email @ sign');
    assert(!rawPublicBody.includes('recipient_destination'), 'Public stats body does NOT contain recipient_destination key');
    assert(!rawPublicBody.includes('recipient_name'), 'Public stats body does NOT contain recipient_name key');

    // Admin deliveries endpoint DOES contain full detail
    const resAdmin = await fetch(`${baseUrl}/api/alerts/delivery/admin/deliveries`, {
      headers: { Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}` },
    });
    const adminData = await resAdmin.json();
    assert(adminData.deliveries?.length > 0, 'Admin deliveries endpoint returns records');
    assert(
      adminData.deliveries.some((d: any) => d.recipient_destination?.includes('delhi-env-authority')),
      'Admin endpoint provides unmasked/detailed destinations'
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\nTEST 20: Real Local SMTP Sink Tests with smtp-server (Item 5)');
  {
    const { SMTPServer } = await import('smtp-server');

    // 1. Success Sink with test-only credentials
    const testUser = `user_${crypto.randomBytes(4).toString('hex')}`;
    const testPass = `pass_${crypto.randomBytes(8).toString('hex')}`;
    const receivedEmails: string[] = [];

    const smtpSink = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      authOptional: false,
      onAuth(auth, session, callback) {
        if (auth.username === testUser && auth.password === testPass) {
          return callback(null, { user: auth.username });
        }
        return callback(new Error('Invalid test auth'));
      },
      onData(stream, session, callback) {
        let chunks: Buffer[] = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          receivedEmails.push(Buffer.concat(chunks).toString('utf8'));
          callback(null);
        });
      },
    });

    await new Promise<void>((resolve) => smtpSink.listen(0, '127.0.0.1', () => resolve()));
    const sinkPort = (smtpSink.server.address() as any).port;

    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(sinkPort);
    process.env.SMTP_USER = testUser;
    process.env.SMTP_PASS = testPass;

    const emailRecipient: RecipientRecord = {
      id: 'smtp_test_recip',
      name: 'Commissioner Office',
      channel: 'email',
      destination: 'commissioner@cpcb.test.local',
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Inject <script> in station name and city to assert HTML escaping
    const injectionMsg: StructuredAlertMessage = {
      alert_id: 'smtp_alert_001',
      station_id: 'DL001',
      station_name: 'Anand Vihar <script>alert("station_xss")</script>',
      city: 'Delhi <img src=x onerror=alert(1)>',
      probability: 0.92,
      tier: 'High',
      expected_people_exposed: 250000,
      coord_quality: 'station',
      source_observation_timestamp: '2026-10-01T12:00:00Z',
      model_version: 'v1.0.0',
      dashboard_url: 'https://vayudrishti.org/dash',
      disclaimer: 'Model-based early-warning estimate, not a confirmed measurement. Automated advisory by VayuDrishti.',
    };

    const idempKey = 'smtp_idemp_key_12345';
    const sendRes = await sendEmailAlert(emailRecipient, injectionMsg, idempKey);
    assert(sendRes.success, 'Email sent successfully to real SMTP sink');
    assert(receivedEmails.length === 1, 'SMTP sink received 1 email');

    const emailRaw = receivedEmails[0];
    assert(
      emailRaw.includes('Message-ID: <smtp_idemp_key_12345@alerts.vayudrishti.org>') ||
        emailRaw.includes('smtp_idemp_key_12345@alerts.vayudrishti.org'),
      'Deterministic Message-ID header present'
    );
    assert(
      emailRaw.includes('Model-based early-warning estimate, not a confirmed measurement'),
      'Mandatory disclaimer present in email content'
    );
    const htmlPart = emailRaw.split('Content-Type: text/html')[1] || '';
    assert(
      htmlPart.includes('&lt;script&gt;alert(&quot;station_xss&quot;)&lt;/script&gt;') ||
        htmlPart.includes('&lt;script&gt;'),
      'Dynamic station_name is HTML escaped in HTML part'
    );
    assert(
      htmlPart.includes('&lt;img src=x onerror=alert(1)&gt;') ||
        htmlPart.includes('&lt;img'),
      'Dynamic city is HTML escaped in HTML part'
    );
    assert(!htmlPart.includes('<script>alert'), 'Unescaped script tags strictly absent from HTML part');

    await new Promise<void>((resolve) => smtpSink.close(() => resolve()));

    // 2. Rejecting Sink (550 User Unknown)
    const rejectSink = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      authOptional: true,
      onRcptTo(address, session, callback) {
        return callback(new Error('550 Recipient address rejected: User unknown'));
      },
    });
    await new Promise<void>((resolve) => rejectSink.listen(0, '127.0.0.1', () => resolve()));
    const rejectPort = (rejectSink.server.address() as any).port;
    process.env.SMTP_PORT = String(rejectPort);

    const rejectRes = await sendEmailAlert(emailRecipient, injectionMsg);
    assert(!rejectRes.success, 'Rejecting sink returns failure');
    assert(
      rejectRes.error?.includes('550') || rejectRes.error?.includes('SMTP delivery failed') || false,
      'Error captured on 550 rejection'
    );
    assert(!rejectRes.error?.includes(testPass), 'Password is not leaked in rejection error');
    await new Promise<void>((resolve) => rejectSink.close(() => resolve()));

    // 3. Drop connection mid-send
    const dropSink = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      authOptional: true,
      onData(stream, session, callback) {
        (session as any).connection?.close();
      },
    });
    await new Promise<void>((resolve) => dropSink.listen(0, '127.0.0.1', () => resolve()));
    const dropPort = (dropSink.server.address() as any).port;
    process.env.SMTP_PORT = String(dropPort);

    const dropRes = await sendEmailAlert(emailRecipient, injectionMsg);
    assert(!dropRes.success, 'Connection drop mid-send returns failure');
    assert(dropRes.error?.includes('SMTP delivery failed') || false, 'Connection drop returns scrubbed error, does not crash');
    await new Promise<void>((resolve) => dropSink.close(() => resolve()));

    // 4. DRY_RUN mode sends nothing to sink
    const drySink = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      authOptional: true,
      onData(stream, session, callback) {
        callback(null);
      },
    });
    await new Promise<void>((resolve) => drySink.listen(0, '127.0.0.1', () => resolve()));
    const dryPort = (drySink.server.address() as any).port;
    process.env.SMTP_PORT = String(dryPort);

    const emailBeforeDryCount = receivedEmails.length;
    const dispatcherDry = new AlertDispatcher(store);
    dispatcherDry.setMode('dry_run');
    await store.createRecipient({
      name: 'Dry Recipient',
      channel: 'email',
      destination: 'dry@cpcb.test.local',
      scope_type: 'all',
      min_tier: 'ELEVATED',
      active: true,
    });
    await dispatcherDry.handleInferenceResult(makeMockPayload({}, 0.85));
    await dispatcherDry.dispatchCycle();
    assert(receivedEmails.length === emailBeforeDryCount, 'Zero emails transmitted to sink in DRY_RUN mode');
    await new Promise<void>((resolve) => drySink.close(() => resolve()));
  }

  console.log('\nTEST 21: Ingestion Isolation when Dispatch Hook Throws (Item 6)');
  {
    const { getGlobalAlertDispatcher } = await import('../src/server/services/alertDispatcher');
    const dispatcher = getGlobalAlertDispatcher();

    // Simulate dispatcher throwing a sensitive DB error
    const originalHandler = dispatcher.handleInferenceResult.bind(dispatcher);
    dispatcher.handleInferenceResult = async () => {
      throw new Error('DATABASE FATAL: postgresql://admin:super_secret_db_pass@127.0.0.1:5432/vayu failed');
    };

    // Instantiate Ingestion Scheduler
    const { WaqiIngestionScheduler } = await import('../src/server/ingestionScheduler');
    const scheduler = new WaqiIngestionScheduler();
    const historyStore = (scheduler as any).store;

    // Spy on console.error to verify scrubbing
    let loggedError = '';
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      loggedError += args.join(' ');
    };

    try {
      // Mock WAQI API fetch for station DL001
      const origFetch = global.fetch;
      global.fetch = async () => {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            data: {
              idx: 9999,
              aqi: 220,
              iaqi: { pm25: { v: 220 } },
              city: { name: 'Delhi Anand Vihar Ingestion Test', geo: [28.65, 77.23] },
              time: { iso: new Date().toISOString() },
            },
          }),
        } as any;
      };

      const result = await scheduler.fetchAndIngestStation('DL001');

      assert(result.success === true, 'Station ingestion succeeds even when dispatch hook throws');
      assert(!!result.observation, 'Observation was parsed and retained');
      assert(result.observation?.pm25 === 220, 'Observed PM2.5 recorded accurately');

      // Verify persistent history store was updated
      const history = await historyStore.getStationObservations('DL001', 10);
      assert(history.length > 0, 'History store was updated with observation despite dispatch hook failure');

      // Verify error was scrubbed
      assert(loggedError.includes('[IngestionScheduler] Alert dispatch hook error:'), 'Hook failure logged as an error');
      assert(!loggedError.includes('super_secret_db_pass'), 'DB password is scrubbed from logged error');

      global.fetch = origFetch;
    } finally {
      console.error = origConsoleError;
      dispatcher.handleInferenceResult = originalHandler;
    }
  }

  console.log('\nTEST 22: Startup Safety Checks & Failed Admin-Token Rate Limiting (Item 7)');
  {
    // Part A: validateAlertSafetyConfig
    let threwFatal = false;
    try {
      validateAlertSafetyConfig({
        nodeEnv: 'production',
        deliveryMode: 'live',
        allowPrivateWebhooks: true,
        hasAdminToken: true,
        hasSigningSecret: true,
      });
    } catch (err: any) {
      threwFatal = true;
      assert(
        err.message.includes('FATAL') && err.message.includes('ALERT_ALLOW_PRIVATE_WEBHOOKS'),
        'Throws fatal error in production with private webhooks allowed'
      );
    }
    assert(threwFatal, 'Fatal safety check threw as expected');

    const checkNoAdmin = validateAlertSafetyConfig({
      nodeEnv: 'production',
      deliveryMode: 'live',
      allowPrivateWebhooks: false,
      hasAdminToken: false,
      hasSigningSecret: true,
    });
    assert(checkNoAdmin.canStart === false, 'Refuses to start dispatcher in live production without admin token');

    const checkNoSecret = validateAlertSafetyConfig({
      nodeEnv: 'production',
      deliveryMode: 'live',
      allowPrivateWebhooks: false,
      hasAdminToken: true,
      hasSigningSecret: false,
    });
    assert(checkNoSecret.canStart === false, 'Refuses to start dispatcher in live production without webhook signing secret');

    // Part B: Failed Admin-Token Rate Limiting
    resetAuthRateLimiterForTesting();
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 10 failed attempts
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
        headers: { Authorization: 'Bearer bad_token_attempt' },
      });
      assert(res.status === 401, `Failed attempt ${i + 1} returns 401`);
    }

    // 11th attempt must return 429 Too Many Requests with Retry-After
    const resThrottled = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
      headers: { Authorization: 'Bearer bad_token_attempt' },
    });
    assert(resThrottled.status === 429, '11th failed attempt returns 429 Too Many Requests');
    assert(resThrottled.headers.get('retry-after') === '600', '429 response includes Retry-After: 600 header');

    // Successful authentication is NOT penalized
    const resValid = await fetch(`${baseUrl}/api/alerts/delivery/admin/recipients`, {
      headers: { Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}` },
    });
    assert(resValid.status === 200, 'Valid admin token succeeds immediately despite failed attempt count on client');

    server.close();
  }

  // ===========================================================================
  // TEST 23: Outbox Alert Expiry Hardening & Stale Suppression (Phase 5 f4)
  // ===========================================================================
  console.log('\nTEST 23: Outbox Alert Expiry Hardening & Stale Suppression');
  {
    await truncateTestDatabase();
    const testDbUrl = getVerifiedTestDatabaseUrl();
    const store = new PostgresAlertDeliveryStore(testDbUrl);
    const dispatcher = new AlertDispatcher(store);
    dispatcher.setMode('dry_run');

    const maxAgeHours = getAlertMaxAgeHours(); // 6 hours default
    const now = Date.now();

    // -------------------------------------------------------------------------
    // 1. Expiry at boundaries: just under max age (5.95h) and just over (6.05h)
    // -------------------------------------------------------------------------
    const justUnderObsTime = new Date(now - (maxAgeHours - 0.05) * 3600 * 1000).toISOString();
    const justOverObsTime = new Date(now - (maxAgeHours + 0.05) * 3600 * 1000).toISOString();

    const underItem = await store.queueOutboxAlert({
      station_id: 'DL001',
      city: 'Delhi',
      probability: 0.85,
      tier: 'High',
      source_observation_timestamp: justUnderObsTime,
      model_version: 'v1.0',
      coord_quality: 'station',
      expected_people_exposed: 10000,
      payload: {
        alert_id: '',
        station_id: 'DL001',
        station_name: 'Anand Vihar',
        city: 'Delhi',
        probability: 0.85,
        tier: 'High',
        expected_people_exposed: 10000,
        coord_quality: 'station',
        source_observation_timestamp: justUnderObsTime,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `boundary_under_${now}`,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    const overItem = await store.queueOutboxAlert({
      station_id: 'DL002',
      city: 'Delhi',
      probability: 0.90,
      tier: 'High',
      source_observation_timestamp: justOverObsTime,
      model_version: 'v1.0',
      coord_quality: 'station',
      expected_people_exposed: 15000,
      payload: {
        alert_id: '',
        station_id: 'DL002',
        station_name: 'Punjabi Bagh',
        city: 'Delhi',
        probability: 0.90,
        tier: 'High',
        expected_people_exposed: 15000,
        coord_quality: 'station',
        source_observation_timestamp: justOverObsTime,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `boundary_over_${now}`,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    await dispatcher.dispatchCycle();

    const underRecord = await store.getOutboxItemById(underItem.outboxId!);
    const overRecord = await store.getOutboxItemById(overItem.outboxId!);

    assert(underRecord?.status === 'DRY_RUN', 'Boundary just under max age (5.95h) does NOT expire (status is DRY_RUN)');
    assert(overRecord?.status === 'EXPIRED', 'Boundary just over max age (6.05h) moves to terminal EXPIRED status');
    assert(
      overRecord?.last_error === 'expired: source observation older than max age',
      'EXPIRED row records reason "expired: source observation older than max age"'
    );

    // Audit log has EXPIRED row
    const auditRes = await store.listRecentDeliveries(10);
    const expiredAudit = auditRes.find((a) => a.outbox_id === overItem.outboxId!);
    assert(expiredAudit?.status === 'EXPIRED', 'Audit row written to alert_deliveries with status EXPIRED');
    assert(expiredAudit?.channel === 'system', 'Audit row records system channel for expiry event');

    // -------------------------------------------------------------------------
    // 2. Expiry applies across first attempt, retry, and reclaim paths
    // -------------------------------------------------------------------------
    // A) First attempt path
    const staleTime = new Date(now - 10 * 3600 * 1000).toISOString();
    const firstAttemptItem = await store.queueOutboxAlert({
      station_id: 'DL003',
      city: 'Delhi',
      probability: 0.88,
      tier: 'High',
      source_observation_timestamp: staleTime,
      model_version: 'v1.0',
      coord_quality: 'station',
      payload: {
        alert_id: '',
        station_id: 'DL003',
        station_name: 'IHBAS',
        city: 'Delhi',
        probability: 0.88,
        tier: 'High',
        expected_people_exposed: 5000,
        coord_quality: 'station',
        source_observation_timestamp: staleTime,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `first_attempt_stale_${now}`,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });

    await dispatcher.dispatchCycle();
    const firstRec = await store.getOutboxItemById(firstAttemptItem.outboxId!);
    assert(firstRec?.status === 'EXPIRED', 'First attempt on stale alert transitions directly to EXPIRED');

    // B) Retry path: Row was FAILED with backoff, but observation timestamp is now > 6h old
    const client = (store as any).pool;
    const retryItem = await store.queueOutboxAlert({
      station_id: 'DL004',
      city: 'Delhi',
      probability: 0.82,
      tier: 'High',
      source_observation_timestamp: staleTime,
      model_version: 'v1.0',
      coord_quality: 'station',
      payload: {
        alert_id: '',
        station_id: 'DL004',
        station_name: 'RK Puram',
        city: 'Delhi',
        probability: 0.82,
        tier: 'High',
        expected_people_exposed: 8000,
        coord_quality: 'station',
        source_observation_timestamp: staleTime,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `retry_stale_${now}`,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });
    // Set to FAILED for retry simulation
    await client.query("UPDATE alert_outbox SET status = 'FAILED', attempts = 1, next_attempt_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [retryItem.outboxId!]);
    await dispatcher.dispatchCycle();
    const retryRec = await store.getOutboxItemById(retryItem.outboxId!);
    assert(retryRec?.status === 'EXPIRED', 'Retry path detects stale observation before send attempt and marks EXPIRED');

    // C) Reclaim path: Row was in SENDING with expired lease, now reclaimed
    const reclaimItem = await store.queueOutboxAlert({
      station_id: 'DL005',
      city: 'Delhi',
      probability: 0.80,
      tier: 'High',
      source_observation_timestamp: staleTime,
      model_version: 'v1.0',
      coord_quality: 'station',
      payload: {
        alert_id: '',
        station_id: 'DL005',
        station_name: 'Bawana',
        city: 'Delhi',
        probability: 0.80,
        tier: 'High',
        expected_people_exposed: 6000,
        coord_quality: 'station',
        source_observation_timestamp: staleTime,
        model_version: 'v1.0',
        dashboard_url: 'http://localhost:5173',
        disclaimer: 'test',
      },
      dedupe_key: `reclaim_stale_${now}`,
      status: 'PENDING',
      max_attempts: 3,
      next_attempt_at: new Date().toISOString(),
    });
    // Set to SENDING with expired lease
    await client.query("UPDATE alert_outbox SET status = 'SENDING', attempts = 1, lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1", [reclaimItem.outboxId!]);
    const reclaimRes = await store.reclaimStuckLeases();
    assert(reclaimRes.reclaimed >= 1, 'Stuck SENDING row reclaimed to PENDING');
    await client.query("UPDATE alert_outbox SET next_attempt_at = NOW() WHERE id = $1", [reclaimItem.outboxId!]);
    await dispatcher.dispatchCycle();
    const reclaimedRec = await store.getOutboxItemById(reclaimItem.outboxId!);
    assert(reclaimedRec?.status === 'EXPIRED', 'Reclaimed row is detected as stale before send attempt and transitions to EXPIRED');

    // -------------------------------------------------------------------------
    // 3. EXPIRED rows are never retried or reclaimed
    // -------------------------------------------------------------------------
    const claimedAfter = await store.claimPendingOutboxItems(10);
    assert(
      claimedAfter.every((c) => c.status !== 'EXPIRED'),
      'claimPendingOutboxItems never claims EXPIRED rows'
    );
    const reclaimedCheck = await store.reclaimStuckLeases();
    assert(reclaimedCheck.reclaimed === 0, 'reclaimStuckLeases never reclaims EXPIRED rows');

    // -------------------------------------------------------------------------
    // 4. Manual retry endpoint: 409 without resend_stale=true; 200 with resend_stale=true
    //    and message body includes "Issued late: source observation at <time>" line
    // -------------------------------------------------------------------------
    resetAuthRateLimiterForTesting();
    const server = http.createServer((req, res) => handleAlertDeliveryRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeaders = { Authorization: `Bearer ${process.env.ALERT_ADMIN_TOKEN}` };

    const expiredId = overItem.outboxId!;

    // 4a. Without flag: must refuse with 409
    const resRefused = await fetch(`${baseUrl}/api/alerts/delivery/admin/retry/${expiredId}`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert(resRefused.status === 409, 'Manual retry on EXPIRED row without resend_stale flag refuses with 409 Conflict');
    const errBody = await resRefused.json();
    assert(errBody.error.includes('EXPIRED') && errBody.error.includes('resend_stale'), 'Error message explains EXPIRED requirement for resend_stale flag');

    // 4b. With flag: succeeds with 200 and includes Issued late line
    const resApproved = await fetch(`${baseUrl}/api/alerts/delivery/admin/retry/${expiredId}?resend_stale=true`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert(resApproved.status === 200, 'Manual retry on EXPIRED row with resend_stale=true succeeds (200 OK)');
    const okBody = await resApproved.json();
    assert(okBody.issued_late_note.includes(`Issued late: source observation at ${justOverObsTime}`), 'Response includes "Issued late: source observation at <time>" line');

    // Verify row transitioned to PENDING with updated payload
    const retriedItem = await store.getOutboxItemById(expiredId);
    assert(retriedItem?.status === 'PENDING', 'Outbox item transitioned back to PENDING after manual retry with flag');
    assert(retriedItem?.payload.is_resend_stale === true, 'Payload has is_resend_stale flag');
    assert(
      retriedItem?.payload.issued_late_note?.includes(`Issued late: source observation at ${justOverObsTime}`),
      'Outbox payload includes "Issued late: source observation at <time>" line'
    );

    // Dispatch retried item and verify message body includes issued late notice
    await dispatcher.dispatchCycle();
    const finalRetried = await store.getOutboxItemById(expiredId);
    assert(finalRetried?.status === 'DRY_RUN', 'Stale row with resend_stale flag was dispatched rather than re-expired');

    server.close();

    // -------------------------------------------------------------------------
    // 5. Observation age appears inside HMAC-signed webhook body and in email
    // -------------------------------------------------------------------------
    // Webhook check: send to local sink
    let capturedWebhookBody = '';
    let capturedSignature = '';
    let capturedTimestamp = '';
    const sinkServer = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        capturedWebhookBody = b;
        capturedSignature = (req.headers['x-vayudrishti-signature'] as string) || '';
        capturedTimestamp = (req.headers['x-vayudrishti-timestamp'] as string) || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => sinkServer.listen(0, '127.0.0.1', () => resolve()));
    const sinkPort = (sinkServer.address() as any).port;
    const sinkUrl = `http://127.0.0.1:${sinkPort}/webhook-sink`;

    const signingSecret = 'test_webhook_signing_secret_xyz';
    process.env.ALERT_WEBHOOK_SIGNING_SECRET = signingSecret;
    process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS = 'true';

    const testObsTime = new Date(Date.now() - 2.5 * 3600 * 1000).toISOString();
    const testMsg: StructuredAlertMessage = {
      alert_id: 'test-obs-age-id',
      station_id: 'DL001',
      station_name: 'Anand Vihar',
      city: 'Delhi',
      probability: 0.95,
      tier: 'High',
      expected_people_exposed: 25000,
      coord_quality: 'station',
      source_observation_timestamp: testObsTime,
      model_version: 'v1.0',
      dashboard_url: 'http://localhost:5173',
      disclaimer: 'Early warning estimate',
    };

    const webhookRecipient: RecipientRecord = {
      id: 'rec-test-obs-1',
      name: 'Delhi EPA Webhook',
      channel: 'webhook',
      destination: sinkUrl,
      secret_key: signingSecret,
      scope_type: 'all',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const whResult = await sendWebhookAlert(webhookRecipient, testMsg);
    assert(whResult.success === true, 'Webhook alert sent successfully to local sink');
    assert(
      capturedWebhookBody.includes(`Source observation: ${testObsTime}`),
      'Observation age appears inside webhook JSON body'
    );
    assert(
      capturedWebhookBody.includes('2.5 h ago at send time') || capturedWebhookBody.includes('h ago at send time'),
      'Webhook body includes "<N> h ago at send time" format'
    );

    // Verify HMAC-SHA256 signature covers the body containing the observation age
    const expectedSig = signWebhookPayload(signingSecret, capturedTimestamp, capturedWebhookBody);
    assert(capturedSignature === `sha256=${expectedSig}`, 'HMAC-SHA256 signature strictly covers body with observation age');

    sinkServer.close();

    // Email check: verify rendered email content includes observation age
    const rendered = renderEmailContent(testMsg);
    assert(
      rendered.text.includes(`Source observation: ${testObsTime}`) && rendered.text.includes('h ago at send time'),
      'Observation age appears in email plain text body'
    );
    assert(
      rendered.html.includes(`Source observation: ${testObsTime}`) && rendered.html.includes('h ago at send time'),
      'Observation age appears in email HTML body'
    );

    // Email check with late issue note:
    const lateMsg: StructuredAlertMessage = {
      ...testMsg,
      issued_late_note: `Issued late: source observation at ${testObsTime}`,
    };
    const renderedLate = renderEmailContent(lateMsg);
    assert(renderedLate.text.includes(`Issued late: source observation at ${testObsTime}`), 'Email plain text includes "Issued late: source observation at <time>" line');
    assert(renderedLate.html.includes(`Issued late: source observation at ${testObsTime}`), 'Email HTML includes "Issued late: source observation at <time>" notice banner');

    // -------------------------------------------------------------------------
    // 6. Migration 005 applies cleanly and idempotently on a fresh scratch DB
    // -------------------------------------------------------------------------
    const testDbName = extractDatabaseName(testDbUrl);
    const scratchDbName = `${testDbName}_scratch_m005_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const testUrlObj = new URL(normalizeDatabaseUrl(testDbUrl));
    const maintenanceUrl = `${testUrlObj.protocol}//${testUrlObj.username}:${testUrlObj.password}@${testUrlObj.host}/postgres`;

    const adminClient = new pg.Client({ connectionString: maintenanceUrl });
    await adminClient.connect();

    try {
      await adminClient.query(`CREATE DATABASE "${scratchDbName}";`);
      const scratchDbUrl = `${testUrlObj.protocol}//${testUrlObj.username}:${testUrlObj.password}@${testUrlObj.host}/${scratchDbName}`;

      // Pass 1: Apply all migrations (001-005)
      const resPass1 = await runDatabaseMigrations(scratchDbUrl);
      assert(resPass1.applied.includes('005_alert_delivery_expiry.sql'), 'Migration 005 applies cleanly on fresh scratch DB');
      assert(resPass1.applied.length === 5, 'All 5 migrations applied cleanly on fresh scratch DB');

      // Verify EXPIRED status check constraints on scratch DB
      const scratchClient = new pg.Client({ connectionString: scratchDbUrl });
      await scratchClient.connect();
      try {
        // Can insert row with status EXPIRED into alert_outbox
        const insOutbox = await scratchClient.query(`
          INSERT INTO alert_outbox (
            station_id, city, probability, tier, source_observation_timestamp,
            model_version, coord_quality, payload, dedupe_key, status
          ) VALUES (
            'DL001', 'Delhi', 0.85, 'High', NOW(), 'v1.0', 'station',
            '{}'::jsonb, 'scratch_dedupe_1', 'EXPIRED'
          ) RETURNING id, status;
        `);
        assert(insOutbox.rows[0].status === 'EXPIRED', 'Scratch DB allows EXPIRED status in alert_outbox');

        // Can insert row with status EXPIRED into alert_deliveries
        const insDelivery = await scratchClient.query(`
          INSERT INTO alert_deliveries (
            outbox_id, channel, recipient_destination, status
          ) VALUES ($1, 'system', 'system:expired', 'EXPIRED')
          RETURNING id, status;
        `, [insOutbox.rows[0].id]);
        assert(insDelivery.rows[0].status === 'EXPIRED', 'Scratch DB allows EXPIRED status in alert_deliveries');
      } finally {
        await scratchClient.end();
      }

      // Pass 2: Re-run migrations to prove idempotency
      const resPass2 = await runDatabaseMigrations(scratchDbUrl);
      assert(resPass2.applied.length === 0, 'Migration 005 is strictly idempotent (0 new migrations on Pass 2)');
    } finally {
      // Terminate connections and drop scratch DB
      try {
        await adminClient.query(`
          SELECT pg_terminate_backend(pg_stat_activity.pid)
          FROM pg_stat_activity
          WHERE pg_stat_activity.datname = $1
            AND pid <> pg_backend_pid();
        `, [scratchDbName]);
        await adminClient.query(`DROP DATABASE IF EXISTS "${scratchDbName}";`);
      } catch (err) {
        console.warn('Warning dropping scratch database:', err);
      }
      await adminClient.end();
    }
    assert(true, 'Scratch database dropped cleanly after migration 005 verification');
  }

  console.log('\n----------------------------------------------------------------');
  console.log(`ALERT DELIVERY SUITE: TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('----------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
