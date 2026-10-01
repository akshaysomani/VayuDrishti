/**
 * Citizen Report Triage Metadata Store
 * ====================================
 * Implements persistent storage for advisory triage records.
 * Uses PostgreSQL as the single source of truth with transactional SKIP LOCKED queue claiming.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeDatabaseUrl } from '../db/migrator';
import { extractDatabaseName, getVerifiedTestDatabaseUrl } from '../db/testDbHelper';
import { ensureServerEnvLoaded } from '../db/envLoader';
import { scrubSensitiveErrorInfo } from './alertDeliveryStore';
import type {
  ReportTriageRecord,
  TriageResult,
  TriageStatus,
  TriageLabel,
} from '../../types/triage';

export interface IReportTriageStore {
  enqueueTriage(reportId: string): Promise<ReportTriageRecord>;
  claimPending(limit?: number, leaseTimeoutMs?: number): Promise<ReportTriageRecord[]>;
  completeTriage(
    reportId: string,
    result: TriageResult,
    categoryMismatch: boolean
  ): Promise<ReportTriageRecord>;
  failTriage(
    reportId: string,
    error: string,
    status?: 'FAILED' | 'UNAVAILABLE'
  ): Promise<ReportTriageRecord>;
  reclaimStuckLeases(): Promise<number>;
  getTriageByReportId(reportId: string): Promise<ReportTriageRecord | null>;
  getTriageByReportIds(reportIds: string[]): Promise<Map<string, ReportTriageRecord>>;
  clear(): Promise<void>;
}

export class PersistentFileReportTriageStore implements IReportTriageStore {
  private memoryStore: Map<string, ReportTriageRecord> = new Map();
  private filePath: string;
  private isPersisting: boolean = false;

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      path.join(process.cwd(), 'src', 'data', 'citizen_reports', 'triage.json');
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, ReportTriageRecord>;
        this.memoryStore.clear();
        for (const [id, record] of Object.entries(data)) {
          this.memoryStore.set(id, record);
        }
      }
    } catch {
      // Fallback to empty store
    }
  }

  private saveToFile(): void {
    if (this.isPersisting) return;
    this.isPersisting = true;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized: Record<string, ReportTriageRecord> = {};
      for (const [id, rec] of this.memoryStore.entries()) {
        serialized[id] = rec;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(serialized, null, 2), 'utf8');
    } catch {
      // Best-effort write
    } finally {
      this.isPersisting = false;
    }
  }

  public async enqueueTriage(reportId: string): Promise<ReportTriageRecord> {
    for (const rec of this.memoryStore.values()) {
      if (rec.report_id === reportId) {
        return { ...rec };
      }
    }

    const now = new Date().toISOString();
    const record: ReportTriageRecord = {
      id: randomUUID(),
      report_id: reportId,
      status: 'PENDING',
      model_name: null,
      model_version: null,
      suggested_label: null,
      confidence: null,
      scores: null,
      category_mismatch: false,
      error: null,
      attempts: 0,
      created_at: now,
      completed_at: null,
      updated_at: now,
      lease_timeout_at: null,
    };

    this.memoryStore.set(record.id, record);
    this.saveToFile();
    return { ...record };
  }

  public async claimPending(limit: number = 1, leaseTimeoutMs: number = 30000): Promise<ReportTriageRecord[]> {
    const nowMs = Date.now();
    const claimed: ReportTriageRecord[] = [];

    for (const rec of this.memoryStore.values()) {
      if (claimed.length >= limit) break;
      const isPending = rec.status === 'PENDING';
      const isExpiredRunning =
        rec.status === 'RUNNING' &&
        rec.lease_timeout_at &&
        new Date(rec.lease_timeout_at).getTime() <= nowMs;

      if ((isPending || isExpiredRunning) && rec.attempts < 3) {
        rec.status = 'RUNNING';
        rec.attempts += 1;
        rec.lease_timeout_at = new Date(nowMs + leaseTimeoutMs).toISOString();
        rec.updated_at = new Date().toISOString();
        claimed.push({ ...rec });
      }
    }

    if (claimed.length > 0) {
      this.saveToFile();
    }
    return claimed;
  }

  public async completeTriage(
    reportId: string,
    result: TriageResult,
    categoryMismatch: boolean
  ): Promise<ReportTriageRecord> {
    let target: ReportTriageRecord | null = null;
    for (const rec of this.memoryStore.values()) {
      if (rec.report_id === reportId) {
        target = rec;
        break;
      }
    }

    const now = new Date().toISOString();
    if (!target) {
      target = {
        id: randomUUID(),
        report_id: reportId,
        status: 'DONE',
        model_name: result.modelName,
        model_version: result.modelVersion,
        suggested_label: result.topLabel,
        confidence: result.confidence,
        scores: result.scores,
        category_mismatch: categoryMismatch,
        error: null,
        attempts: 1,
        created_at: now,
        completed_at: now,
        updated_at: now,
        lease_timeout_at: null,
      };
      this.memoryStore.set(target.id, target);
    } else {
      target.status = 'DONE';
      target.model_name = result.modelName;
      target.model_version = result.modelVersion;
      target.suggested_label = result.topLabel;
      target.confidence = result.confidence;
      target.scores = result.scores;
      target.category_mismatch = categoryMismatch;
      target.completed_at = now;
      target.updated_at = now;
      target.lease_timeout_at = null;
    }

    this.saveToFile();
    return { ...target };
  }

  public async failTriage(
    reportId: string,
    error: string,
    status: 'FAILED' | 'UNAVAILABLE' = 'FAILED'
  ): Promise<ReportTriageRecord> {
    const cleanError = scrubSensitiveErrorInfo(error);
    const now = new Date().toISOString();

    let target: ReportTriageRecord | null = null;
    for (const rec of this.memoryStore.values()) {
      if (rec.report_id === reportId) {
        target = rec;
        break;
      }
    }

    if (!target) {
      target = {
        id: randomUUID(),
        report_id: reportId,
        status,
        model_name: null,
        model_version: null,
        suggested_label: null,
        confidence: null,
        scores: null,
        category_mismatch: false,
        error: cleanError,
        attempts: 1,
        created_at: now,
        completed_at: now,
        updated_at: now,
        lease_timeout_at: null,
      };
      this.memoryStore.set(target.id, target);
    } else {
      target.status = status;
      target.error = cleanError;
      target.completed_at = now;
      target.updated_at = now;
      target.lease_timeout_at = null;
    }

    this.saveToFile();
    return { ...target };
  }

  public async reclaimStuckLeases(): Promise<number> {
    const nowMs = Date.now();
    let count = 0;
    for (const rec of this.memoryStore.values()) {
      if (rec.status === 'RUNNING' && rec.lease_timeout_at) {
        if (new Date(rec.lease_timeout_at).getTime() <= nowMs) {
          rec.status = rec.attempts >= 3 ? 'FAILED' : 'PENDING';
          rec.lease_timeout_at = null;
          rec.updated_at = new Date().toISOString();
          if (rec.status === 'FAILED') {
            rec.error = 'Lease timed out after maximum attempts';
          }
          count++;
        }
      }
    }
    if (count > 0) {
      this.saveToFile();
    }
    return count;
  }

  public async getTriageByReportId(reportId: string): Promise<ReportTriageRecord | null> {
    for (const rec of this.memoryStore.values()) {
      if (rec.report_id === reportId) {
        return { ...rec };
      }
    }
    return null;
  }

  public async getTriageByReportIds(reportIds: string[]): Promise<Map<string, ReportTriageRecord>> {
    const result = new Map<string, ReportTriageRecord>();
    const idSet = new Set(reportIds);
    for (const rec of this.memoryStore.values()) {
      if (idSet.has(rec.report_id)) {
        result.set(rec.report_id, { ...rec });
      }
    }
    return result;
  }

  public async clear(): Promise<void> {
    this.memoryStore.clear();
    this.saveToFile();
  }
}

export class PostgresReportTriageStore implements IReportTriageStore {
  private pool: pg.Pool;
  private databaseName: string;

  constructor(connectionString: string) {
    const normalized = normalizeDatabaseUrl(connectionString);
    this.pool = new pg.Pool({ connectionString: normalized });
    this.databaseName = extractDatabaseName(connectionString);
  }

  private mapRow(row: any): ReportTriageRecord {
    return {
      id: row.id,
      report_id: row.report_id,
      status: row.status as TriageStatus,
      model_name: row.model_name ?? null,
      model_version: row.model_version ?? null,
      suggested_label: (row.suggested_label as TriageLabel) ?? null,
      confidence: row.confidence !== null ? parseFloat(row.confidence) : null,
      scores: row.scores ?? null,
      category_mismatch: Boolean(row.category_mismatch),
      error: row.error ?? null,
      attempts: parseInt(row.attempts, 10) || 0,
      created_at: new Date(row.created_at).toISOString(),
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      updated_at: new Date(row.updated_at).toISOString(),
      lease_timeout_at: row.lease_timeout_at ? new Date(row.lease_timeout_at).toISOString() : null,
    };
  }

  public async enqueueTriage(reportId: string): Promise<ReportTriageRecord> {
    const query = `
      INSERT INTO report_triage (report_id, status)
      VALUES ($1, 'PENDING')
      ON CONFLICT (report_id) DO UPDATE SET updated_at = NOW()
      RETURNING *;
    `;
    const res = await this.pool.query(query, [reportId]);
    return this.mapRow(res.rows[0]);
  }

  public async claimPending(limit: number = 1, leaseTimeoutMs: number = 30000): Promise<ReportTriageRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN;');

      // Concurrency-safe claim using SELECT ... FOR UPDATE SKIP LOCKED
      const selectQuery = `
        SELECT id FROM report_triage
        WHERE (status = 'PENDING' OR (status = 'RUNNING' AND lease_timeout_at <= NOW()))
          AND attempts < 3
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;
      const selectRes = await client.query(selectQuery, [limit]);

      if (selectRes.rows.length === 0) {
        await client.query('COMMIT;');
        return [];
      }

      const ids = selectRes.rows.map((r: { id: string }) => r.id);
      const leaseDeadline = new Date(Date.now() + leaseTimeoutMs);

      const updateQuery = `
        UPDATE report_triage
        SET status = 'RUNNING',
            attempts = attempts + 1,
            lease_timeout_at = $1,
            updated_at = NOW()
        WHERE id = ANY($2::uuid[])
        RETURNING *;
      `;
      const updateRes = await client.query(updateQuery, [leaseDeadline, ids]);

      await client.query('COMMIT;');
      return updateRes.rows.map((row: any) => this.mapRow(row));
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  }

  public async completeTriage(
    reportId: string,
    result: TriageResult,
    categoryMismatch: boolean
  ): Promise<ReportTriageRecord> {
    const query = `
      UPDATE report_triage
      SET status = 'DONE',
          model_name = $2,
          model_version = $3,
          suggested_label = $4,
          confidence = $5,
          scores = $6::jsonb,
          category_mismatch = $7,
          error = NULL,
          completed_at = NOW(),
          updated_at = NOW(),
          lease_timeout_at = NULL
      WHERE report_id = $1
      RETURNING *;
    `;
    const res = await this.pool.query(query, [
      reportId,
      result.modelName,
      result.modelVersion,
      result.topLabel,
      result.confidence,
      JSON.stringify(result.scores),
      categoryMismatch,
    ]);

    if (res.rows.length === 0) {
      // If row did not exist yet, insert directly as DONE
      const insQuery = `
        INSERT INTO report_triage (
          report_id, status, model_name, model_version, suggested_label,
          confidence, scores, category_mismatch, completed_at, updated_at
        ) VALUES ($1, 'DONE', $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW())
        RETURNING *;
      `;
      const insRes = await this.pool.query(insQuery, [
        reportId,
        result.modelName,
        result.modelVersion,
        result.topLabel,
        result.confidence,
        JSON.stringify(result.scores),
        categoryMismatch,
      ]);
      return this.mapRow(insRes.rows[0]);
    }

    return this.mapRow(res.rows[0]);
  }

  public async failTriage(
    reportId: string,
    error: string,
    status: 'FAILED' | 'UNAVAILABLE' = 'FAILED'
  ): Promise<ReportTriageRecord> {
    const cleanError = scrubSensitiveErrorInfo(error);
    const query = `
      UPDATE report_triage
      SET status = $2,
          error = $3,
          completed_at = NOW(),
          updated_at = NOW(),
          lease_timeout_at = NULL
      WHERE report_id = $1
      RETURNING *;
    `;
    const res = await this.pool.query(query, [reportId, status, cleanError]);

    if (res.rows.length === 0) {
      const insQuery = `
        INSERT INTO report_triage (report_id, status, error, completed_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        RETURNING *;
      `;
      const insRes = await this.pool.query(insQuery, [reportId, status, cleanError]);
      return this.mapRow(insRes.rows[0]);
    }

    return this.mapRow(res.rows[0]);
  }

  public async reclaimStuckLeases(): Promise<number> {
    const query = `
      UPDATE report_triage
      SET status = CASE WHEN attempts >= 3 THEN 'FAILED' ELSE 'PENDING' END,
          lease_timeout_at = NULL,
          updated_at = NOW(),
          error = CASE WHEN attempts >= 3 THEN 'Lease timed out after maximum attempts' ELSE error END
      WHERE status = 'RUNNING'
        AND lease_timeout_at <= NOW()
      RETURNING id;
    `;
    const res = await this.pool.query(query);
    return res.rows.length;
  }

  public async getTriageByReportId(reportId: string): Promise<ReportTriageRecord | null> {
    const query = 'SELECT * FROM report_triage WHERE report_id = $1;';
    const res = await this.pool.query(query, [reportId]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  public async getTriageByReportIds(reportIds: string[]): Promise<Map<string, ReportTriageRecord>> {
    const map = new Map<string, ReportTriageRecord>();
    if (reportIds.length === 0) return map;

    const query = 'SELECT * FROM report_triage WHERE report_id = ANY($1::uuid[]);';
    const res = await this.pool.query(query, [reportIds]);
    for (const row of res.rows) {
      const record = this.mapRow(row);
      map.set(record.report_id, record);
    }
    return map;
  }

  public async clear(): Promise<void> {
    const isTest =
      process.env.NODE_ENV === 'test' || this.databaseName.endsWith('_test');
    if (!isTest) {
      throw new Error(
        'clear() is strictly forbidden unless NODE_ENV=test or database name ends in "_test".'
      );
    }
    await this.pool.query('DELETE FROM report_triage;');
  }
}

let globalTriageStore: IReportTriageStore | null = null;

export function getReportTriageStore(customPath?: string): IReportTriageStore {
  if (!globalTriageStore) {
    ensureServerEnvLoaded();
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test' || Boolean(customPath);

    let connectionUrl: string | undefined;

    if (process.env.NODE_ENV === 'test') {
      if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL.trim().length > 0) {
        connectionUrl = getVerifiedTestDatabaseUrl();
      }
    } else {
      connectionUrl = process.env.DATABASE_URL;
    }

    if (connectionUrl && connectionUrl.trim().length > 0) {
      globalTriageStore = new PostgresReportTriageStore(connectionUrl);
    } else {
      if (isProduction) {
        throw new Error(
          'FATAL: DATABASE_URL environment variable is missing in production mode. ' +
            'VayuDrishti requires PostgreSQL as single source of truth for citizen reports and triage.'
        );
      }
      if (!isTest) {
        console.warn(
          '[VayuDrishti Triage Storage Warning] DATABASE_URL is not set. Using local file store for triage development/testing.'
        );
      }
      globalTriageStore = new PersistentFileReportTriageStore(customPath);
    }
  }
  return globalTriageStore;
}

export function setReportTriageStore(store: IReportTriageStore | null): void {
  globalTriageStore = store;
}
