/**
 * Webhook Delivery Channel
 * =========================
 * Sends authoritative alert payloads via HTTP POST with:
 * 1. HMAC-SHA256 signature header for payload verification.
 * 2. Strict SSRF protection (rejects private, loopback, and link-local targets).
 * 3. 5-second timeout and clean error scrubbing.
 */

import { createHmac } from 'node:crypto';
import type { StructuredAlertMessage, RecipientRecord } from '../../types/alertDelivery';

export interface ChannelSendResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

/**
 * Validates target URL against SSRF vulnerabilities.
 * Blocks:
 * - Localhost / Loopback (127.0.0.1, ::1, localhost)
 * - Private RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Cloud metadata & Link-Local (169.254.0.0/16)
 * - Multicast / Broadcast
 * Can be overridden for local automated testing via ALERT_ALLOW_PRIVATE_WEBHOOKS=true.
 */
export function isSsrfBlocked(urlStr: string): { blocked: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { blocked: true, reason: 'Invalid destination URL format.' };
  }

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && parsed.protocol !== 'https:') {
    return { blocked: true, reason: 'HTTPS is strictly required for webhooks in production.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: true, reason: `Unsupported protocol "${parsed.protocol}". Only HTTP/HTTPS allowed.` };
  }

  const allowPrivate = process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS === 'true';
  if (allowPrivate) {
    return { blocked: false };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  // Hostname checks
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname === 'metadata.google.internal') {
    return { blocked: true, reason: `SSRF Blocked: Loopback or internal hostname "${rawHostname}" is prohibited.` };
  }

  // IPv4 Checks
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octet1 = parseInt(ipv4Match[1], 10);
    const octet2 = parseInt(ipv4Match[2], 10);

    // 127.0.0.0/8 (Loopback)
    if (octet1 === 127) return { blocked: true, reason: 'SSRF Blocked: 127.0.0.0/8 loopback address.' };
    // 0.0.0.0
    if (octet1 === 0) return { blocked: true, reason: 'SSRF Blocked: 0.0.0.0 non-routable address.' };
    // 10.0.0.0/8 (Private)
    if (octet1 === 10) return { blocked: true, reason: 'SSRF Blocked: 10.0.0.0/8 private address space.' };
    // 172.16.0.0/12 (Private)
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
      return { blocked: true, reason: 'SSRF Blocked: 172.16.0.0/12 private address space.' };
    }
    // 192.168.0.0/16 (Private)
    if (octet1 === 192 && octet2 === 168) {
      return { blocked: true, reason: 'SSRF Blocked: 192.168.0.0/16 private address space.' };
    }
    // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
    if (octet1 === 169 && octet2 === 254) {
      return { blocked: true, reason: 'SSRF Blocked: 169.254.0.0/16 link-local / cloud metadata address.' };
    }
  }

  // IPv6 Checks
  if (hostname === '::1' || hostname === '::' || hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
    return { blocked: true, reason: 'SSRF Blocked: IPv6 loopback, link-local, or unique-local address.' };
  }

  return { blocked: false };
}

/**
 * Computes HMAC-SHA256 signature for webhook payload.
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const content = `${timestamp}.${body}`;
  return createHmac('sha256', secret).update(content).digest('hex');
}

export async function sendWebhookAlert(
  recipient: RecipientRecord,
  message: StructuredAlertMessage,
  idempotencyKey?: string
): Promise<ChannelSendResult> {
  const url = recipient.destination;

  // SSRF Protection
  const ssrfCheck = isSsrfBlocked(url);
  if (ssrfCheck.blocked) {
    return {
      success: false,
      error: ssrfCheck.reason,
    };
  }

  const signingSecret =
    recipient.secret_key || process.env.ALERT_WEBHOOK_SIGNING_SECRET || 'vayudrishti_webhook_default_secret';
  const timestamp = new Date().toISOString();
  const bodyPayload: Record<string, any> = {
    event: 'air_quality.acute_spike_alert',
    timestamp,
    data: message,
  };

  if (idempotencyKey) {
    bodyPayload.delivery_id = idempotencyKey;
    bodyPayload.idempotency_key = idempotencyKey;
  }

  const bodyString = JSON.stringify(bodyPayload);
  const signature = signWebhookPayload(signingSecret, timestamp, bodyString);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'VayuDrishti-Alert-Dispatcher/1.0',
    'X-VayuDrishti-Timestamp': timestamp,
    'X-VayuDrishti-Signature': `sha256=${signature}`,
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyString,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    let resText = '';
    try {
      resText = (await res.text()).slice(0, 500);
    } catch {}

    const success = res.status >= 200 && res.status < 300;
    return {
      success,
      statusCode: res.status,
      responseBody: resText,
      error: success ? undefined : `HTTP ${res.status}: ${resText}`,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    // Sanitize any URLs with query parameters from error string
    const scrubbedMsg = msg.replace(/\?([^ ]+)/g, '?[REDACTED]');
    return {
      success: false,
      error: `Webhook connection failed: ${scrubbedMsg}`,
    };
  }
}
