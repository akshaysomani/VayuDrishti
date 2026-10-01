/**
 * Alert Delivery HTTP API Handler
 * ================================
 * Routes:
 * 1. GET  /api/alerts/delivery/stats             - Public overview (sanitized, zero recipient PII).
 * 2. GET  /api/alerts/delivery/admin/recipients  - Admin: List recipients (token protected).
 * 3. POST /api/alerts/delivery/admin/recipients  - Admin: Create recipient (token protected).
 * 4. PATCH /api/alerts/delivery/admin/recipients/:id - Admin: Update recipient (token protected).
 * 5. DELETE /api/alerts/delivery/admin/recipients/:id - Admin: Delete recipient (token protected).
 * 6. GET  /api/alerts/delivery/admin/outbox      - Admin: List outbox items (token protected).
 * 7. POST /api/alerts/delivery/admin/test-alert  - Admin: Send simulated test alert (token protected).
 * 8. POST /api/alerts/delivery/admin/retry/:id   - Admin: Retry failed/dead outbox item (token protected).
 * 9. POST /api/alerts/delivery/admin/dispatch-now - Admin: Run manual dispatch cycle (token protected).
 *
 * Security:
 * - Constant-time comparison using crypto.timingSafeEqual.
 * - Fails closed if token is unconfigured (503).
 * - No recipient destinations leaked to public.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { getAlertDeliveryStore } from './storage/alertDeliveryStore';
import { getGlobalAlertDispatcher } from './services/alertDispatcher';
import { sendWebhookAlert } from './channels/webhookChannel';
import { sendEmailAlert } from './channels/emailChannel';
import type {
  RecipientCreateInput,
  StructuredAlertMessage,
} from '../types/alertDelivery';

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

// -----------------------------------------------------------------------------
// Admin Token Authentication & Failure Rate Limiting (Phase 5 f4 Hardening)
// -----------------------------------------------------------------------------

interface AuthFailureState {
  count: number;
  resetAt: number;
}

const authFailureMap = new Map<string, AuthFailureState>();
const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const AUTH_FAILURE_MAX = 10;

export function resetAuthRateLimiterForTesting(): void {
  authFailureMap.clear();
}

function getHashedClientKey(req: IncomingMessage): string {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  let ip = '';
  if (trustProxy && req.headers['x-forwarded-for']) {
    const raw = req.headers['x-forwarded-for'];
    const forwarded = Array.isArray(raw) ? raw[0] : raw;
    ip = forwarded.split(',')[0].trim();
  }
  if (!ip) {
    ip = req.socket?.remoteAddress || '127.0.0.1';
  }
  return createHash('sha256').update(ip).digest('hex');
}

export function verifyAdminToken(providedToken?: string | null): boolean {
  if (!providedToken) return false;

  const serverSecret = process.env.ALERT_ADMIN_TOKEN;
  if (!serverSecret || serverSecret.trim().length === 0) {
    return false;
  }

  let cleanProvided = providedToken.trim();
  if (cleanProvided.startsWith('Bearer ')) {
    cleanProvided = cleanProvided.slice(7).trim();
  }

  const expectedBuf = Buffer.from(serverSecret.trim(), 'utf8');
  const providedBuf = Buffer.from(cleanProvided, 'utf8');

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

export function isAdminConfigured(): boolean {
  const secret = process.env.ALERT_ADMIN_TOKEN;
  return Boolean(secret && secret.trim().length > 0);
}

export function maskDestination(destination: string, channel: string): string {
  if (channel === 'email') {
    const parts = destination.split('@');
    if (parts.length === 2) {
      const u = parts[0];
      const maskedUser = u.length > 2 ? `${u[0]}***${u[u.length - 1]}` : '***';
      return `${maskedUser}@${parts[1]}`;
    }
    return '***@***.***';
  }
  // Webhook
  try {
    const u = new URL(destination);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return 'https://***';
  }
}

export async function handleAlertDeliveryRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const host = req.headers.host ?? 'localhost:5173';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  const store = getAlertDeliveryStore();
  const dispatcher = getGlobalAlertDispatcher();

  try {
    // -------------------------------------------------------------------------
    // 1. PUBLIC: GET /api/alerts/delivery/stats (Strictly Minimized Output)
    // -------------------------------------------------------------------------
    if (pathname === '/api/alerts/delivery/stats' && method === 'GET') {
      const stats = await store.getDeliveryStats();
      // Public output contains zero recipient names, destinations, or URLs
      sendJson(res, 200, stats);
      return;
    }

    // -------------------------------------------------------------------------
    // 2. ADMIN AUTH GUARD (All /admin/* routes with Failure Rate Limiting)
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/alerts/delivery/admin')) {
      if (!isAdminConfigured()) {
        sendError(
          res,
          503,
          'Alert admin service is unconfigured on server (missing ALERT_ADMIN_TOKEN).'
        );
        return;
      }

      const clientKey = getHashedClientKey(req);
      const now = Date.now();
      const failState = authFailureMap.get(clientKey);

      const authHeader =
        req.headers.authorization ||
        (req.headers['x-alert-admin-token'] as string) ||
        (req.headers['x-moderator-token'] as string);

      const isValidToken = verifyAdminToken(authHeader);

      if (isValidToken) {
        // Successful auth is not penalized
        if (failState) {
          authFailureMap.delete(clientKey);
        }
      } else {
        // Check failure rate limit: 10 failures per 10 minutes
        if (failState && now < failState.resetAt && failState.count >= AUTH_FAILURE_MAX) {
          const retryAfterSeconds = Math.max(1, Math.ceil((failState.resetAt - now) / 1000));
          res.setHeader('Retry-After', String(retryAfterSeconds));
          sendError(
            res,
            429,
            `Too Many Requests: Too many failed admin authentication attempts. Retry after ${retryAfterSeconds} seconds.`
          );
          return;
        }

        // Record failure
        const currentCount = failState && now < failState.resetAt ? failState.count + 1 : 1;
        const resetAt =
          failState && now < failState.resetAt ? failState.resetAt : now + AUTH_FAILURE_WINDOW_MS;
        authFailureMap.set(clientKey, { count: currentCount, resetAt });

        sendError(res, 401, 'Unauthorized: Valid admin credentials required.');
        return;
      }

      // -----------------------------------------------------------------------
      // 2.0 GET /api/alerts/delivery/admin/stats (Full Admin Stats with masked deliveries)
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/stats' && method === 'GET') {
        const adminStats = await store.getAdminDeliveryStats();
        sendJson(res, 200, adminStats);
        return;
      }

      // -----------------------------------------------------------------------
      // 2.0b GET /api/alerts/delivery/admin/deliveries (Full Delivery Audit Log)
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/deliveries' && method === 'GET') {
        const deliveries = await store.listRecentDeliveries(50);
        sendJson(res, 200, { deliveries });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.1 GET /api/alerts/delivery/admin/recipients
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/recipients' && method === 'GET') {
        const recipients = await store.listRecipients(false);
        sendJson(res, 200, { recipients });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.2 POST /api/alerts/delivery/admin/recipients
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/recipients' && method === 'POST') {
        let bodyRaw = '';
        for await (const chunk of req) bodyRaw += chunk;

        let body: any;
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          sendError(res, 400, 'Invalid JSON body.');
          return;
        }

        const { name, channel, destination, secret_key, scope_type, scope_value, min_tier, active } = body;
        if (!name || !channel || !destination) {
          sendError(res, 400, 'Fields "name", "channel" (email|webhook), and "destination" are required.');
          return;
        }

        if (channel !== 'email' && channel !== 'webhook') {
          sendError(res, 400, 'Field "channel" must be "email" or "webhook".');
          return;
        }

        if (channel === 'email' && !destination.includes('@')) {
          sendError(res, 400, 'Invalid email destination format.');
          return;
        }

        if (channel === 'webhook' && !destination.startsWith('http')) {
          sendError(res, 400, 'Webhook destination must begin with http:// or https://.');
          return;
        }

        const input: RecipientCreateInput = {
          name: String(name).slice(0, 150),
          channel,
          destination: String(destination).slice(0, 500),
          secret_key: secret_key ? String(secret_key).slice(0, 255) : null,
          scope_type: scope_type === 'city' || scope_type === 'station' ? scope_type : 'all',
          scope_value: scope_value ? String(scope_value).slice(0, 100) : null,
          min_tier: min_tier === 'WATCH' || min_tier === 'HIGH' ? min_tier : 'ELEVATED',
          active: active !== undefined ? Boolean(active) : true,
        };

        let created: any;
        try {
          created = await store.createRecipient(input);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('unique') || msg.includes('uq_recipients')) {
            sendError(res, 409, 'An active recipient with this channel and destination already exists.');
            return;
          }
          throw err;
        }

        sendJson(res, 201, { success: true, recipient: created });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.3 PATCH /api/alerts/delivery/admin/recipients/:id
      // -----------------------------------------------------------------------
      if (pathname.startsWith('/api/alerts/delivery/admin/recipients/') && method === 'PATCH') {
        const id = pathname.replace('/api/alerts/delivery/admin/recipients/', '').trim();
        let bodyRaw = '';
        for await (const chunk of req) bodyRaw += chunk;

        let updates: any;
        try {
          updates = JSON.parse(bodyRaw);
        } catch {
          sendError(res, 400, 'Invalid JSON body.');
          return;
        }

        const existing = await store.getRecipientById(id);
        if (!existing) {
          sendError(res, 404, 'Recipient not found.');
          return;
        }
        if (existing.deleted_at) {
          sendError(
            res,
            409,
            'Cannot update or re-activate soft-deleted recipient. Please register as a new recipient.'
          );
          return;
        }

        const updated = await store.updateRecipient(id, updates);
        if (!updated) {
          sendError(res, 404, 'Recipient not found.');
          return;
        }
        sendJson(res, 200, { success: true, recipient: updated });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.4 DELETE /api/alerts/delivery/admin/recipients/:id
      // -----------------------------------------------------------------------
      if (pathname.startsWith('/api/alerts/delivery/admin/recipients/') && method === 'DELETE') {
        const id = pathname.replace('/api/alerts/delivery/admin/recipients/', '').trim();
        const deleted = await store.deleteRecipient(id);
        if (!deleted) {
          sendError(res, 404, 'Recipient not found or already deleted.');
          return;
        }
        sendJson(res, 200, { success: true, message: `Recipient ${id} soft-deleted.` });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.5 GET /api/alerts/delivery/admin/outbox
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/outbox' && method === 'GET') {
        const statusParam = url.searchParams.get('status') as any;
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

        const result = await store.listOutbox(statusParam, limit, offset);
        sendJson(res, 200, result);
        return;
      }

      // -----------------------------------------------------------------------
      // 2.6 POST /api/alerts/delivery/admin/test-alert
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/test-alert' && method === 'POST') {
        let bodyRaw = '';
        for await (const chunk of req) bodyRaw += chunk;

        let body: any = {};
        if (bodyRaw.trim().length > 0) {
          try {
            body = JSON.parse(bodyRaw);
          } catch {}
        }

        const recipientId = body.recipient_id;
        let recipient: any = null;

        if (recipientId) {
          recipient = await store.getRecipientById(recipientId);
        } else {
          // If no ID specified, pick first active recipient
          const activeRecs = await store.listRecipients(true);
          recipient = activeRecs[0] ?? null;
        }

        if (!recipient || recipient.deleted_at || !recipient.active) {
          sendError(res, 404, 'No active recipient found to receive test alert.');
          return;
        }

        const testMessage: StructuredAlertMessage = {
          alert_id: 'test-' + Date.now(),
          station_id: body.station_id || 'DL001',
          station_name: body.station_name || 'Anand Vihar, Delhi - DPCC',
          city: body.city || 'Delhi',
          probability: 0.35,
          tier: 'Elevated',
          expected_people_exposed: 84000,
          coord_quality: 'station',
          source_observation_timestamp: new Date().toISOString(),
          model_version: 'Phase 1 Calibrated LR v1.0',
          dashboard_url: `${process.env.DASHBOARD_BASE_URL || 'http://localhost:5173'}/#alerts`,
          is_test: true,
          disclaimer: 'TEST ALERT ONLY: Verification check dispatched by administrator. No actual emergency.',
          coord_quality_note: null,
        };

        let result: { success: boolean; statusCode?: number; error?: string };
        if (recipient.channel === 'webhook') {
          result = await sendWebhookAlert(recipient, testMessage);
        } else {
          result = await sendEmailAlert(recipient, testMessage);
        }

        sendJson(res, result.success ? 200 : 502, {
          success: result.success,
          recipient_name: recipient.name,
          channel: recipient.channel,
          destination: maskDestination(recipient.destination, recipient.channel),
          status_code: result.statusCode,
          error: result.error,
          message: result.success
            ? 'Test alert successfully delivered.'
            : `Test delivery failed: ${result.error}`,
        });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.7 POST /api/alerts/delivery/admin/retry/:id
      // -----------------------------------------------------------------------
      if (pathname.startsWith('/api/alerts/delivery/admin/retry/') && method === 'POST') {
        const id = pathname.replace('/api/alerts/delivery/admin/retry/', '').trim();
        const retried = await store.retryFailedItem(id);
        if (!retried) {
          sendError(res, 404, 'Outbox item not found or not in FAILED/DEAD state.');
          return;
        }
        sendJson(res, 200, { success: true, message: `Outbox item ${id} queued for immediate retry.` });
        return;
      }

      // -----------------------------------------------------------------------
      // 2.8 POST /api/alerts/delivery/admin/dispatch-now
      // -----------------------------------------------------------------------
      if (pathname === '/api/alerts/delivery/admin/dispatch-now' && method === 'POST') {
        const resStats = await dispatcher.dispatchCycle();
        sendJson(res, 200, { success: true, processed_count: resStats.processedCount });
        return;
      }
    }

    sendError(res, 404, 'Alert delivery endpoint not found.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal alert delivery error.';
    sendError(res, 500, msg);
  }
}
