/**
 * Transactional Outbox Dispatcher
 * ================================
 * Periodically claims pending alert outbox records using SELECT ... FOR UPDATE SKIP LOCKED.
 * Dispatches alerts across verified recipient channels (email, webhook) with:
 * 1. Exponential backoff and dead-letter queueing.
 * 2. DRY_RUN mode protection (sends nothing externally, records DRY_RUN audit logs).
 * 3. Scope matching (all, city, station) and recipient min_tier overrides.
 * 4. Concurrency guard preventing overlapping dispatcher cycles.
 */

import { createHash } from 'node:crypto';
import type { IAlertDeliveryStore } from '../storage/alertDeliveryStore';
import { getAlertDeliveryStore } from '../storage/alertDeliveryStore';
import { AlertDeliveryPolicy, TIER_RANKS } from './alertDeliveryPolicy';
import { sendWebhookAlert } from '../channels/webhookChannel';
import { sendEmailAlert } from '../channels/emailChannel';
import type {
  AlertOutboxRecord,
  RecipientRecord,
  AlertDeliveryMode,
} from '../../types/alertDelivery';
import type { LiveAlertPayload } from '../../types/liveAlert';

/**
 * Derives a stable, deterministic idempotency key from outbox dedupe_key and recipient ID.
 * Must be identical across retries/reclaims and never leak secrets.
 */
export function generateDeliveryIdempotencyKey(dedupeKey: string, recipientId: string): string {
  return createHash('sha256').update(`${dedupeKey}:${recipientId}`).digest('hex');
}

/**
 * Startup safety validator for Alert Delivery configuration.
 */
export function validateAlertSafetyConfig(overrides?: {
  nodeEnv?: string;
  deliveryMode?: string;
  allowPrivateWebhooks?: boolean;
  hasAdminToken?: boolean;
  hasSigningSecret?: boolean;
}): { canStart: boolean; error?: string } {
  const isProduction =
    overrides?.nodeEnv !== undefined
      ? overrides.nodeEnv === 'production'
      : process.env.NODE_ENV === 'production';
  const allowPrivateWebhooks =
    overrides?.allowPrivateWebhooks !== undefined
      ? overrides.allowPrivateWebhooks
      : process.env.ALERT_ALLOW_PRIVATE_WEBHOOKS === 'true';

  if (isProduction && allowPrivateWebhooks) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: ALERT_ALLOW_PRIVATE_WEBHOOKS=true is strictly prohibited in production.'
    );
  }

  const mode = (overrides?.deliveryMode ?? process.env.ALERT_DELIVERY_MODE ?? 'dry_run')
    .toLowerCase()
    .trim();
  if (mode === 'live' && isProduction) {
    const hasAdminToken =
      overrides?.hasAdminToken !== undefined
        ? overrides.hasAdminToken
        : Boolean(process.env.ALERT_ADMIN_TOKEN && process.env.ALERT_ADMIN_TOKEN.trim());
    const hasSigningSecret =
      overrides?.hasSigningSecret !== undefined
        ? overrides.hasSigningSecret
        : Boolean(
            process.env.ALERT_WEBHOOK_SIGNING_SECRET && process.env.ALERT_WEBHOOK_SIGNING_SECRET.trim()
          );
    if (!hasAdminToken || !hasSigningSecret) {
      const err =
        '[AlertDispatcher FATAL] ALERT_DELIVERY_MODE=live in production requires ALERT_ADMIN_TOKEN and ALERT_WEBHOOK_SIGNING_SECRET. Refusing to start dispatcher.';
      console.error(err);
      return { canStart: false, error: err };
    }
  }

  return { canStart: true };
}

export class AlertDispatcher {
  private store: IAlertDeliveryStore;
  private policy: AlertDeliveryPolicy;
  private isDispatching: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number = 5000; // 5-second polling interval

  private modeOption?: AlertDeliveryMode;

  constructor(store?: IAlertDeliveryStore) {
    this.store = store || getAlertDeliveryStore();
    this.policy = new AlertDeliveryPolicy(this.store);
  }

  public setMode(mode: AlertDeliveryMode): void {
    this.modeOption = mode;
  }

  public getMode(): AlertDeliveryMode {
    if (this.modeOption) return this.modeOption;
    const raw = (process.env.ALERT_DELIVERY_MODE || 'dry_run').toLowerCase().trim();
    return raw === 'live' ? 'live' : 'dry_run';
  }

  /**
   * Post-Inference Hook: Called directly by ingestion scheduler after model inference.
   * Evaluates delivery policy and queues outbox item if warranted.
   */
  public async handleInferenceResult(
    payload: LiveAlertPayload
  ): Promise<{ queued: boolean; reason?: string; outboxId?: string }> {
    try {
      const evaluation = await this.policy.evaluatePayload(payload);
      if (!evaluation.shouldDeliver || !evaluation.outboxItem) {
        return { queued: false, reason: evaluation.reason };
      }

      const queueResult = await this.store.queueOutboxAlert(evaluation.outboxItem);
      return queueResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AlertDispatcher] Error handling inference result:', msg);
      return { queued: false, reason: msg };
    }
  }

  /**
   * Checks whether a recipient should receive this outbox item based on scope and tier.
   */
  public isRecipientEligible(recipient: RecipientRecord, item: AlertOutboxRecord): boolean {
    if (!recipient.active) return false;

    // Scope check
    if (recipient.scope_type === 'city') {
      if (recipient.scope_value?.toLowerCase() !== item.city.toLowerCase()) {
        return false;
      }
    } else if (recipient.scope_type === 'station') {
      if (recipient.scope_value !== item.station_id) {
        return false;
      }
    }

    // Recipient-level min_tier override
    if (recipient.min_tier) {
      const currentRank = TIER_RANKS[item.tier] ?? 0;
      const minRank = recipient.min_tier === 'WATCH' ? 1 : recipient.min_tier === 'HIGH' ? 3 : 2;
      if (currentRank < minRank) {
        return false;
      }
    }

    return true;
  }

  /**
   * Concurrency-safe dispatch cycle.
   */
  public async dispatchCycle(): Promise<{
    processedCount: number;
    sentCount: number;
    dryRunCount: number;
    failedCount: number;
  }> {
    if (this.isDispatching) {
      return { processedCount: 0, sentCount: 0, dryRunCount: 0, failedCount: 0 };
    }

    this.isDispatching = true;
    let processedCount = 0;
    let sentCount = 0;
    let dryRunCount = 0;
    let failedCount = 0;

    try {
      // 1. Recover any stuck SENDING rows whose lease has expired
      await this.store.reclaimStuckLeases().catch((err) => {
        console.error('[AlertDispatcher] Error reclaiming stuck leases:', err);
      });

      // Claim pending rows safely with SKIP LOCKED
      const items = await this.store.claimPendingOutboxItems(10);
      if (items.length === 0) {
        return { processedCount: 0, sentCount: 0, dryRunCount: 0, failedCount: 0 };
      }

      const mode = this.getMode();
      const allRecipients = await this.store.listRecipients(true);

      for (const item of items) {
        processedCount++;
        const eligibleRecipients = allRecipients.filter((r) => this.isRecipientEligible(r, item));

        // Inject genuine assigned outbox ID into payload
        item.payload.alert_id = item.id;

        if (mode === 'dry_run') {
          dryRunCount++;
          // DRY RUN MODE: Assert zero external calls
          for (const recipient of eligibleRecipients) {
            await this.store.recordDelivery({
              outbox_id: item.id,
              recipient_id: recipient.id,
              channel: recipient.channel,
              recipient_destination: recipient.destination,
              status: 'DRY_RUN',
              provider_response_code: 200,
              provider_response_body: '[DRY_RUN] Simulated delivery. External network call suppressed.',
              error_message: null,
            });
          }

          await this.store.updateOutboxStatus(
            item.id,
            'DRY_RUN',
            item.attempts + 1,
            new Date(Date.now() + 86400000), // Next attempt far in future
            eligibleRecipients.length === 0 ? 'DRY_RUN: No matching active recipients.' : null
          );
          continue;
        }

        // LIVE MODE: Send to external providers
        if (eligibleRecipients.length === 0) {
          await this.store.updateOutboxStatus(
            item.id,
            'SENT',
            item.attempts + 1,
            new Date(),
            'Live mode notice: No active recipients matched alert scope.'
          );
          continue;
        }

        let anyFailed = false;
        let lastErrorMsg: string | null = null;

        for (const recipient of eligibleRecipients) {
          let sendResult: { success: boolean; statusCode?: number; responseBody?: string; error?: string };
          const idempotencyKey = generateDeliveryIdempotencyKey(item.dedupe_key, recipient.id);

          if (recipient.channel === 'webhook') {
            sendResult = await sendWebhookAlert(recipient, item.payload, idempotencyKey);
          } else if (recipient.channel === 'email') {
            sendResult = await sendEmailAlert(recipient, item.payload, idempotencyKey);
          } else {
            sendResult = { success: false, error: `Unsupported channel "${recipient.channel}"` };
          }

          await this.store.recordDelivery({
            outbox_id: item.id,
            recipient_id: recipient.id,
            channel: recipient.channel,
            recipient_destination: recipient.destination,
            status: sendResult.success ? 'SENT' : 'FAILED',
            provider_response_code: sendResult.statusCode ?? (sendResult.success ? 200 : 500),
            provider_response_body: sendResult.responseBody ?? null,
            error_message: sendResult.error ?? null,
          });

          if (!sendResult.success) {
            anyFailed = true;
            lastErrorMsg = sendResult.error || 'External provider delivery failure';
          }
        }

        if (!anyFailed) {
          sentCount++;
          await this.store.updateOutboxStatus(item.id, 'SENT', item.attempts + 1, new Date(), null);
        } else {
          failedCount++;
          const nextAttempts = item.attempts + 1;
          if (nextAttempts >= item.max_attempts) {
            // Dead-letter queue
            await this.store.updateOutboxStatus(
              item.id,
              'DEAD',
              nextAttempts,
              new Date(Date.now() + 30 * 86400000),
              `Max attempts (${item.max_attempts}) exceeded: ${lastErrorMsg}`
            );
          } else {
            // Exponential backoff: 2^attempts * 1000ms capped at 1h
            const delayMs = Math.min(3600000, 1000 * Math.pow(2, nextAttempts));
            const nextAttemptAt = new Date(Date.now() + delayMs);
            await this.store.updateOutboxStatus(
              item.id,
              'FAILED',
              nextAttempts,
              nextAttemptAt,
              lastErrorMsg
            );
          }
        }
      }

      return { processedCount, sentCount, dryRunCount, failedCount };
    } finally {
      this.isDispatching = false;
    }
  }

  public startDispatcher(): void {
    if (this.timer) return;

    // Startup safety check (throws if private webhooks in production, stops if live mode unconfigured)
    const safety = validateAlertSafetyConfig();
    if (!safety.canStart) {
      return;
    }

    const mode = this.getMode();
    const isProduction = process.env.NODE_ENV === 'production';

    if (mode === 'live' && isProduction) {
      // Production live check: warn if no recipients or channels configured
      this.store.listRecipients(true).then((recs) => {
        if (recs.length === 0) {
          console.warn(
            '[AlertDispatcher Warning] Running in LIVE mode without any active recipients configured. No external alerts will be delivered until recipients are added.'
          );
        }
      }).catch(() => {});
    }

    // Run first cycle
    this.dispatchCycle().catch(() => {});

    // Periodic loop
    this.timer = setInterval(() => {
      this.dispatchCycle().catch(() => {});
    }, this.intervalMs);
  }

  public stopDispatcher(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let globalAlertDispatcher: AlertDispatcher | null = null;

export function getGlobalAlertDispatcher(): AlertDispatcher {
  if (!globalAlertDispatcher) {
    globalAlertDispatcher = new AlertDispatcher();
  }
  return globalAlertDispatcher;
}
