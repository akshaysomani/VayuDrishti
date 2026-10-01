/**
 * HTTP-Level Integration Test Suite for Citizen Photo Reports
 * ==========================================================
 * Spins up the real HTTP handler (handleCitizenReportsRequest) and executes
 * full HTTP network requests against an ephemeral server port.
 *
 * Verifies:
 * 1. PENDING reports never returned by public GET /api/reports
 * 2. Non-approved images return 404 to the public; 200 to authenticated moderator
 * 3. Moderation endpoints reject missing, wrong, and empty tokens
 * 4. APPROVE transition makes report and image publicly visible
 * 5. REJECT transition hides report and image from public view
 * 6. Oversized upload returns 413 and leaves zero orphaned files on disk
 * 7. Fake JPEG and SVG payloads are rejected with 400
 * 8. Honeypot submissions are rejected with 400
 * 9. Rate limit enforces 5-request cap and returns 429 on 6th request
 */

import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { handleCitizenReportsRequest } from '../src/server/citizenReportsHandler';
import { setCitizenReportStore, PostgresCitizenReportStore } from '../src/server/storage/reportStore';
import { DiskImageStorage } from '../src/server/storage/imageStorage';
import { prepareTestDatabase, truncateTestDatabase } from '../src/server/db/testDbHelper';

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadLocalEnv();

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

// Build multipart/form-data payload manually for full control over stream limits and boundary headers
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

async function runHttpIntegrationSuite() {
  console.log('================================================================');
  console.log('HTTP INTEGRATION TEST SUITE: CITIZEN PHOTO REPORTS');
  console.log('================================================================\n');

  // Verify moderator token is configured
  const modToken = process.env.CITIZEN_REPORTS_MODERATOR_TOKEN;
  if (!modToken) {
    console.error('CITIZEN_REPORTS_MODERATOR_TOKEN is missing in .env');
    process.exit(1);
  }

  // Prepare test database: strictly validates TEST_DATABASE_URL (no fallback to DATABASE_URL),
  // verifies DB ends in "_test" and != dev DB, executes migrations, and truncates tables.
  process.env.NODE_ENV = 'test';
  const { testDbUrl, testDbName } = await prepareTestDatabase();
  console.log(`Connecting HTTP integration suite strictly to isolated test database: "${testDbName}"\n`);

  // Explicitly inject store pointing to test database
  setCitizenReportStore(new PostgresCitizenReportStore(testDbUrl));

  // Ensure trust proxy is enabled for test IP simulation
  process.env.TRUST_PROXY = 'true';

  const uploadsDir = path.join(process.cwd(), 'src', 'data', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // 1. Spin up ephemeral HTTP server
  const server = http.createServer(async (req, res) => {
    try {
      await handleCitizenReportsRequest(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Test HTTP server listening on ephemeral port ${address.port}\n`);

  // Generate authentic test JPEG with unique entropy per run to avoid 24h duplicate-hash rejection
  const runRand = Math.floor(Math.random() * 100);
  const testJpegBuffer = await sharp({
    create: {
      width: 80 + (runRand % 20),
      height: 80 + (runRand % 15),
      channels: 3,
      background: {
        r: Math.floor(Math.random() * 200) + 20,
        g: Math.floor(Math.random() * 200) + 20,
        b: Math.floor(Math.random() * 200) + 20,
      },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Submit Report (starts as PENDING) and verify public isolation
    // -------------------------------------------------------------------------
    console.log('TEST 1: Report Submission & Public PENDING Isolation');

    const sub1 = buildMultipartBody(
      {
        category: 'smoke',
        description: 'Dense smoke near factory & power grid',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'smoke_test.jpg',
        contentType: 'image/jpeg',
        buffer: testJpegBuffer,
      }
    );

    const postRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${sub1.boundary}`,
        'X-Forwarded-For': '10.0.0.1',
      },
      body: sub1.buffer,
    });

    assert(postRes.status === 201, `Report submission succeeded with 201 Created (got ${postRes.status})`);
    const postBody = await postRes.json();
    assert(postBody.success === true, 'Submission response indicates success');
    assert(postBody.status === 'PENDING', 'New report initializes strictly to PENDING');
    const reportId = postBody.report_id;

    // Fetch from moderator endpoint to get image_key
    const modInitialRes = await fetch(`${baseUrl}/api/reports/moderation/list?status=PENDING`, {
      headers: { 'x-moderator-token': modToken },
    });
    const modInitialData = await modInitialRes.json();
    const reportRecord = modInitialData.reports.find((r: any) => r.id === reportId);
    assert(Boolean(reportRecord), 'Submitted report is immediately visible in moderator queue');
    const imageKey = reportRecord.image_key;

    // Verify public GET /api/reports does NOT return the pending report
    const publicListRes = await fetch(`${baseUrl}/api/reports`);
    assert(publicListRes.status === 200, 'Public GET /api/reports returns 200 OK');
    const publicList = await publicListRes.json();
    const foundInPublic = publicList.reports.some((r: any) => r.id === reportId);
    assert(!foundInPublic, 'PENDING report is strictly excluded from public reports list');

    // -------------------------------------------------------------------------
    // TEST 2: Gated Image Serving for Non-Approved Reports
    // -------------------------------------------------------------------------
    console.log('\nTEST 2: Gated Image Serving for Non-Approved Reports');

    // Public / unauthenticated request to PENDING image -> 404
    const anonImgRes = await fetch(`${baseUrl}/api/reports/images/${imageKey}`);
    assert(
      anonImgRes.status === 404,
      `Unauthenticated access to PENDING image returns 404 Not Found (got ${anonImgRes.status})`
    );

    // Authenticated moderator request to PENDING image -> 200 OK
    const modImgRes = await fetch(`${baseUrl}/api/reports/images/${imageKey}`, {
      headers: {
        'x-moderator-token': modToken,
      },
    });
    assert(
      modImgRes.status === 200,
      `Authenticated moderator access to PENDING image returns 200 OK (got ${modImgRes.status})`
    );
    assert(
      modImgRes.headers.get('content-type')?.includes('image/jpeg') ?? false,
      'Image served with Content-Type image/jpeg'
    );
    assert(
      modImgRes.headers.get('x-content-type-options') === 'nosniff',
      'Image served with nosniff header'
    );

    // -------------------------------------------------------------------------
    // TEST 3: Moderation Endpoint Authentication Hygiene
    // -------------------------------------------------------------------------
    console.log('\nTEST 3: Moderation Endpoint Token Verification');

    // Missing token
    const noTokenRes = await fetch(`${baseUrl}/api/reports/moderation/list`);
    assert(noTokenRes.status === 401, `Missing token returns 401 Unauthorized (got ${noTokenRes.status})`);

    // Empty token
    const emptyTokenRes = await fetch(`${baseUrl}/api/reports/moderation/list`, {
      headers: { Authorization: 'Bearer ' },
    });
    assert(emptyTokenRes.status === 401, `Empty token returns 401 Unauthorized (got ${emptyTokenRes.status})`);

    // Wrong token
    const wrongTokenRes = await fetch(`${baseUrl}/api/reports/moderation/list`, {
      headers: { 'x-moderator-token': 'wrong-unauthorized-token-xyz' },
    });
    assert(wrongTokenRes.status === 401, `Invalid token returns 401 Unauthorized (got ${wrongTokenRes.status})`);

    // Valid token
    const validModRes = await fetch(`${baseUrl}/api/reports/moderation/list?status=PENDING`, {
      headers: { 'x-moderator-token': modToken },
    });
    assert(validModRes.status === 200, `Valid token returns 200 OK (got ${validModRes.status})`);
    const modData = await validModRes.json();
    assert(
      modData.reports.some((r: any) => r.id === reportId),
      'Pending report is visible in moderator queue'
    );

    // -------------------------------------------------------------------------
    // TEST 4: Approve Transition -> Public Visibility
    // -------------------------------------------------------------------------
    console.log('\nTEST 4: State Transition: APPROVE -> Public Visibility');

    const approveRes = await fetch(`${baseUrl}/api/reports/moderation/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${modToken}`,
      },
      body: JSON.stringify({
        report_id: reportId,
        action: 'APPROVE',
      }),
    });
    assert(approveRes.status === 200, `Moderator approve returns 200 OK (got ${approveRes.status})`);
    const approveBody = await approveRes.json();
    assert(approveBody.report.status === 'APPROVED', 'Report status successfully changed to APPROVED');

    // Public list query now includes the report
    const publicListAfterApprove = await fetch(`${baseUrl}/api/reports`);
    const approvedPubData = await publicListAfterApprove.json();
    const approvedItem = approvedPubData.reports.find((r: any) => r.id === reportId);
    assert(Boolean(approvedItem), 'APPROVED report is now returned by public GET /api/reports');
    assert(
      approvedItem?.disclaimer?.includes('unverified') ?? false,
      'Public report carries non-predictive disclaimer'
    );

    // Public image request now returns 200 without moderator credentials
    const anonImgAfterApprove = await fetch(`${baseUrl}/api/reports/images/${imageKey}`);
    assert(
      anonImgAfterApprove.status === 200,
      `APPROVED image is publicly servable with 200 OK (got ${anonImgAfterApprove.status})`
    );
    assert(
      anonImgAfterApprove.headers.get('cache-control')?.includes('public') ?? false,
      'APPROVED image served with public Cache-Control'
    );

    // -------------------------------------------------------------------------
    // TEST 5: State Transition: REJECT -> Hidden
    // -------------------------------------------------------------------------
    console.log('\nTEST 5: State Transition: REJECT -> Hiding from Public');

    const rejectRes = await fetch(`${baseUrl}/api/reports/moderation/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${modToken}`,
      },
      body: JSON.stringify({
        report_id: reportId,
        action: 'REJECT',
        reason: 'Duplicate observation submitted.',
      }),
    });
    assert(rejectRes.status === 200, `Moderator reject returns 200 OK (got ${rejectRes.status})`);
    const rejectBody = await rejectRes.json();
    assert(rejectBody.report.status === 'REJECTED', 'Report status updated to REJECTED');

    // Public list no longer includes the rejected report
    const publicListAfterReject = await fetch(`${baseUrl}/api/reports`);
    const rejectedPubData = await publicListAfterReject.json();
    assert(
      !rejectedPubData.reports.some((r: any) => r.id === reportId),
      'REJECTED report is immediately hidden from public GET /api/reports'
    );

    // Public image request returns 404 again
    const anonImgAfterReject = await fetch(`${baseUrl}/api/reports/images/${imageKey}`);
    assert(
      anonImgAfterReject.status === 404,
      `REJECTED image returns 404 to unauthenticated clients (got ${anonImgAfterReject.status})`
    );

    // Moderator can still view REJECTED image
    const modImgAfterReject = await fetch(`${baseUrl}/api/reports/images/${imageKey}`, {
      headers: { Authorization: `Bearer ${modToken}` },
    });
    assert(
      modImgAfterReject.status === 200,
      `Moderator can still inspect REJECTED image with 200 OK (got ${modImgAfterReject.status})`
    );

    // -------------------------------------------------------------------------
    // TEST 6: Oversized Upload Returns 413 and Leaves Zero Files
    // -------------------------------------------------------------------------
    console.log('\nTEST 6: Oversized Upload (413 Payload Too Large) & File Cleanup');

    const filesBefore = new Set(fs.readdirSync(uploadsDir));

    // Create 6MB payload (limit is 5MB)
    const largeBuffer = Buffer.alloc(6 * 1024 * 1024, 0xaa);
    const oversizedMultipart = buildMultipartBody(
      {
        category: 'dust',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'oversized.jpg',
        contentType: 'image/jpeg',
        buffer: largeBuffer,
      }
    );

    const overRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${oversizedMultipart.boundary}`,
        'X-Forwarded-For': '10.0.0.2',
      },
      body: oversizedMultipart.buffer,
    });

    assert(overRes.status === 413, `Oversized upload rejected with 413 Payload Too Large (got ${overRes.status})`);
    const filesAfter = new Set(fs.readdirSync(uploadsDir));
    const newFiles = [...filesAfter].filter((f) => !filesBefore.has(f));
    assert(newFiles.length === 0, `Zero orphaned files left on disk after 413 rejection (found: ${newFiles.length})`);

    // -------------------------------------------------------------------------
    // TEST 7: Fake-JPEG and SVG Rejection
    // -------------------------------------------------------------------------
    console.log('\nTEST 7: Fake JPEG and SVG Rejection');

    // 7a: Plain text with .jpg extension
    const fakeJpg = buildMultipartBody(
      {
        category: 'burning',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'fake.jpg',
        contentType: 'image/jpeg',
        buffer: Buffer.from('GIF89a this is actually plaintext and not an image at all'),
      }
    );

    const fakeJpgRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${fakeJpg.boundary}`,
        'X-Forwarded-For': '10.0.0.3',
      },
      body: fakeJpg.buffer,
    });
    assert(fakeJpgRes.status === 400, `Fake JPEG rejected with 400 Bad Request (got ${fakeJpgRes.status})`);

    // 7b: SVG upload
    const svgMultipart = buildMultipartBody(
      {
        category: 'industrial_emission',
        lat: '28.6139',
        lon: '77.2090',
      },
      {
        fieldName: 'photo',
        filename: 'payload.svg',
        contentType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      }
    );

    const svgRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${svgMultipart.boundary}`,
        'X-Forwarded-For': '10.0.0.4',
      },
      body: svgMultipart.buffer,
    });
    assert(svgRes.status === 400, `SVG upload rejected with 400 Bad Request (got ${svgRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 8: Honeypot Defense
    // -------------------------------------------------------------------------
    console.log('\nTEST 8: Honeypot Defense');

    const honeyMultipart = buildMultipartBody(
      {
        category: 'smoke',
        lat: '28.6139',
        lon: '77.2090',
        honeypot: 'automated_spam_bot_filling_every_field',
      },
      {
        fieldName: 'photo',
        filename: 'honey.jpg',
        contentType: 'image/jpeg',
        buffer: testJpegBuffer,
      }
    );

    const honeyRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${honeyMultipart.boundary}`,
        'X-Forwarded-For': '10.0.0.5',
      },
      body: honeyMultipart.buffer,
    });
    assert(honeyRes.status === 400, `Honeypot submission rejected with 400 (got ${honeyRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 9: Rate Limiting (429 on 6th request from same IP)
    // -------------------------------------------------------------------------
    console.log('\nTEST 9: IP Rate Limiting (5 allowed, 6th returns 429)');

    const spamIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
    const spamSeed = Math.floor(Math.random() * 10000);
    let hit429 = false;
    let retryAfterHeader: string | null = null;

    for (let i = 1; i <= 6; i++) {
      // Create a slightly distinct image each time to pass duplicate hash check
      const uniqueBuf = await sharp({
        create: {
          width: 50 + (spamSeed % 50) + i,
          height: 50 + (spamSeed % 50) + i,
          channels: 3,
          background: {
            r: (15 * i + spamSeed) % 250,
            g: (25 * i + spamSeed) % 250,
            b: (35 * i + spamSeed) % 250,
          },
        },
      })
        .jpeg()
        .toBuffer();

      const ratePayload = buildMultipartBody(
        {
          category: 'other',
          description: `Rate limit check attempt ${i}`,
          lat: '28.6139',
          lon: '77.2090',
        },
        {
          fieldName: 'photo',
          filename: `attempt_${i}.jpg`,
          contentType: 'image/jpeg',
          buffer: uniqueBuf,
        }
      );

      const r = await fetch(`${baseUrl}/api/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${ratePayload.boundary}`,
          'X-Forwarded-For': spamIp,
        },
        body: ratePayload.buffer,
      });

      if (i <= 5) {
        assert(r.status === 201, `Request ${i}/5 allowed (status ${r.status})`);
      } else {
        hit429 = r.status === 429;
        retryAfterHeader = r.headers.get('retry-after');
        assert(hit429, `6th request within window returned 429 Too Many Requests (got ${r.status})`);
        assert(
          Boolean(retryAfterHeader && parseInt(retryAfterHeader, 10) > 0),
          `429 response contains Retry-After header: ${retryAfterHeader} seconds`
        );
      }
    }

    // -------------------------------------------------------------------------
    // TEST 10: Retention Pruning Endpoint (POST /api/reports/moderation/cleanup)
    // -------------------------------------------------------------------------
    console.log('\nTEST 10: Retention Pruning Endpoint');

    const cleanupRes = await fetch(`${baseUrl}/api/reports/moderation/cleanup?days=0`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${modToken}`,
      },
    });
    assert(cleanupRes.status === 200, `Cleanup endpoint returns 200 OK (got ${cleanupRes.status})`);
    const cleanupBody = await cleanupRes.json();
    assert(cleanupBody.success === true, 'Retention cleanup reports success');
    assert(typeof cleanupBody.deleted_reports_count === 'number', 'Cleanup returned deleted count');
  } finally {
    try {
      await truncateTestDatabase(testDbUrl);
    } catch {}
    server.close();
  }

  console.log('\n----------------------------------------------------------------');
  console.log(`HTTP INTEGRATION SUITE: TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('----------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runHttpIntegrationSuite().catch((err) => {
  console.error('Fatal HTTP integration suite error:', err);
  process.exit(1);
});
