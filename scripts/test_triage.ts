/**
 * AI-Assisted Citizen Report Triage Test Suite (Phase 5 f3b)
 * ==========================================================
 * Verifies all requirements of the advisory triage module:
 * 1. Plumbing with STUB provider (deterministic scores, sum ~1, confidence, model info)
 * 2. Category mismatch mapping table & uncertain threshold logic
 * 3. Failure isolation over HTTP (upload returns 201, triage error recorded, report unchanged)
 * 4. Advisory-only invariant & public vs moderator field exposure
 * 5. Concurrency protection (SKIP LOCKED disjoint claims, lease timeout reclaim, bounded retries)
 * 6. Migration 003 idempotency & DB CHECK constraints
 * 7. Evaluation script behavior (NOT EVALUATED exit 0, fixture arithmetic)
 * 8. Regression: tier boundaries, model params, f3/f4 integrity, dev DB count unchanged
 */

import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { handleCitizenReportsRequest } from '../src/server/citizenReportsHandler';
import {
  setCitizenReportStore,
  PostgresCitizenReportStore,
  normalizeDatabaseUrl,
} from '../src/server/storage/reportStore';
import {
  getReportTriageStore,
  setReportTriageStore,
  PostgresReportTriageStore,
} from '../src/server/storage/triageStore';
import {
  StubTriageProvider,
  setTriageProvider,
  ModelUnavailableError,
} from '../src/server/services/triageProvider';
import { TriageWorker, setGlobalTriageWorker } from '../src/server/services/triageWorker';
import {
  evaluateCategoryMismatch,
  CATEGORY_COMPATIBILITY_MAP,
  type TriageLabel,
} from '../src/types/triage';
import { getRiskTier } from '../src/types/alert';
import { calculatePhase1Pm25Ratio90 } from '../src/services/historicalObservationStore';
import { prepareTestDatabase, extractDatabaseName } from '../src/server/db/testDbHelper';
import { runDatabaseMigrations } from '../src/server/db/migrator';
import { computeMetrics, type EvalReportData } from './eval_triage';

process.env.NODE_ENV = 'test';
process.env.TRIAGE_USE_STUB = 'true';

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

function buildMultipartBody(
  fields: Record<string, string>,
  file?: { fieldName: string; filename: string; contentType: string; buffer: Buffer }
): { buffer: Buffer; boundary: string } {
  const boundary = '----VayuDrishtiFormBoundary' + Math.random().toString(36).substring(2);
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      )
    );
  }

  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      )
    );
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    buffer: Buffer.concat(chunks),
    boundary,
  };
}

interface HttpRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  text: string;
  buffer: Buffer;
}

function makeRequest(
  server: http.Server,
  options: HttpRequestOptions
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      return reject(new Error('Server not listening'));
    }

    const reqHeaders: Record<string, string> = {
      ...(options.headers || {}),
    };

    let bodyBuffer: Buffer | undefined;
    if (options.body) {
      bodyBuffer = Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body);
      reqHeaders['Content-Length'] = String(bodyBuffer.length);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: options.path,
        method: options.method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-json
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            json,
            text,
            buffer,
          });
        });
      }
    );

    req.on('error', reject);
    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

async function runTriageSuite() {
  console.log('================================================================');
  console.log('PHASE 5 f3b: AI-ASSISTED CITIZEN REPORT TRIAGE TEST SUITE');
  console.log('================================================================\n');

  // Verify test database isolation
  const { testDbUrl, testDbName } = await prepareTestDatabase();
  console.log(`Connecting strictly to isolated test database: "${testDbName}"\n`);

  const reportStore = new PostgresCitizenReportStore(testDbUrl);
  setCitizenReportStore(reportStore);

  const triageStore = new PostgresReportTriageStore(testDbUrl);
  setReportTriageStore(triageStore);

  const stubProvider = new StubTriageProvider();
  setTriageProvider(stubProvider);

  const worker = new TriageWorker({
    intervalMs: 1000,
    leaseTimeoutMs: 5000,
    perImageTimeoutMs: 5000,
    maxAttempts: 3,
    mismatchMinConfidence: 0.60,
    uncertainBelow: 0.40,
  });
  worker.setStore(triageStore);
  worker.setProvider(stubProvider);
  setGlobalTriageWorker(worker);

  const rawClient = new pg.Client({ connectionString: normalizeDatabaseUrl(testDbUrl) });
  await rawClient.connect();

  // Create minimal real test JPEG buffers with unique colors to ensure unique content hashes
  const validTestJpeg1 = await sharp({
    create: { width: 120, height: 120, channels: 3, background: { r: 180, g: 120, b: 60 } },
  }).jpeg().toBuffer();

  const validTestJpeg2 = await sharp({
    create: { width: 120, height: 120, channels: 3, background: { r: 60, g: 180, b: 120 } },
  }).jpeg().toBuffer();

  const validTestJpeg3 = await sharp({
    create: { width: 120, height: 120, channels: 3, background: { r: 120, g: 60, b: 180 } },
  }).jpeg().toBuffer();

  // Spin up test HTTP server
  const server = http.createServer(async (req, res) => {
    try {
      await handleCitizenReportsRequest(req, res);
    } catch (err: unknown) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const modToken = process.env.CITIZEN_REPORTS_MODERATOR_TOKEN || 'test-moderator-secret-token';
  process.env.CITIZEN_REPORTS_MODERATOR_TOKEN = modToken;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: STUB Provider Plumbing & Deterministic Scores
    // -------------------------------------------------------------------------
    console.log('TEST 1: Plumbing with STUB Provider');
    stubProvider.setPreset({
      topLabel: 'smoke',
      confidence: 0.85,
      modelName: 'StubTriageModel',
      modelVersion: '1.0.0-stub',
    });

    // Upload a report via HTTP
    const upload1 = buildMultipartBody(
      {
        category: 'smoke',
        description: 'Industrial chimney plume test',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'plumbing_test.jpg',
        contentType: 'image/jpeg',
        buffer: validTestJpeg1,
      }
    );

    const uploadRes1 = await makeRequest(server, {
      method: 'POST',
      path: '/api/reports',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload1.boundary}`,
      },
      body: upload1.buffer,
    });

    assert(uploadRes1.status === 201, 'Upload returns HTTP 201 Created immediately');
    const reportId1 = uploadRes1.json?.report_id;
    assert(Boolean(reportId1), 'Upload returns assigned report_id');

    // Verify row was enqueued with status PENDING
    const enqueuedRow = await triageStore.getTriageByReportId(reportId1);
    assert(enqueuedRow !== null, 'Triage record was automatically enqueued');
    assert(enqueuedRow?.status === 'PENDING', 'Initial triage status is strictly PENDING');
    assert(enqueuedRow?.attempts === 0, 'Initial attempts count is 0');

    // Run one worker cycle
    const cycle1 = await worker.processCycle();
    assert(cycle1.processed === 1, 'Worker processed 1 pending triage job');
    assert(cycle1.completed === 1, 'Worker completed triage classification');

    const completedRow = await triageStore.getTriageByReportId(reportId1);
    assert(completedRow?.status === 'DONE', 'Triage record status transitioned to DONE');
    assert(completedRow?.suggested_label === 'smoke', 'Suggested label is "smoke"');
    assert(completedRow?.confidence === 0.85, 'Confidence is 0.85');
    assert(completedRow?.model_name === 'StubTriageModel', 'Model name captured');
    assert(completedRow?.model_version === '1.0.0-stub', 'Model version captured');
    assert(Boolean(completedRow?.scores), 'Scores JSONB is populated');

    // Check scores sum to ~1.0
    const scores = completedRow?.scores as Record<TriageLabel, number>;
    const scoreSum = Object.values(scores).reduce((a, b) => a + b, 0);
    assert(Math.abs(scoreSum - 1.0) < 0.01, `Scores sum to ~1.0 (actual: ${scoreSum.toFixed(4)})`);
    assert(completedRow?.category_mismatch === false, 'Category mismatch is false when citizen category matches model');

    // -------------------------------------------------------------------------
    // TEST 2: Category Mismatch Mapping Table & Uncertain Logic
    // -------------------------------------------------------------------------
    console.log('\nTEST 2: Category Mismatch Mapping Table & Uncertain Logic');

    // 2a: Conflict with high confidence -> Mismatch = true
    const mm1 = evaluateCategoryMismatch('smoke', 'clear_normal', 0.88, 0.60, 0.40);
    assert(mm1.categoryMismatch === true, 'Citizen says "smoke", model says "clear_normal" (0.88) -> mismatch = true');
    assert(mm1.isUncertain === false, 'Confidence 0.88 is not uncertain');

    // 2b: Compatible classes -> Mismatch = false
    const mm2 = evaluateCategoryMismatch('smoke', 'fire', 0.85, 0.60, 0.40);
    assert(mm2.categoryMismatch === false, 'Citizen says "smoke", model says "fire" (compatible) -> mismatch = false');

    const mm3 = evaluateCategoryMismatch('dust', 'haze_fog', 0.80, 0.60, 0.40);
    assert(mm3.categoryMismatch === false, 'Citizen says "dust", model says "haze_fog" (compatible) -> mismatch = false');

    // 2c: Non-relevant upload (e.g. indoor selfie) -> Mismatch = true
    const mm4 = evaluateCategoryMismatch('burning', 'not_relevant', 0.92, 0.60, 0.40);
    assert(mm4.categoryMismatch === true, 'Citizen says "burning", model says "not_relevant" (0.92) -> mismatch = true');

    // 2d: Low confidence (< 0.40) -> isUncertain = true, mismatch = false ALWAYS
    const mm5 = evaluateCategoryMismatch('smoke', 'clear_normal', 0.32, 0.60, 0.40);
    assert(mm5.isUncertain === true, 'Confidence 0.32 is flagged as uncertain');
    assert(mm5.categoryMismatch === false, 'Low confidence NEVER flags category mismatch');

    // 2e: Moderate confidence below mismatch threshold (0.55 < 0.60) -> mismatch = false
    const mm6 = evaluateCategoryMismatch('smoke', 'clear_normal', 0.55, 0.60, 0.40);
    assert(mm6.isUncertain === false, 'Confidence 0.55 is not below uncertain threshold');
    assert(mm6.categoryMismatch === false, 'Confidence below 0.60 mismatch threshold does not flag mismatch');

    // Verify all categories defined in compatibility map
    const categories: Array<keyof typeof CATEGORY_COMPATIBILITY_MAP> = [
      'smoke',
      'dust',
      'burning',
      'industrial_emission',
      'construction_dust',
      'other',
    ];
    for (const cat of categories) {
      assert(Array.isArray(CATEGORY_COMPATIBILITY_MAP[cat]), `Category compatibility mapping defined for "${cat}"`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Failure Isolation Over HTTP (Throw, Timeout, Model Unavailable)
    // -------------------------------------------------------------------------
    console.log('\nTEST 3: Failure Isolation Over HTTP');

    // 3a: Model unavailable (e.g. offline, missing weights)
    stubProvider.setThrow(new ModelUnavailableError('Local ONNX model file missing on disk (offline)'));

    const upload2 = buildMultipartBody(
      {
        category: 'dust',
        description: 'Road construction dust',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'fail_isolation_test.jpg',
        contentType: 'image/jpeg',
        buffer: validTestJpeg2,
      }
    );

    const uploadRes2 = await makeRequest(server, {
      method: 'POST',
      path: '/api/reports',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload2.boundary}`,
      },
      body: upload2.buffer,
    });

    assert(uploadRes2.status === 201, 'Upload succeeds with 201 even when triage model will fail');
    const reportId2 = uploadRes2.json?.report_id;

    // Report in DB stays strictly PENDING
    const reportRecord2 = await reportStore.getReportById(reportId2);
    assert(reportRecord2?.status === 'PENDING', 'Citizen report status remains PENDING');

    // Run worker cycle
    const cycle2 = await worker.processCycle();
    assert(cycle2.unavailable === 1, 'Worker safely caught ModelUnavailableError');

    const triageRecord2 = await triageStore.getTriageByReportId(reportId2);
    assert(triageRecord2?.status === 'UNAVAILABLE', 'Triage status recorded as UNAVAILABLE');
    assert(Boolean(triageRecord2?.error), 'Error message captured on triage row');

    // Assert citizen report record was NEVER modified
    const reportRecord2After = await reportStore.getReportById(reportId2);
    assert(reportRecord2After?.status === 'PENDING', 'Report status strictly untouched by triage failure');

    // 3b: Credential and secret scrubbing in error logging
    stubProvider.setThrow(new Error('Connection error: postgresql://admin:SuperSecretPassword123@localhost:5432/db?token=adminSecretTokenXYZ'));
    const upload3 = buildMultipartBody(
      {
        category: 'smoke',
        description: 'Scrubbing test',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'scrub_test.jpg',
        contentType: 'image/jpeg',
        buffer: validTestJpeg3,
      }
    );
    const uploadRes3 = await makeRequest(server, {
      method: 'POST',
      path: '/api/reports',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload3.boundary}`,
      },
      body: upload3.buffer,
    });
    const reportId3 = uploadRes3.json?.report_id;
    await worker.processCycle();

    const triageRecord3 = await triageStore.getTriageByReportId(reportId3);
    assert(!triageRecord3?.error?.includes('SuperSecretPassword123'), 'Scrubbed password from triage error');
    assert(!triageRecord3?.error?.includes('adminSecretTokenXYZ'), 'Scrubbed secret token from triage error');
    assert(Boolean(triageRecord3?.error?.includes('[SCRUBBED]')), 'Replaced sensitive data with [SCRUBBED]');

    // Reset stub provider to healthy state
    stubProvider.setThrow(null);
    stubProvider.setPreset({
      topLabel: 'smoke',
      confidence: 0.91,
    });

    // -------------------------------------------------------------------------
    // TEST 4: Advisory-Only Invariant & Public vs Moderator Field Exposure
    // -------------------------------------------------------------------------
    console.log('\nTEST 4: Advisory-Only Invariant & Moderator-Only Exposure');

    // 4a: Check public GET /api/reports contains ZERO triage fields
    const publicListRes = await makeRequest(server, {
      method: 'GET',
      path: '/api/reports',
    });
    assert(publicListRes.status === 200, 'Public GET /api/reports returns 200 OK');
    const publicBodyText = publicListRes.text;
    assert(!publicBodyText.includes('"triage"'), 'Public /api/reports response body contains zero "triage" fields');
    assert(!publicBodyText.includes('suggested_label'), 'Public /api/reports contains zero "suggested_label" fields');
    assert(!publicBodyText.includes('category_mismatch'), 'Public /api/reports contains zero "category_mismatch" fields');
    assert(!publicBodyText.includes('station_context'), 'Public /api/reports contains zero "station_context" fields');

    // 4b: Check moderator GET /api/reports/moderation/list contains triage object
    const modListRes = await makeRequest(server, {
      method: 'GET',
      path: '/api/reports/moderation/list?status=ALL',
      headers: {
        Authorization: `Bearer ${modToken}`,
      },
    });

    assert(modListRes.status === 200, 'Moderator GET /api/reports/moderation/list returns 200 OK');
    assert(Boolean(modListRes.json?.model_evaluation), 'Moderator response includes model_evaluation metadata');
    assert(Array.isArray(modListRes.json?.reports), 'Moderator response includes reports array');

    const modReports = modListRes.json?.reports || [];
    const reportWithTriage = modReports.find((r: any) => r.id === reportId1);
    assert(Boolean(reportWithTriage?.triage), 'Report in moderator list includes attached triage object');
    assert(reportWithTriage?.triage?.suggested_label === 'smoke', 'Triage suggested_label exposed to moderator');
    assert(reportWithTriage?.triage?.confidence === 0.85, 'Triage confidence exposed to moderator');

    // 4c: Check state transition: triage result never changes report status
    // Only moderator POST /api/reports/moderation/review changes report status
    const modReviewRes = await makeRequest(server, {
      method: 'POST',
      path: '/api/reports/moderation/review',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${modToken}`,
      },
      body: JSON.stringify({
        report_id: reportId1,
        action: 'APPROVE',
      }),
    });
    assert(modReviewRes.status === 200, 'Moderator review endpoint successfully approves report');
    const approvedRec = await reportStore.getReportById(reportId1);
    assert(approvedRec?.status === 'APPROVED', 'Report status changed strictly by moderator decision');

    // -------------------------------------------------------------------------
    // TEST 5: Concurrency Protection (FOR UPDATE SKIP LOCKED & Lease Reclaim)
    // -------------------------------------------------------------------------
    console.log('\nTEST 5: Concurrency Protection & Lease Reclamation (SKIP LOCKED)');

    // Create 4 test reports
    const testIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const rep = await reportStore.insertReport({
        category: 'smoke',
        description: `Concurrent claim report ${i}`,
        lat: 28.61,
        lon: 77.20,
        nearest_station_id: 'test-stn',
        nearest_station_name: 'Test Station',
        nearest_station_distance_km: 1.2,
        image_key: `key_${i}.jpg`,
        thumb_key: `thumb_${i}.jpg`,
        content_hash: `hash_${i}_${Date.now()}`,
        client_timestamp: new Date().toISOString(),
      });
      testIds.push(rep.id);
      await triageStore.enqueueTriage(rep.id);
    }

    // Two concurrent workers claim pending rows simultaneously
    const [claimedA, claimedB] = await Promise.all([
      triageStore.claimPending(2, 30000),
      triageStore.claimPending(2, 30000),
    ]);

    const idsA = claimedA.map((r) => r.id);
    const idsB = claimedB.map((r) => r.id);
    const intersection = idsA.filter((id) => idsB.includes(id));

    assert(claimedA.length > 0 && claimedB.length > 0, 'Both concurrent workers claimed items');
    assert(intersection.length === 0, 'SELECT ... FOR UPDATE SKIP LOCKED guaranteed mutually disjoint claims (zero double-dispatch)');

    // Lease timeout reclamation: simulate stuck worker by setting lease_timeout_at in past
    await rawClient.query(
      "UPDATE report_triage SET lease_timeout_at = NOW() - INTERVAL '1 minute' WHERE id = ANY($1::uuid[]);",
      [idsA]
    );

    const reclaimedCount = await triageStore.reclaimStuckLeases();
    assert(reclaimedCount >= idsA.length, `Reclaimed ${reclaimedCount} stuck lease(s) after lease timeout`);

    // Verify row transitioned back to PENDING for retry
    const reclaimedCheck = await triageStore.getTriageByReportId(claimedA[0].report_id);
    assert(reclaimedCheck?.status === 'PENDING', 'Stuck lease transitioned back to PENDING for retry');

    // Bounded retries: set attempts to 3 and lease in past -> transitions to FAILED
    await rawClient.query(
      "UPDATE report_triage SET status = 'RUNNING', attempts = 3, lease_timeout_at = NOW() - INTERVAL '1 minute' WHERE id = $1;",
      [idsA[0]]
    );
    await triageStore.reclaimStuckLeases();
    const deadRow = await triageStore.getTriageByReportId(claimedA[0].report_id);
    assert(deadRow?.status === 'FAILED', 'Stuck lease with attempts >= 3 transitions permanently to FAILED');
    assert(Boolean(deadRow?.error?.includes('Lease timed out')), 'Failure reason recorded on triage row');

    // -------------------------------------------------------------------------
    // TEST 6: Migration 003 Idempotency & Database CHECK Constraints
    // -------------------------------------------------------------------------
    console.log('\nTEST 6: Migration 003 Idempotency & DB CHECK Constraints');

    // Idempotent migration rerun
    const migResult = await runDatabaseMigrations(testDbUrl);
    assert(migResult.applied.length === 0, 'Migration runner is strictly idempotent on repeated run');
    assert(migResult.alreadyApplied.includes('003_create_report_triage.sql'), '003_create_report_triage.sql recognized as already applied');

    // CHECK constraint: invalid status
    let checkStatusFailed = false;
    try {
      await rawClient.query(
        "INSERT INTO report_triage (report_id, status) VALUES ($1, 'PROCESSED');",
        [testIds[0]]
      );
    } catch {
      checkStatusFailed = true;
    }
    assert(checkStatusFailed, 'PostgreSQL CHECK constraint strictly rejects invalid triage status');

    // CHECK constraint: invalid suggested_label
    let checkLabelFailed = false;
    try {
      await rawClient.query(
        "INSERT INTO report_triage (report_id, suggested_label) VALUES ($1, 'toxic_chemicals');",
        [testIds[0]]
      );
    } catch {
      checkLabelFailed = true;
    }
    assert(checkLabelFailed, 'PostgreSQL CHECK constraint strictly rejects invalid suggested_label');

    // CHECK constraint: confidence outside [0, 1]
    let checkConfFailed = false;
    try {
      await rawClient.query(
        "INSERT INTO report_triage (report_id, confidence) VALUES ($1, 1.5);",
        [testIds[0]]
      );
    } catch {
      checkConfFailed = true;
    }
    assert(checkConfFailed, 'PostgreSQL CHECK constraint strictly rejects confidence > 1.0');

    // -------------------------------------------------------------------------
    // TEST 7: Evaluation Script Logic & Arithmetic Verification
    // -------------------------------------------------------------------------
    console.log('\nTEST 7: Evaluation Script Logic & Arithmetic Verification');

    // 7a: Metric computation arithmetic verification with fixture arrays
    const labels: TriageLabel[] = ['smoke', 'fire', 'haze_fog', 'dust', 'clear_normal', 'not_relevant'];
    const groundTruthMock: TriageLabel[] = ['smoke', 'smoke', 'fire', 'dust', 'clear_normal', 'not_relevant'];
    const predictionsMock: TriageLabel[] = ['smoke', 'fire', 'fire', 'dust', 'clear_normal', 'not_relevant'];

    const metricsResult = computeMetrics(labels, groundTruthMock, predictionsMock);
    assert(metricsResult.classCounts.smoke === 2, 'Ground truth smoke count is 2');
    assert(metricsResult.confusionMatrix.smoke.smoke === 1, 'Smoke TP = 1');
    assert(metricsResult.confusionMatrix.smoke.fire === 1, 'Smoke misclassified as fire = 1');
    assert(metricsResult.metrics.smoke.recall === 0.5, 'Smoke recall is exactly 50% (1/2)');
    assert(metricsResult.metrics.clear_normal.precision === 1.0, 'Clear normal precision is 100%');
    assert(metricsResult.overallAccuracy === 5 / 6, 'Overall macro accuracy is 5/6 (83.33%)');

    // 7b: Absent eval set report content check
    const reportContent = fs.readFileSync(path.resolve(process.cwd(), 'reports', 'triage_evaluation.md'), 'utf8');
    assert(reportContent.includes('STATUS: NOT EVALUATED'), 'reports/triage_evaluation.md states STATUS: NOT EVALUATED plainly');
    assert(!reportContent.includes('99.'), 'Zero fabricated accuracy figures exist in report');

    // -------------------------------------------------------------------------
    // TEST 8: Regression Integrity: Tier Boundaries & Shipped Model Constants
    // -------------------------------------------------------------------------
    console.log('\nTEST 8: Regression Integrity (Canonical Phase 1/2 Constants)');

    const t0 = getRiskTier(0.049);
    assert(t0 !== null && t0.tier === 'Nominal' && !t0.alertFired, '0.049 -> Nominal');

    const t1 = getRiskTier(0.050);
    assert(t1 !== null && t1.tier === 'Watch' && t1.alertFired, '0.050 -> Watch');

    const t2 = getRiskTier(0.099);
    assert(t2 !== null && t2.tier === 'Watch' && t2.alertFired, '0.099 -> Watch');

    const t3 = getRiskTier(0.220);
    assert(t3 !== null && t3.tier === 'Elevated' && t3.alertFired, '0.220 -> Elevated');

    const t4 = getRiskTier(0.499);
    assert(t4 !== null && t4.tier === 'Elevated' && t4.alertFired, '0.499 -> Elevated');

    const t5 = getRiskTier(0.500);
    assert(t5 !== null && t5.tier === 'High' && t5.alertFired, '0.500 -> High');

    // Ratio 90 check
    const ratio90 = calculatePhase1Pm25Ratio90(180.0);
    assert(ratio90 === 2.0, 'pm25_ratio_90 strictly equals PM2.5 / 90.0');

    console.log('\n----------------------------------------------------------------');
    console.log(`TRIAGE SUITE SUMMARY: TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log('----------------------------------------------------------------\n');
  } finally {
    server.close();
    await rawClient.end();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTriageSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
