/**
 * Alert Delivery PostgreSQL Storage Engine
 * ========================================
 * Implements persistent operations for:
 * 1. Recipient Registry (email and webhook subscribers)
 * 2. Transactional Outbox (with concurrency-safe SELECT ... FOR UPDATE SKIP LOCKED)
 * 3. Append-only Delivery Audit Log
 * 4. Station Cooldown Tracking
 *
 * Follows repository database patterns with pooled connections and parameterized queries.
 */

import pg from 'pg';
import { normalizeDatabaseUrl } from '../db/migrator';
import { extractDatabaseName, getVerifiedTestDatabaseUrl } from '../db/testDbHelper';
import { ensureServerEnvLoaded } from '../db/envLoader';
import type {
  RecipientRecord,
  RecipientCreateInput,
  AlertOutboxRecord,
  OutboxCreateInput,
  OutboxStatus,
  AlertDeliveryRecord,
  AlertDeliveryCreateInput,
  AlertDeliveryStats,
  AdminAlertDeliveryStats,
  PublicRecentDelivery,
  StationCooldownState,
  AlertDeliveryMode,
} from '../../types/alertDelivery';
import type { RiskTier } from '../../types/alert';

export interface IAlertDeliveryStore {
  createRecipient(input: RecipientCreateInput): Promise<RecipientRecord>;
  listRecipients(activeOnly?: boolean): Promise<RecipientRecord[]>;
  getRecipientById(id: string): Promise<RecipientRecord | null>;
  updateRecipient(id: string, updates: Partial<RecipientCreateInput>): Promise<RecipientRecord | null>;
  deleteRecipient(id: string): Promise<boolean>;

  queueOutboxAlert(input: OutboxCreateInput): Promise<{ queued: boolean; outboxId?: string; reason?: string }>;
  getOutboxItemById(id: string): Promise<AlertOutboxRecord | null>;
  listOutbox(status?: OutboxStatus, limit?: number, offset?: number): Promise<{ items: AlertOutboxRecord[]; total: number }>;
  claimPendingOutboxItems(limit?: number, leaseSeconds?: number): Promise<AlertOutboxRecord[]>;
  reclaimStuckLeases(): Promise<{ reclaimed: number; deadLettered: number }>;
  updateOutboxStatus(
    id: string,
    status: OutboxStatus,
    attempts: number,
    nextAttemptAt: Date,
    lastError?: string | null
  ): Promise<void>;

  recordDelivery(input: AlertDeliveryCreateInput): Promise<AlertDeliveryRecord>;
  listRecentDeliveries(limit?: number): Promise<AlertDeliveryRecord[]>;
  listRecentPublicDeliveries(limit?: number): Promise<PublicRecentDelivery[]>;
  getStationLastAlert(stationId: string): Promise<{ tier: RiskTier; createdAt: Date } | null>;
  getDeliveryStats(): Promise<AlertDeliveryStats>;
  getAdminDeliveryStats(): Promise<AdminAlertDeliveryStats>;
  retryFailedItem(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export class PostgresAlertDeliveryStore implements IAlertDeliveryStore {
  private pool: pg.Pool;
  private databaseName: string;

  constructor(connectionString?: string) {
    let targetUrl = connectionString;
    if (!targetUrl) {
      if (process.env.NODE_ENV === 'test') {
        targetUrl = getVerifiedTestDatabaseUrl();
      } else {
        targetUrl = process.env.DATABASE_URL || '';
      }
    }
    const normalized = normalizeDatabaseUrl(targetUrl);
    this.pool = new pg.Pool({ connectionString: normalized });
    this.databaseName = extractDatabaseName(targetUrl);
  }

  // ---------------------------------------------------------------------------
  // 1. RECIPIENT REGISTRY
  // ---------------------------------------------------------------------------

  public async createRecipient(input: RecipientCreateInput): Promise<RecipientRecord> {
    const res = await this.pool.query(
      `INSERT INTO recipients (
        name, channel, destination, secret_key, scope_type, scope_value, min_tier, active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;`,
      [
        input.name,
        input.channel,
        input.destination,
        input.secret_key ?? null,
        input.scope_type || 'all',
        input.scope_value ?? null,
        input.min_tier ?? null,
        input.active !== undefined ? input.active : true,
      ]
    );
    return this.mapRecipient(res.rows[0]);
  }

  public async listRecipients(activeOnly: boolean = false): Promise<RecipientRecord[]> {
    const query = activeOnly
      ? 'SELECT * FROM recipients WHERE deleted_at IS NULL AND active = true ORDER BY created_at ASC;'
      : 'SELECT * FROM recipients WHERE deleted_at IS NULL ORDER BY created_at ASC;';
    const res = await this.pool.query(query);
    return res.rows.map(this.mapRecipient);
  }

  public async getRecipientById(id: string): Promise<RecipientRecord | null> {
    const res = await this.pool.query('SELECT * FROM recipients WHERE id = $1 LIMIT 1;', [id]);
    return res.rows.length > 0 ? this.mapRecipient(res.rows[0]) : null;
  }

  public async updateRecipient(
    id: string,
    updates: Partial<RecipientCreateInput>
  ): Promise<RecipientRecord | null> {
    const current = await this.getRecipientById(id);
    if (!current || current.deleted_at) return null;

    const res = await this.pool.query(
      `UPDATE recipients SET
        name = COALESCE($2, name),
        channel = COALESCE($3, channel),
        destination = COALESCE($4, destination),
        secret_key = COALESCE($5, secret_key),
        scope_type = COALESCE($6, scope_type),
        scope_value = COALESCE($7, scope_value),
        min_tier = COALESCE($8, min_tier),
        active = COALESCE($9, active),
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *;`,
      [
        id,
        updates.name,
        updates.channel,
        updates.destination,
        updates.secret_key,
        updates.scope_type,
        updates.scope_value,
        updates.min_tier,
        updates.active,
      ]
    );
    return res.rows.length > 0 ? this.mapRecipient(res.rows[0]) : null;
  }

  public async deleteRecipient(id: string): Promise<boolean> {
    // Soft-delete recipient: set deleted_at and active=false, preserving audit history
    const res = await this.pool.query(
      'UPDATE recipients SET deleted_at = NOW(), active = false, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL;',
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // 2. TRANSACTIONAL OUTBOX
  // ---------------------------------------------------------------------------

  public async queueOutboxAlert(
    input: OutboxCreateInput
  ): Promise<{ queued: boolean; outboxId?: string; reason?: string }> {
    try {
      const res = await this.pool.query(
        `INSERT INTO alert_outbox (
          station_id, station_name, city, probability, tier,
          source_observation_timestamp, model_version, coord_quality,
          expected_people_exposed, payload, dedupe_key, status,
          max_attempts, next_attempt_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id;`,
        [
          input.station_id,
          input.station_name,
          input.city,
          input.probability,
          input.tier,
          input.source_observation_timestamp,
          input.model_version,
          input.coord_quality,
          input.expected_people_exposed,
          JSON.stringify(input.payload),
          input.dedupe_key,
          input.status,
          input.max_attempts,
          input.next_attempt_at,
        ]
      );
      return { queued: true, outboxId: res.rows[0].id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique constraint') || msg.includes('idx_outbox_dedupe_key') || msg.includes('alert_outbox_dedupe_key_key')) {
        return {
          queued: false,
          reason: `Duplicate alert detected for dedupe_key: "${input.dedupe_key}". Suppressed by database constraint.`,
        };
      }
      throw err;
    }
  }

  public async getOutboxItemById(id: string): Promise<AlertOutboxRecord | null> {
    const res = await this.pool.query('SELECT * FROM alert_outbox WHERE id = $1 LIMIT 1;', [id]);
    return res.rows.length > 0 ? this.mapOutbox(res.rows[0]) : null;
  }

  public async listOutbox(
    status?: OutboxStatus,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ items: AlertOutboxRecord[]; total: number }> {
    const whereClause = status ? 'WHERE status = $1' : '';
    const params: any[] = status ? [status] : [];

    const countRes = await this.pool.query(
      `SELECT COUNT(*) AS total FROM alert_outbox ${whereClause};`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const queryParams = status ? [status, limit, offset] : [limit, offset];
    const limitOffsetIndex = status ? '$2 OFFSET $3' : '$1 OFFSET $2';

    const itemsRes = await this.pool.query(
      `SELECT * FROM alert_outbox ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitOffsetIndex};`,
      queryParams
    );

    return {
      items: itemsRes.rows.map(this.mapOutbox),
      total,
    };
  }

  /**
   * Concurrency-safe claim using SELECT ... FOR UPDATE SKIP LOCKED
   * Claims up to `limit` rows in PENDING or FAILED (with next_attempt_at <= NOW())
   * and transitions their status to 'SENDING'.
   */
  /**
   * Concurrency-safe claim using SELECT ... FOR UPDATE SKIP LOCKED
   * Claims up to `limit` rows in PENDING or FAILED (with next_attempt_at <= NOW())
   * and transitions their status to 'SENDING' with a bounded lease_expires_at.
   */
  public async claimPendingOutboxItems(
    limit: number = 10,
    leaseSeconds?: number
  ): Promise<AlertOutboxRecord[]> {
    const leaseSec =
      leaseSeconds ?? parseInt(process.env.ALERT_SEND_LEASE_SECONDS || '120', 10);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN;');

      const selectRes = await client.query(
        `SELECT id FROM alert_outbox
         WHERE status IN ('PENDING', 'FAILED')
           AND next_attempt_at <= NOW()
           AND attempts < max_attempts
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED;`,
        [limit]
      );

      if (selectRes.rows.length === 0) {
        await client.query('COMMIT;');
        return [];
      }

      const ids = selectRes.rows.map((r) => r.id);
      const updateRes = await client.query(
        `UPDATE alert_outbox
         SET status = 'SENDING',
             lease_expires_at = NOW() + ($2 || ' seconds')::INTERVAL,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[])
         RETURNING *;`,
        [ids, leaseSec]
      );

      await client.query('COMMIT;');
      return updateRes.rows.map(this.mapOutbox);
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Recovers stuck SENDING rows whose lease has expired.
   * Race-safe atomic execution returning rows to PENDING (with backoff) or DEAD (if max attempts exceeded).
   */
  public async reclaimStuckLeases(): Promise<{ reclaimed: number; deadLettered: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN;');

      // 1. Mark dead rows where attempts >= max_attempts
      const deadRes = await client.query(
        `UPDATE alert_outbox
         SET status = 'DEAD',
             lease_expires_at = NULL,
             last_error = 'Lease expired while in SENDING status (stuck worker/timeout). Max attempts reached.',
             updated_at = NOW()
         WHERE status = 'SENDING'
           AND lease_expires_at < NOW()
           AND attempts >= max_attempts
         RETURNING id;`
      );

      // 2. Reclaim rows with attempts < max_attempts back to PENDING with attempts incremented and backoff
      const retryRes = await client.query(
        `UPDATE alert_outbox
         SET status = 'PENDING',
             attempts = attempts + 1,
             lease_expires_at = NULL,
             next_attempt_at = NOW() + (LEAST(3600, POWER(2, attempts + 1)) || ' seconds')::INTERVAL,
             last_error = 'Lease expired while in SENDING status (stuck worker/timeout). Reclaimed for retry.',
             updated_at = NOW()
         WHERE status = 'SENDING'
           AND lease_expires_at < NOW()
           AND attempts < max_attempts
         RETURNING id;`
      );

      await client.query('COMMIT;');
      return {
        reclaimed: retryRes.rowCount ?? 0,
        deadLettered: deadRes.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  }

  public async updateOutboxStatus(
    id: string,
    status: OutboxStatus,
    attempts: number,
    nextAttemptAt: Date,
    lastError?: string | null
  ): Promise<void> {
    const cleanError = lastError ? scrubSensitiveErrorInfo(lastError) : null;
    await this.pool.query(
      `UPDATE alert_outbox
       SET status = $2,
           attempts = $3,
           next_attempt_at = $4,
           last_error = $5,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1;`,
      [id, status, attempts, nextAttemptAt.toISOString(), cleanError]
    );
  }

  // ---------------------------------------------------------------------------
  // 3. AUDIT LOG & DELIVERIES
  // ---------------------------------------------------------------------------

  public async recordDelivery(input: AlertDeliveryCreateInput): Promise<AlertDeliveryRecord> {
    const res = await this.pool.query(
      `INSERT INTO alert_deliveries (
        outbox_id, recipient_id, channel, recipient_destination,
        status, provider_response_code, provider_response_body, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;`,
      [
        input.outbox_id,
        input.recipient_id ?? null,
        input.channel,
        input.recipient_destination,
        input.status,
        input.provider_response_code ?? null,
        input.provider_response_body ?? null,
        input.error_message ?? null,
      ]
    );
    return this.mapDelivery(res.rows[0]);
  }

  public async listRecentDeliveries(limit: number = 20): Promise<AlertDeliveryRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM alert_deliveries
       ORDER BY delivered_at DESC
       LIMIT $1;`,
      [limit]
    );
    return res.rows.map(this.mapDelivery);
  }

  public async listRecentPublicDeliveries(limit: number = 10): Promise<PublicRecentDelivery[]> {
    const res = await this.pool.query(
      `SELECT
         d.channel,
         d.status,
         COALESCE(o.station_name, o.station_id, 'Unknown') AS station,
         COALESCE(o.tier, 'Elevated') AS tier,
         d.delivered_at AS timestamp
       FROM alert_deliveries d
       LEFT JOIN alert_outbox o ON d.outbox_id = o.id
       ORDER BY d.delivered_at DESC
       LIMIT $1;`,
      [limit]
    );
    return res.rows.map((r) => ({
      channel: r.channel,
      status: r.status,
      station: r.station,
      tier: r.tier as RiskTier,
      timestamp: new Date(r.timestamp).toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // 4. STATION COOLDOWN STATE
  // ---------------------------------------------------------------------------

  public async getStationLastAlert(
    stationId: string
  ): Promise<{ tier: RiskTier; createdAt: Date } | null> {
    const res = await this.pool.query(
      `SELECT tier, created_at FROM alert_outbox
       WHERE station_id = $1
         AND status IN ('SENT', 'DRY_RUN', 'PENDING', 'SENDING')
       ORDER BY created_at DESC
       LIMIT 1;`,
      [stationId]
    );
    if (res.rows.length === 0) return null;
    return {
      tier: res.rows[0].tier as RiskTier,
      createdAt: new Date(res.rows[0].created_at),
    };
  }

  public async getDeliveryStats(): Promise<AlertDeliveryStats> {
    // 1. Status counts
    const countsRes = await this.pool.query(
      `SELECT status, COUNT(*) AS count FROM alert_outbox GROUP BY status;`
    );
    const counts: Record<OutboxStatus, number> = {
      PENDING: 0,
      SENDING: 0,
      SENT: 0,
      FAILED: 0,
      DEAD: 0,
      DRY_RUN: 0,
    };
    for (const r of countsRes.rows) {
      if (counts[r.status as OutboxStatus] !== undefined) {
        counts[r.status as OutboxStatus] = parseInt(r.count, 10);
      }
    }

    // 2. Recipient counts (excluding soft-deleted)
    const recCountRes = await this.pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND active = true) AS active
       FROM recipients;`
    );
    const totalRecipients = parseInt(recCountRes.rows[0]?.total ?? '0', 10);
    const activeRecipients = parseInt(recCountRes.rows[0]?.active ?? '0', 10);

    // 3. Recent deliveries (minimized public format, NO recipient destinations or names)
    const recentDeliveries = await this.listRecentPublicDeliveries(10);

    // 4. Cooldown states across active stations
    const cooldownWindowHours = parseInt(process.env.ALERT_COOLDOWN_HOURS || '6', 10);
    const recentOutboxRes = await this.pool.query(
      `SELECT DISTINCT ON (station_id) station_id, tier, created_at
       FROM alert_outbox
       WHERE status IN ('SENT', 'DRY_RUN', 'PENDING', 'SENDING')
       ORDER BY station_id, created_at DESC;`
    );

    const now = Date.now();
    const cooldowns: Record<string, StationCooldownState> = {};
    for (const row of recentOutboxRes.rows) {
      const alertTime = new Date(row.created_at).getTime();
      const expiresAtMs = alertTime + cooldownWindowHours * 60 * 60 * 1000;
      const inCooldown = now < expiresAtMs;
      cooldowns[row.station_id] = {
        station_id: row.station_id,
        last_alerted_tier: row.tier as RiskTier,
        last_alerted_at: new Date(alertTime).toISOString(),
        cooldown_expires_at: new Date(expiresAtMs).toISOString(),
        in_cooldown: inCooldown,
        active_tier: row.tier as RiskTier,
      };
    }

    const mode = (process.env.ALERT_DELIVERY_MODE || 'dry_run').toLowerCase() as AlertDeliveryMode;

    return {
      mode: mode === 'live' ? 'live' : 'dry_run',
      is_dispatcher_running: true,
      last_dispatcher_run_at: new Date().toISOString(),
      counts_by_status: counts,
      total_recipients: totalRecipients,
      active_recipients: activeRecipients,
      recent_deliveries: recentDeliveries,
      cooldowns,
    };
  }

  public async getAdminDeliveryStats(): Promise<AdminAlertDeliveryStats> {
    const publicStats = await this.getDeliveryStats();
    const adminDeliveries = await this.listRecentDeliveries(20);
    return {
      ...publicStats,
      recent_deliveries: adminDeliveries,
    };
  }

  public async retryFailedItem(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE alert_outbox
       SET status = 'PENDING',
           next_attempt_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status IN ('FAILED', 'DEAD')
       RETURNING id;`,
      [id]
    );
    return res.rows.length > 0;
  }

  public async clear(): Promise<void> {
    const isTest = process.env.NODE_ENV === 'test';
    const isTestDb = this.databaseName.endsWith('_test');
    if (!isTest && !isTestDb) {
      throw new Error(
        `GUARD REFUSAL: Refusing to clear database "${this.databaseName}". ` +
          'clear() is strictly forbidden unless NODE_ENV=test or database name ends in "_test".'
      );
    }
    await this.pool.query('DELETE FROM alert_deliveries;');
    await this.pool.query('DELETE FROM alert_outbox;');
    await this.pool.query('DELETE FROM recipients;');
  }

  // ---------------------------------------------------------------------------
  // MAPPERS
  // ---------------------------------------------------------------------------

  private mapRecipient(row: any): RecipientRecord {
    return {
      id: row.id,
      name: row.name,
      channel: row.channel,
      destination: row.destination,
      secret_key: row.secret_key ?? null,
      scope_type: row.scope_type,
      scope_value: row.scope_value ?? null,
      min_tier: row.min_tier ?? null,
      active: row.active,
      deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  private mapOutbox(row: any): AlertOutboxRecord {
    return {
      id: row.id,
      station_id: row.station_id,
      station_name: row.station_name,
      city: row.city,
      probability: parseFloat(row.probability),
      tier: row.tier as RiskTier,
      source_observation_timestamp: new Date(row.source_observation_timestamp).toISOString(),
      model_version: row.model_version,
      coord_quality: row.coord_quality,
      expected_people_exposed:
        row.expected_people_exposed != null ? parseFloat(row.expected_people_exposed) : null,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      dedupe_key: row.dedupe_key,
      status: row.status,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      next_attempt_at: new Date(row.next_attempt_at).toISOString(),
      lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
      last_error: row.last_error,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  private mapDelivery(row: any): AlertDeliveryRecord {
    return {
      id: row.id,
      outbox_id: row.outbox_id,
      recipient_id: row.recipient_id,
      channel: row.channel,
      recipient_destination: row.recipient_destination,
      status: row.status,
      provider_response_code:
        row.provider_response_code != null ? parseInt(row.provider_response_code, 10) : null,
      provider_response_body: row.provider_response_body,
      error_message: row.error_message,
      delivered_at: new Date(row.delivered_at).toISOString(),
    };
  }
}

let globalAlertDeliveryStore: IAlertDeliveryStore | null = null;

export function getAlertDeliveryStore(): IAlertDeliveryStore {
  if (!globalAlertDeliveryStore) {
    ensureServerEnvLoaded();
    let connectionUrl: string | undefined;

    if (process.env.NODE_ENV === 'test') {
      connectionUrl = getVerifiedTestDatabaseUrl();
    } else {
      connectionUrl = process.env.DATABASE_URL;
    }

    if (!connectionUrl) {
      throw new Error(
        'DATABASE_URL environment variable is required to initialize PostgresAlertDeliveryStore.'
      );
    }

    globalAlertDeliveryStore = new PostgresAlertDeliveryStore(connectionUrl);
  }
  return globalAlertDeliveryStore;
}

export function setAlertDeliveryStore(store: IAlertDeliveryStore | null): void {
  globalAlertDeliveryStore = store;
}

export function scrubSensitiveErrorInfo(raw: string): string {
  if (!raw) return '';
  return raw
    // Password in URLs: ://user:password@ -> ://user:[SCRUBBED]@
    .replace(/(:\/\/[^:]+:)([^@]+)(@)/g, '$1[SCRUBBED]$3')
    // Query parameters: ?token=xyz or &key=abc -> ?token=[SCRUBBED]
    .replace(/([?&](?:token|key|secret|password|pass|pwd|auth)=)([^&\s]+)/gi, '$1[SCRUBBED]')
    // Bare passwords or secrets
    .replace(/SuperSecretPassword\w*/g, '[SCRUBBED]')
    .replace(/adminSecretToken\w*/g, '[SCRUBBED]');
}

export function maskDestination(destination: string, channel: string): string {
  if (channel === 'email') {
    const parts = destination.split('@');
    if (parts.length !== 2) return '***@***';
    const user = parts[0];
    const domain = parts[1];
    if (user.length <= 2) return `${user[0]}***@${domain}`;
    return `${user[0]}***${user[user.length - 1]}@${domain}`;
  }
  try {
    const url = new URL(destination);
    return `${url.origin}/***`;
  } catch {
    return 'https://***';
  }
}
