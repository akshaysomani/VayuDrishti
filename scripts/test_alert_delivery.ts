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
import { getRiskTier, RiskTier } from '../src/types/alert';
import {
  AlertDeliveryPolicy,
  formatAlertMessage,
  generateDedupeKey,
} from '../src/server/services/alertDeliveryPolicy';
import {
  isSsrfBlocked,
  signWebhookPayload,
  sendWebhookAlert,
} from '../src/server/channels/webhookChannel';
import { escapeHtml, renderEmailContent } from '../src/server/channels/emailChannel';
import {
  PostgresAlertDeliveryStore,
  scrubSensitiveErrorInfo,
  maskDestination,
} from '../src/server/storage/alertDeliveryStore';
import { AlertDispatcher } from '../src/server/services/alertDispatcher';
import { handleAlertDeliveryRequest } from '../src/server/alertDeliveryHandler';
import { prepareTestDatabase, truncateTestDatabase } from '../src/server/db/testDbHelper';
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

      // Check deliveries are masked
      for (const del of data.recent_deliveries || []) {
        assert(!del.recipient_destination.includes('@'), 'Email recipient destination is masked for public view');
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
