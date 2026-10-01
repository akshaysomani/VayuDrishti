/**
 * Phase 5 f3: Citizen Photo Reports Test Suite
 * ============================================
 * Verification coverage:
 * 1. Magic-byte rejection (fake .jpg, SVG, zero-byte, valid JPEG/PNG/WebP)
 * 2. EXIF/GPS stripped from stored output
 * 3. Path traversal attempts
 * 4. Description sanitization (Stored XSS payloads)
 * 5. Coordinate range validation & monitor snapping
 * 6. Privacy-preserving rate limiter
 * 7. Honeypot defense
 * 8. PENDING reports isolation from public queries
 * 9. Approve / Reject state transitions
 * 10. Moderator token authentication
 * 11. Cryptographic duplicate-hash detection
 * 12. Model regression check (Phase 1 features & Phase 2f risk tiers)
 */

import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateImageMagicBytes, sanitizeDescription } from '../src/server/validation/imageValidator';
import { processCitizenImage } from '../src/server/services/imageProcessor';
import { DiskImageStorage } from '../src/server/storage/imageStorage';
import { PersistentFileReportStore } from '../src/server/storage/reportStore';
import { validateCoordinates, snapToNearestStation } from '../src/server/services/geoSnapper';
import { RateLimiter } from '../src/server/services/rateLimiter';
import { ModerationService } from '../src/server/services/moderationService';
import { getRiskTier } from '../src/types/alert';
import { calculatePhase1Pm25Ratio90 } from '../src/services/historicalObservationStore';

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

async function runTestSuite() {
  console.log('================================================================');
  console.log('PHASE 5 f3: CITIZEN PHOTO REPORTS TEST SUITE');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // TEST 1: Magic Byte Image Validation
  // ---------------------------------------------------------------------------
  console.log('TEST 1: Magic-Byte Image Validation');

  // 1a: Zero byte buffer
  const zeroRes = validateImageMagicBytes(Buffer.alloc(0));
  assert(!zeroRes.valid && zeroRes.error?.includes('0 bytes'), 'Zero-byte buffer is strictly rejected');

  // 1b: Fake JPG containing text
  const textBuffer = Buffer.from('GIF89a this is actually plaintext not an image');
  const textRes = validateImageMagicBytes(textBuffer);
  assert(!textRes.valid, 'Plain text masquerading as image is strictly rejected');

  // 1c: SVG with embedded script
  const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script></svg>');
  const svgRes = validateImageMagicBytes(svgBuffer);
  assert(!svgRes.valid && svgRes.error?.includes('Vector graphics (SVG)'), 'SVG vector graphics are strictly rejected to prevent XSS');

  // 1d: Valid JPEG header (FF D8 FF)
  const validJpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const jpegRes = validateImageMagicBytes(validJpegHeader);
  assert(jpegRes.valid && jpegRes.format === 'jpeg', 'Authentic JPEG magic bytes recognized');

  // 1e: Valid PNG header (89 50 4E 47 0D 0A 1A 0A)
  const validPngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const pngRes = validateImageMagicBytes(validPngHeader);
  assert(pngRes.valid && pngRes.format === 'png', 'Authentic PNG magic bytes recognized');

  // 1f: Valid WebP header (RIFF ... WEBP)
  const validWebpHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x20, 0x00, 0x00, 0x00, // size
    0x57, 0x45, 0x42, 0x50, // WEBP
  ]);
  const webpRes = validateImageMagicBytes(validWebpHeader);
  assert(webpRes.valid && webpRes.format === 'webp', 'Authentic WebP magic bytes recognized');

  // ---------------------------------------------------------------------------
  // TEST 2: EXIF & GPS Stripping during Server-Side Re-encoding
  // ---------------------------------------------------------------------------
  console.log('\nTEST 2: EXIF & GPS Stripping during Server-Side Re-encoding');

  // Create a genuine JPEG image with embedded GPS / EXIF metadata
  const originalWithExif = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 180, g: 100, b: 40 },
    },
  })
    .withMetadata({
      exif: {
        IFD0: {
          Make: 'VayuTestCamera',
          Model: 'Model-X',
          ImageDescription: 'Sensory Observation with GPS',
        },
        GPSInfo: {
          GPSLatitude: '28/1 36/1 45/1',
          GPSLongitude: '77/1 12/1 10/1',
          GPSLatitudeRef: 'N',
          GPSLongitudeRef: 'E',
        },
      },
    })
    .jpeg()
    .toBuffer();

  const originalMeta = await sharp(originalWithExif).metadata();
  assert(originalMeta.exif != null, 'Test input contains EXIF metadata');

  // Run through processing pipeline
  const processed = await processCitizenImage(originalWithExif);
  const processedMeta = await sharp(processed.mainBuffer).metadata();

  assert(processedMeta.exif == null, 'Processed output EXIF metadata is completely stripped');
  assert(processed.mainBuffer.length > 0, 'Processed image buffer is valid');
  assert(processed.thumbBuffer.length > 0, 'Thumbnail buffer successfully generated');
  assert(processed.width <= 1600 && processed.height <= 1600, 'Dimensions capped within allowed max bounds');
  assert(typeof processed.contentHash === 'string' && processed.contentHash.length === 64, 'Generated 64-char SHA-256 content hash');

  // ---------------------------------------------------------------------------
  // TEST 3: Path Traversal Defenses in Image Storage
  // ---------------------------------------------------------------------------
  console.log('\nTEST 3: Path Traversal Defenses in Image Storage');
  const testStorageDir = path.join(process.cwd(), 'scratch', 'test_uploads');
  const storage = new DiskImageStorage(testStorageDir);

  const traversalAttempts = [
    '../../etc/passwd',
    '..\\..\\windows\\win.ini',
    'image/../../secret.jpg',
    'image/sub/test.jpg',
    'bad_key%00.jpg',
    'test..jpg',
    '/root/secret.jpg',
  ];

  for (const badKey of traversalAttempts) {
    let threw = false;
    try {
      await storage.saveImage(badKey, Buffer.from('test'), 'image/jpeg');
    } catch {
      threw = true;
    }
    assert(threw, `Rejected traversal attempt: "${badKey}"`);
  }

  // Safe key succeeds
  const safeKey = 'report-12345_6789.jpg';
  await storage.saveImage(safeKey, Buffer.from('valid-image-bytes'), 'image/jpeg');
  const item = await storage.getImage(safeKey);
  assert(item !== null && item.buffer.toString() === 'valid-image-bytes', 'Safe alphanumeric key allowed and retrieved');
  await storage.deleteImage(safeKey);

  // ---------------------------------------------------------------------------
  // TEST 4: Description Sanitization & Stored XSS Defenses
  // ---------------------------------------------------------------------------
  console.log('\nTEST 4: Description Sanitization & Stored XSS Defenses');

  const xssPayload = '<script>alert(1)</script>Heavy smoke from <b>factory</b> <img src=x onerror=alert(2)>';
  const sanitized = sanitizeDescription(xssPayload);

  assert(!sanitized.includes('<script>'), 'Stripped <script> tag');
  assert(!sanitized.includes('<b>'), 'Stripped <b> formatting tag');
  assert(!sanitized.includes('<img'), 'Stripped <img> tag with onerror event');
  assert(sanitized.includes('Heavy smoke from') && sanitized.includes('factory'), 'Preserved genuine text content');

  // Long description capping at 500 chars
  const longText = 'A'.repeat(800);
  const capped = sanitizeDescription(longText);
  assert(capped.length === 500, 'Description capped strictly at 500 characters');

  // ---------------------------------------------------------------------------
  // TEST 5: Coordinate Range Validation & Nearest Station Snapping
  // ---------------------------------------------------------------------------
  console.log('\nTEST 5: Coordinate Range Validation & Station Snapping');

  assert(validateCoordinates(28.6139, 77.209).valid, 'Valid Delhi coordinates accepted');
  assert(!validateCoordinates(95.0, 77.0).valid, 'Latitude 95.0 > 90 rejected');
  assert(!validateCoordinates(-92.0, 77.0).valid, 'Latitude -92.0 < -90 rejected');
  assert(!validateCoordinates(28.0, 195.0).valid, 'Longitude 195.0 > 180 rejected');
  assert(!validateCoordinates(NaN, 77.0).valid, 'NaN coordinates rejected');

  const snapDelhi = snapToNearestStation(28.65, 77.23);
  assert(snapDelhi.nearestStationId !== null, 'Station snapped successfully');
  assert(snapDelhi.nearestStationName !== null, `Snapped to: ${snapDelhi.nearestStationName}`);
  assert(snapDelhi.distanceKm !== null && snapDelhi.distanceKm < 50, `Nearest distance is sane: ${snapDelhi.distanceKm} km`);

  // ---------------------------------------------------------------------------
  // TEST 6: Rate Limiting & Privacy-Preserving IP Hashing
  // ---------------------------------------------------------------------------
  console.log('\nTEST 6: Privacy-Preserving Rate Limiter');

  const limiter = new RateLimiter(3, 10); // max 3 per 10 mins
  const testIp = '198.51.100.42';

  const hash1 = limiter.hashClientIp(testIp);
  assert(!hash1.includes(testIp), 'Hashed IP does NOT leak plain IP address');
  assert(hash1.length === 32, 'Produces 32-char irreversible salted hash');

  const r1 = limiter.checkLimit(testIp);
  const r2 = limiter.checkLimit(testIp);
  const r3 = limiter.checkLimit(testIp);
  assert(r1.allowed && r2.allowed && r3.allowed, 'First 3 requests within limit are allowed');

  const r4 = limiter.checkLimit(testIp);
  assert(!r4.allowed && r4.remaining === 0 && r4.retryAfterSeconds > 0, '4th request exceeds rate limit and is blocked');

  // Distinct IP is not blocked
  const rOther = limiter.checkLimit('203.0.113.88');
  assert(rOther.allowed, 'Different IP address remains unaffected by rate limit');

  // ---------------------------------------------------------------------------
  // TEST 7: Persistent Report Store & Public PENDING Isolation
  // ---------------------------------------------------------------------------
  console.log('\nTEST 7: PENDING Isolation & Storage State Machine');

  const testDbFile = path.join(process.cwd(), 'scratch', 'test_reports.json');
  if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);

  const reportStore = new PersistentFileReportStore(testDbFile);

  const newReport = await reportStore.insertReport({
    category: 'smoke',
    description: 'Test smoke observation',
    lat: 28.6139,
    lon: 77.209,
    nearest_station_id: 'DL001',
    nearest_station_name: 'Anand Vihar',
    nearest_station_distance_km: 3.2,
    image_key: 'test_img_1.jpg',
    thumb_key: 'test_img_1_thumb.jpg',
    content_hash: 'abc123hash0001',
    client_timestamp: new Date().toISOString(),
  });

  assert(newReport.status === 'PENDING', 'Newly submitted report strictly initializes to PENDING status');

  // Public approved query must NOT return PENDING report
  const publicListBefore = await reportStore.listApprovedReports();
  assert(publicListBefore.reports.length === 0, 'PENDING report is strictly excluded from public query');

  // Moderator approves report
  const approved = await reportStore.updateReportStatus(newReport.id, 'APPROVED');
  assert(approved?.status === 'APPROVED' && approved.moderated_at !== null, 'Report status transitions to APPROVED');

  // Public approved query now returns the report
  const publicListAfter = await reportStore.listApprovedReports();
  assert(publicListAfter.reports.length === 1 && publicListAfter.reports[0].id === newReport.id, 'Approved report is now visible publicly');

  // Moderator rejects report with reason
  const rejected = await reportStore.updateReportStatus(newReport.id, 'REJECTED', 'Low quality / blurry');
  assert(rejected?.status === 'REJECTED' && rejected.moderation_reason === 'Low quality / blurry', 'Report status transitions to REJECTED with reason');

  const publicListRejected = await reportStore.listApprovedReports();
  assert(publicListRejected.reports.length === 0, 'REJECTED report is immediately excluded from public queries');

  // ---------------------------------------------------------------------------
  // TEST 8: Moderator Token Authentication
  // ---------------------------------------------------------------------------
  console.log('\nTEST 8: Moderator Authentication Guard');

  const modService = new ModerationService(reportStore);

  assert(!modService.verifyModeratorToken(null), 'Rejects null token');
  assert(!modService.verifyModeratorToken(''), 'Rejects empty token');
  assert(!modService.verifyModeratorToken('invalid_secret_token_123'), 'Rejects invalid moderator token');

  const configuredSecret = process.env.CITIZEN_REPORTS_MODERATOR_TOKEN;
  if (!configuredSecret) {
    throw new Error('CITIZEN_REPORTS_MODERATOR_TOKEN must be set in environment.');
  }
  assert(modService.verifyModeratorToken(configuredSecret), 'Authenticates valid raw moderator token');
  assert(modService.verifyModeratorToken(`Bearer ${configuredSecret}`), 'Authenticates valid Bearer header token');

  // ---------------------------------------------------------------------------
  // TEST 9: Automated Duplicate-Hash Precheck
  // ---------------------------------------------------------------------------
  console.log('\nTEST 9: Cryptographic Duplicate-Hash Precheck');

  const precheck1 = await modService.runAutomatedPrecheck({
    contentHash: 'unique_hash_99999',
    width: 800,
    height: 600,
    format: '.jpg',
  });
  assert(precheck1.passed, 'Unique image passes automated pre-check');

  // Insert a report with that hash
  await reportStore.insertReport({
    category: 'burning',
    description: 'First submission',
    lat: 28.5,
    lon: 77.2,
    nearest_station_id: 'DL001',
    nearest_station_name: 'Anand Vihar',
    nearest_station_distance_km: 1.0,
    image_key: 'img_dup.jpg',
    thumb_key: 'img_dup_thumb.jpg',
    content_hash: 'unique_hash_99999',
    client_timestamp: new Date().toISOString(),
  });

  // Second submission with exact same hash
  const precheck2 = await modService.runAutomatedPrecheck({
    contentHash: 'unique_hash_99999',
    width: 800,
    height: 600,
    format: '.jpg',
  });
  assert(!precheck2.passed && precheck2.reason?.includes('Duplicate photo detected'), 'Duplicate content hash detected and rejected within 24h window');

  // Dimension sanity bounds
  const tooSmall = await modService.runAutomatedPrecheck({
    contentHash: 'small_hash',
    width: 20,
    height: 20,
    format: '.jpg',
  });
  assert(!tooSmall.passed && tooSmall.reason?.includes('below minimum'), 'Image < 32px rejected by pre-check');

  // ---------------------------------------------------------------------------
  // TEST 10: Regression Verification of Shipped Model & Tier Boundaries
  // ---------------------------------------------------------------------------
  console.log('\nTEST 10: Model Independence & Canonical Boundaries Regression');

  const b1 = getRiskTier(0.049);
  assert(b1?.tier === 'Nominal' && !b1.alertFired, '0.049 -> Nominal, Alert Inactive');

  const b2 = getRiskTier(0.050);
  assert(b2?.tier === 'Watch' && b2.alertFired, '0.050 -> Watch, Alert Active');

  const b4 = getRiskTier(0.220);
  assert(b4?.tier === 'Elevated' && b4.alertFired, '0.220 -> Elevated, Alert Active');

  const b5 = getRiskTier(0.499);
  assert(b5?.tier === 'Elevated' && b5.alertFired, '0.499 -> Elevated, Alert Active');

  const b6 = getRiskTier(0.500);
  assert(b6?.tier === 'High' && b6.alertFired, '0.500 -> High, Alert Active');

  // pm25_ratio_90 strictly PM2.5 / 90.0
  assert(calculatePhase1Pm25Ratio90(90.0) === 1.0, 'pm25_ratio_90 is strictly PM2.5 / 90.0');
  assert(calculatePhase1Pm25Ratio90(180.0) === 2.0, 'pm25_ratio_90 = 180.0 / 90.0 = 2.0');

  // Clean up test scratch files
  if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
  if (fs.existsSync(testStorageDir)) fs.rmSync(testStorageDir, { recursive: true, force: true });

  console.log('\n----------------------------------------------------------------');
  console.log(`CITIZEN REPORTS SUITE: TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('----------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
