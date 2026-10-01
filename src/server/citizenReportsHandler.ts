/**
 * Citizen Photo Reports Server-Side API Handler
 * =============================================
 * Handles:
 * 1. POST /api/reports               - Multipart submission with validation, re-encoding & automated pre-checks.
 * 2. GET  /api/reports               - Public query for APPROVED reports only.
 * 3. GET  /api/reports/images/:key   - Controlled image serving with nosniff & caching headers.
 * 4. GET  /api/reports/moderation/list   - Moderator review queue (token protected).
 * 5. POST /api/reports/moderation/review - Moderator review action (token protected).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { getImageStorage } from './storage/imageStorage';
import { getCitizenReportStore } from './storage/reportStore';
import { processCitizenImage } from './services/imageProcessor';
import { validateCoordinates, snapToNearestStation } from './services/geoSnapper';
import { sanitizeDescription } from './validation/imageValidator';
import { getGlobalRateLimiter } from './services/rateLimiter';
import { ModerationService } from './services/moderationService';
import { getReportTriageStore } from './storage/triageStore';
import { getGlobalStationHistoryStore } from './persistentStore';
import { LIVE_ALERT_STALE_HOURS } from '../types/liveAlert';
import type {
  CitizenReportCategory,
  PublicCitizenReport,
  CitizenReportRecord,
} from '../types/citizenReport';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB default limit
const ALLOWED_CATEGORIES: CitizenReportCategory[] = [
  'smoke',
  'dust',
  'burning',
  'industrial_emission',
  'construction_dust',
  'other',
];

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

function getClientIp(req: IncomingMessage): string {
  // Only trust X-Forwarded-For if explicitly configured via TRUST_PROXY
  const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function toPublicReport(record: CitizenReportRecord): PublicCitizenReport {
  return {
    id: record.id,
    category: record.category,
    description: record.description,
    lat: record.lat,
    lon: record.lon,
    nearest_station_id: record.nearest_station_id,
    nearest_station_name: record.nearest_station_name,
    nearest_station_distance_km: record.nearest_station_distance_km,
    image_url: `/api/reports/images/${record.image_key}`,
    thumb_url: `/api/reports/images/${record.thumb_key}`,
    created_at: record.created_at,
    is_verified: false,
    disclaimer: 'Citizen unverified observation. Not used in predictive risk models.',
  };
}

export function getModelEvaluationStatus(): {
  is_evaluated: boolean;
  status: string;
  report_path: string;
} {
  try {
    const reportPath = path.resolve(process.cwd(), 'reports', 'triage_evaluation.md');
    if (fs.existsSync(reportPath)) {
      const content = fs.readFileSync(reportPath, 'utf8');
      if (content.includes('STATUS: EVALUATED') || (content.includes('EVALUATED') && !content.includes('NOT EVALUATED'))) {
        return { is_evaluated: true, status: 'EVALUATED', report_path: 'reports/triage_evaluation.md' };
      }
    }
  } catch {
    // Non-fatal check
  }
  return { is_evaluated: false, status: 'NOT EVALUATED', report_path: 'reports/triage_evaluation.md' };
}

export async function handleCitizenReportsRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const host = req.headers.host ?? 'localhost:5173';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  const reportStore = getCitizenReportStore();
  const imageStorage = getImageStorage();
  const moderationService = new ModerationService(reportStore);
  const rateLimiter = getGlobalRateLimiter();

  try {
    // -------------------------------------------------------------------------
    // 1. GET /api/reports/images/:key - Serve controlled image/thumb
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/reports/images/')) {
      if (method !== 'GET') {
        sendError(res, 405, 'Method not allowed.');
        return;
      }

      const key = pathname.replace('/api/reports/images/', '').trim();
      if (!key) {
        sendError(res, 400, 'Image key is required.');
        return;
      }

      try {
        // Gating Check: Only images belonging to APPROVED reports are publicly served.
        // Images belonging to PENDING or REJECTED reports are served ONLY to authenticated moderators.
        const report = await reportStore.getReportByImageKey(key);
        if (!report) {
          sendError(res, 404, 'Image not found.');
          return;
        }

        const isApproved = report.status === 'APPROVED';
        if (!isApproved) {
          const authHeader = req.headers.authorization || (req.headers['x-moderator-token'] as string);
          if (!moderationService.verifyModeratorToken(authHeader)) {
            // Return 404 to unauthenticated clients so non-approved images remain completely hidden
            sendError(res, 404, 'Image not found.');
            return;
          }
        }

        const item = await imageStorage.getImage(key);
        if (!item) {
          sendError(res, 404, 'Image not found.');
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', item.mimeType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Cache-Control',
          isApproved ? 'public, max-age=86400, immutable' : 'private, no-cache'
        );
        res.end(item.buffer);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid image request.';
        sendError(res, 400, msg);
      }
      return;
    }

    // -------------------------------------------------------------------------
    // 2. MODERATOR ENDPOINTS
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/reports/moderation')) {
      if (!moderationService.isModerationConfigured()) {
        sendError(
          res,
          503,
          'Moderation service is unconfigured on server (missing CITIZEN_REPORTS_MODERATOR_TOKEN).'
        );
        return;
      }

      const authHeader = req.headers.authorization || (req.headers['x-moderator-token'] as string);
      if (!moderationService.verifyModeratorToken(authHeader)) {
        sendError(res, 401, 'Unauthorized: Valid moderator credentials required.');
        return;
      }

      // POST /api/reports/moderation/cleanup - Retention pruning for rejected reports
      if (pathname === '/api/reports/moderation/cleanup' && method === 'POST') {
        const daysParam = url.searchParams.get('days');
        const retentionDays = daysParam
          ? parseInt(daysParam, 10)
          : parseInt(process.env.REJECTED_REPORT_RETENTION_DAYS || '7', 10);

        const cleanupResult = await reportStore.cleanupRejectedReports(
          isNaN(retentionDays) ? 7 : retentionDays
        );
        for (const fileKey of cleanupResult.deletedKeys) {
          await imageStorage.deleteImage(fileKey).catch(() => {});
        }

        sendJson(res, 200, {
          success: true,
          deleted_reports_count: cleanupResult.deletedCount,
          deleted_files_count: cleanupResult.deletedKeys.length,
          retention_days: isNaN(retentionDays) ? 7 : retentionDays,
        });
        return;
      }

      // GET /api/reports/moderation/list
      if (pathname === '/api/reports/moderation/list' && method === 'GET') {
        const statusParam = (url.searchParams.get('status') ?? 'PENDING').toUpperCase();
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));

        let queryStatus: any = statusParam;
        if (statusParam === 'ALL') {
          queryStatus = undefined;
        }

        const result = await reportStore.listReports({
          status: queryStatus,
          limit,
          offset,
        });

        // Enrich moderation list with advisory triage and read-only station telemetry context
        const reportIds = result.reports.map((r) => r.id);
        const triageStore = getReportTriageStore();
        const triageMap = await triageStore.getTriageByReportIds(reportIds).catch(() => new Map());
        const historyStore = getGlobalStationHistoryStore();

        const enrichedReports = await Promise.all(
          result.reports.map(async (report) => {
            const triage = triageMap.get(report.id) ?? null;
            let station_context = null;

            if (report.nearest_station_id) {
              try {
                const observations = await historyStore.getStationObservations(report.nearest_station_id);
                if (observations && observations.length > 0) {
                  const latest = observations[observations.length - 1];
                  const obsTime = new Date(latest.observed_at).getTime();
                  const ageHours = (Date.now() - obsTime) / (3600 * 1000);
                  station_context = {
                    station_id: latest.station_id,
                    station_name: latest.station_name,
                    latest_pm25: latest.pm25,
                    observed_at: latest.observed_at,
                    is_stale: ageHours > LIVE_ALERT_STALE_HOURS,
                  };
                }
              } catch {
                // Non-fatal: station context is strictly optional background info
              }
            }

            return {
              ...report,
              triage,
              station_context,
            };
          })
        );

        sendJson(res, 200, {
          reports: enrichedReports,
          total: result.total,
          limit,
          offset,
          model_evaluation: getModelEvaluationStatus(),
        });
        return;
      }

      // POST /api/reports/moderation/review
      if (pathname === '/api/reports/moderation/review' && method === 'POST') {
        let bodyRaw = '';
        for await (const chunk of req) {
          bodyRaw += chunk;
        }

        let body: any;
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          sendError(res, 400, 'Invalid JSON payload.');
          return;
        }

        const { report_id, action, reason } = body;
        if (!report_id || (action !== 'APPROVE' && action !== 'REJECT')) {
          sendError(res, 400, 'Fields "report_id" and action ("APPROVE" | "REJECT") are required.');
          return;
        }

        const updated = await reportStore.updateReportStatus(
          report_id,
          action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          reason ? String(reason).slice(0, 255) : undefined
        );

        if (!updated) {
          sendError(res, 404, 'Report not found.');
          return;
        }

        sendJson(res, 200, {
          success: true,
          report: updated,
          message: `Report ${report_id} status updated to ${updated.status}.`,
        });
        return;
      }

      sendError(res, 404, 'Moderation endpoint not found.');
      return;
    }

    // -------------------------------------------------------------------------
    // 3. GET /api/reports - Public Query for APPROVED Reports
    // -------------------------------------------------------------------------
    if (pathname === '/api/reports' && method === 'GET') {
      const stationId = url.searchParams.get('stationId') || undefined;
      const bboxParam = url.searchParams.get('bbox');
      let bbox: [number, number, number, number] | undefined = undefined;

      if (bboxParam) {
        const parts = bboxParam.split(',').map((p) => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
          bbox = parts as [number, number, number, number];
        }
      }

      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));

      const result = await reportStore.listApprovedReports({
        stationId,
        bbox,
        limit,
        offset,
      });

      const publicReports = result.reports.map(toPublicReport);

      sendJson(res, 200, {
        reports: publicReports,
        total: result.total,
        limit,
        offset,
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 4. POST /api/reports - Citizen Photo Report Submission
    // -------------------------------------------------------------------------
    if (pathname === '/api/reports' && method === 'POST') {
      // Abuse Protection: Rate Limiting
      const clientIp = getClientIp(req);
      const rateCheck = rateLimiter.checkLimit(clientIp);
      if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
        sendError(
          res,
          429,
          `Rate limit exceeded. Please wait ${rateCheck.retryAfterSeconds} seconds before submitting another report.`
        );
        return;
      }

      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        sendError(res, 415, 'Request must be multipart/form-data.');
        return;
      }

      // Parse multipart form stream
      const fields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let fileTruncated = false;

      await new Promise<void>((resolve, reject) => {
        const bb = busboy({
          headers: req.headers,
          limits: {
            fileSize: MAX_FILE_SIZE_BYTES,
            files: 1,
            fields: 10,
          },
        });

        bb.on('field', (name, val) => {
          fields[name] = val;
        });

        bb.on('file', (_name, fileStream, _info) => {
          const chunks: Buffer[] = [];
          fileStream.on('data', (data: Buffer) => {
            chunks.push(data);
          });
          fileStream.on('limit', () => {
            fileTruncated = true;
          });
          fileStream.on('end', () => {
            fileBuffer = Buffer.concat(chunks);
          });
        });

        bb.on('error', (err) => reject(err));
        bb.on('finish', () => resolve());

        req.pipe(bb);
      });

      // 1. Abuse Check: Honeypot field
      if (fields.honeypot && fields.honeypot.trim() !== '') {
        // Honeypot triggered: drop silently or return 400
        sendError(res, 400, 'Invalid submission parameters.');
        return;
      }

      // 2. Check File Uploaded
      const uploadBytes = fileBuffer as Buffer | null;
      if (!uploadBytes || uploadBytes.length === 0) {
        sendError(res, 400, 'Photo upload is required (JPEG, PNG, or WebP).');
        return;
      }

      if (fileTruncated || uploadBytes.length > MAX_FILE_SIZE_BYTES) {
        sendError(
          res,
          413,
          `File size exceeds maximum allowed limit of ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`
        );
        return;
      }

      // 3. Category Validation
      const category = fields.category as CitizenReportCategory;
      if (!category || !ALLOWED_CATEGORIES.includes(category)) {
        sendError(
          res,
          400,
          `Invalid category. Allowed values: ${ALLOWED_CATEGORIES.join(', ')}.`
        );
        return;
      }

      // 4. Coordinate Validation
      const lat = parseFloat(fields.lat);
      const lon = parseFloat(fields.lon);
      const coordValidation = validateCoordinates(lat, lon);
      if (!coordValidation.valid) {
        sendError(res, 400, coordValidation.error ?? 'Invalid coordinates.');
        return;
      }

      // Snap nearest station
      const snap = snapToNearestStation(lat, lon);

      // 5. Description Sanitization
      const cleanDescription = sanitizeDescription(fields.description);

      // 6. Image Processing (Stripping EXIF & Re-encoding)
      let processed: Awaited<ReturnType<typeof processCitizenImage>>;
      try {
        processed = await processCitizenImage(uploadBytes);
      } catch (procErr: unknown) {
        const msg = procErr instanceof Error ? procErr.message : 'Image processing failed.';
        sendError(res, 400, msg);
        return;
      }

      // 7. Automated Moderation Precheck
      const precheck = await moderationService.runAutomatedPrecheck({
        contentHash: processed.contentHash,
        width: processed.width,
        height: processed.height,
        format: processed.ext,
        imageBuffer: processed.mainBuffer,
      });

      if (!precheck.passed) {
        sendError(res, 400, precheck.reason ?? 'Automated pre-check validation failed.');
        return;
      }

      // 8. Generate safe, random storage keys (UUID)
      const imageId = randomUUID();
      const imageKey = `${imageId}.jpg`;
      const thumbKey = `${imageId}_thumb.jpg`;

      // 9. Save re-encoded main and thumbnail images
      await imageStorage.saveImage(imageKey, processed.mainBuffer, processed.mimeType);
      await imageStorage.saveImage(thumbKey, processed.thumbBuffer, processed.mimeType);

      // 10. Persist Report Record (starts in PENDING status)
      // If DB insertion fails, clean up the saved images immediately to prevent orphaned files on disk
      let record: CitizenReportRecord;
      try {
        record = await reportStore.insertReport({
          category,
          description: cleanDescription,
          lat,
          lon,
          nearest_station_id: snap.nearestStationId,
          nearest_station_name: snap.nearestStationName,
          nearest_station_distance_km: snap.distanceKm,
          image_key: imageKey,
          thumb_key: thumbKey,
          content_hash: processed.contentHash,
          client_timestamp: fields.client_timestamp ? new Date(fields.client_timestamp).toISOString() : null,
        });
      } catch (dbErr) {
        await imageStorage.deleteImage(imageKey).catch(() => {});
        await imageStorage.deleteImage(thumbKey).catch(() => {});
        throw dbErr;
      }

      // 11. Asynchronously enqueue advisory triage suggestion
      // Strict failure isolation: triage queueing/failures must NEVER fail or delay the upload
      const triageStore = getReportTriageStore();
      triageStore.enqueueTriage(record.id).catch((triageErr) => {
        console.error('[Triage Enqueue Error - Isolated]', triageErr);
      });

      sendJson(res, 201, {
        success: true,
        report_id: record.id,
        status: record.status,
        message:
          'Citizen photo report submitted successfully. It will undergo moderation before public display.',
        nearest_station: snap.nearestStationName
          ? `${snap.nearestStationName} (${snap.distanceKm} km away)`
          : 'None nearby',
      });
      return;
    }

    sendError(res, 404, 'Endpoint not found.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error occurred.';
    // Never leak stack traces to client
    sendError(res, 500, `Server error: ${msg}`);
  }
}
