/**
 * Citizen Report Metadata Store
 * =============================
 * Implements persistent storage for citizen reports.
 * Follows repository conventions from persistentStore.ts.
 * Supports file persistence for local dev and matches PostgreSQL schema exactly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeDatabaseUrl } from '../db/migrator';
import { extractDatabaseName, getVerifiedTestDatabaseUrl } from '../db/testDbHelper';
import { ensureServerEnvLoaded } from '../db/envLoader';
export { normalizeDatabaseUrl, extractDatabaseName, getVerifiedTestDatabaseUrl };
import type {
  CitizenReportRecord,
  CitizenReportStatus,
} from '../../types/citizenReport';

export interface ReportFilterOptions {
  status?: CitizenReportStatus;
  stationId?: string;
  bbox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  limit?: number;
  offset?: number;
}

export interface ICitizenReportStore {
  insertReport(
    data: Omit<CitizenReportRecord, 'id' | 'created_at' | 'status' | 'moderated_at' | 'moderation_reason'>
  ): Promise<CitizenReportRecord>;
  getReportById(id: string): Promise<CitizenReportRecord | null>;
  listApprovedReports(
    options?: Omit<ReportFilterOptions, 'status'>
  ): Promise<{ reports: CitizenReportRecord[]; total: number }>;
  listReports(
    options?: ReportFilterOptions
  ): Promise<{ reports: CitizenReportRecord[]; total: number }>;
  updateReportStatus(
    id: string,
    status: CitizenReportStatus,
    reason?: string
  ): Promise<CitizenReportRecord | null>;
  findRecentDuplicateHash(
    contentHash: string,
    windowHours?: number
  ): Promise<CitizenReportRecord | null>;
  getReportByImageKey(key: string): Promise<CitizenReportRecord | null>;
  cleanupRejectedReports(
    olderThanDays?: number
  ): Promise<{ deletedCount: number; deletedKeys: string[] }>;
  clear(): Promise<void>;
}

export class PersistentFileReportStore implements ICitizenReportStore {
  private memoryStore: Map<string, CitizenReportRecord> = new Map();
  private filePath: string;
  private isPersisting: boolean = false;

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      path.join(process.cwd(), 'src', 'data', 'citizen_reports', 'reports.json');
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, CitizenReportRecord>;
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
      const serialized: Record<string, CitizenReportRecord> = {};
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

  public async insertReport(
    data: Omit<CitizenReportRecord, 'id' | 'created_at' | 'status' | 'moderated_at' | 'moderation_reason'>
  ): Promise<CitizenReportRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const record: CitizenReportRecord = {
      ...data,
      id,
      status: 'PENDING',
      created_at: now,
      moderated_at: null,
      moderation_reason: null,
    };

    this.memoryStore.set(id, record);
    this.saveToFile();
    return { ...record };
  }

  public async getReportById(id: string): Promise<CitizenReportRecord | null> {
    const record = this.memoryStore.get(id);
    return record ? { ...record } : null;
  }

  public async listApprovedReports(
    options: Omit<ReportFilterOptions, 'status'> = {}
  ): Promise<{ reports: CitizenReportRecord[]; total: number }> {
    return this.listReports({ ...options, status: 'APPROVED' });
  }

  public async listReports(
    options: ReportFilterOptions = {}
  ): Promise<{ reports: CitizenReportRecord[]; total: number }> {
    const { status, stationId, bbox, limit = 50, offset = 0 } = options;

    let items = Array.from(this.memoryStore.values());

    if (status) {
      items = items.filter((r) => r.status === status);
    }

    if (stationId) {
      items = items.filter((r) => r.nearest_station_id === stationId);
    }

    if (bbox && bbox.length === 4) {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      items = items.filter(
        (r) =>
          r.lon >= minLon &&
          r.lon <= maxLon &&
          r.lat >= minLat &&
          r.lat <= maxLat
      );
    }

    // Sort descending by created_at (newest first)
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const total = items.length;
    const paginated = items.slice(offset, offset + limit);

    return {
      reports: paginated.map((r) => ({ ...r })),
      total,
    };
  }

  public async updateReportStatus(
    id: string,
    status: CitizenReportStatus,
    reason?: string
  ): Promise<CitizenReportRecord | null> {
    const record = this.memoryStore.get(id);
    if (!record) return null;

    record.status = status;
    record.moderated_at = new Date().toISOString();
    record.moderation_reason = reason ?? null;

    this.memoryStore.set(id, record);
    this.saveToFile();
    return { ...record };
  }

  public async findRecentDuplicateHash(
    contentHash: string,
    windowHours: number = 24
  ): Promise<CitizenReportRecord | null> {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    for (const record of this.memoryStore.values()) {
      if (record.content_hash === contentHash) {
        const time = new Date(record.created_at).getTime();
        if (time >= cutoff) {
          return { ...record };
        }
      }
    }
    return null;
  }

  public async getReportByImageKey(key: string): Promise<CitizenReportRecord | null> {
    for (const record of this.memoryStore.values()) {
      if (record.image_key === key || record.thumb_key === key) {
        return { ...record };
      }
    }
    return null;
  }

  public async cleanupRejectedReports(
    olderThanDays: number = 7
  ): Promise<{ deletedCount: number; deletedKeys: string[] }> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const deletedKeys: string[] = [];
    let deletedCount = 0;

    for (const [id, record] of this.memoryStore.entries()) {
      if (record.status === 'REJECTED') {
        const modTime = new Date(record.moderated_at || record.created_at).getTime();
        if (modTime <= cutoff) {
          deletedKeys.push(record.image_key, record.thumb_key);
          this.memoryStore.delete(id);
          deletedCount++;
        }
      }
    }

    if (deletedCount > 0) {
      this.saveToFile();
    }

    return { deletedCount, deletedKeys };
  }

  public async clear(): Promise<void> {
    this.memoryStore.clear();
    this.saveToFile();
  }
}

export class PostgresReportStore implements ICitizenReportStore {
  private pool: pg.Pool;
  private databaseName: string;

  constructor(connectionString: string) {
    const normalized = normalizeDatabaseUrl(connectionString);
    this.pool = new pg.Pool({ connectionString: normalized });
    this.databaseName = extractDatabaseName(connectionString);
  }

  private mapRow(row: any): CitizenReportRecord {
    return {
      id: row.id,
      status: row.status,
      category: row.category,
      description: row.description ?? '',
      lat: parseFloat(row.lat),
      lon: parseFloat(row.lon),
      nearest_station_id: row.nearest_station_id ?? null,
      nearest_station_name: row.nearest_station_name ?? null,
      nearest_station_distance_km:
        row.nearest_station_distance_km != null
          ? parseFloat(row.nearest_station_distance_km)
          : null,
      image_key: row.image_key,
      thumb_key: row.thumb_key,
      content_hash: row.content_hash,
      client_timestamp: row.client_timestamp
        ? new Date(row.client_timestamp).toISOString()
        : null,
      created_at: new Date(row.created_at).toISOString(),
      moderated_at: row.moderated_at ? new Date(row.moderated_at).toISOString() : null,
      moderation_reason: row.moderation_reason ?? null,
    };
  }

  public async insertReport(
    data: Omit<CitizenReportRecord, 'id' | 'created_at' | 'status' | 'moderated_at' | 'moderation_reason'>
  ): Promise<CitizenReportRecord> {
    const res = await this.pool.query(
      `INSERT INTO citizen_reports (
        category, description, lat, lon, nearest_station_id, nearest_station_name,
        nearest_station_distance_km, image_key, thumb_key, content_hash, client_timestamp, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')
      RETURNING *;`,
      [
        data.category,
        data.description,
        data.lat,
        data.lon,
        data.nearest_station_id,
        data.nearest_station_name,
        data.nearest_station_distance_km,
        data.image_key,
        data.thumb_key,
        data.content_hash,
        data.client_timestamp,
      ]
    );
    return this.mapRow(res.rows[0]);
  }

  public async getReportById(id: string): Promise<CitizenReportRecord | null> {
    const res = await this.pool.query('SELECT * FROM citizen_reports WHERE id = $1 LIMIT 1;', [
      id,
    ]);
    return res.rows.length > 0 ? this.mapRow(res.rows[0]) : null;
  }

  public async listApprovedReports(
    options: Omit<ReportFilterOptions, 'status'> = {}
  ): Promise<{ reports: CitizenReportRecord[]; total: number }> {
    return this.listReports({ ...options, status: 'APPROVED' });
  }

  public async listReports(
    options: ReportFilterOptions = {}
  ): Promise<{ reports: CitizenReportRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (options.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(options.status);
    }
    if (options.stationId) {
      conditions.push(`nearest_station_id = $${paramIdx++}`);
      params.push(options.stationId);
    }
    if (options.bbox && options.bbox.length === 4) {
      const [minLon, minLat, maxLon, maxLat] = options.bbox;
      conditions.push(
        `lon >= $${paramIdx++} AND lon <= $${paramIdx++} AND lat >= $${paramIdx++} AND lat <= $${paramIdx++}`
      );
      params.push(minLon, maxLon, minLat, maxLat);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await this.pool.query(
      `SELECT COUNT(*) FROM citizen_reports ${whereClause};`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const dataParams = [...params, limit, offset];
    const dataQuery = `SELECT * FROM citizen_reports ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++};`;

    const dataRes = await this.pool.query(dataQuery, dataParams);

    return {
      reports: dataRes.rows.map((r: any) => this.mapRow(r)),
      total,
    };
  }

  public async updateReportStatus(
    id: string,
    status: CitizenReportStatus,
    reason?: string
  ): Promise<CitizenReportRecord | null> {
    const res = await this.pool.query(
      `UPDATE citizen_reports
       SET status = $1, moderated_at = NOW(), moderation_reason = $2
       WHERE id = $3
       RETURNING *;`,
      [status, reason ?? null, id]
    );
    return res.rows.length > 0 ? this.mapRow(res.rows[0]) : null;
  }

  public async findRecentDuplicateHash(
    contentHash: string,
    windowHours: number = 24
  ): Promise<CitizenReportRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM citizen_reports
       WHERE content_hash = $1
         AND created_at >= NOW() - ($2 || ' hours')::INTERVAL
       ORDER BY created_at DESC
       LIMIT 1;`,
      [contentHash, windowHours]
    );
    return res.rows.length > 0 ? this.mapRow(res.rows[0]) : null;
  }

  public async getReportByImageKey(key: string): Promise<CitizenReportRecord | null> {
    const res = await this.pool.query(
      'SELECT * FROM citizen_reports WHERE image_key = $1 OR thumb_key = $1 LIMIT 1;',
      [key]
    );
    return res.rows.length > 0 ? this.mapRow(res.rows[0]) : null;
  }

  public async cleanupRejectedReports(
    olderThanDays: number = 7
  ): Promise<{ deletedCount: number; deletedKeys: string[] }> {
    // Find rejected reports older than retention window
    const selectRes = await this.pool.query(
      `SELECT id, image_key, thumb_key FROM citizen_reports
       WHERE status = 'REJECTED'
         AND (COALESCE(moderated_at, created_at) <= NOW() - ($1 || ' days')::INTERVAL);`,
      [olderThanDays]
    );

    const deletedKeys: string[] = [];
    const idsToDelete: string[] = [];

    for (const row of selectRes.rows) {
      idsToDelete.push(row.id);
      if (row.image_key) deletedKeys.push(row.image_key);
      if (row.thumb_key) deletedKeys.push(row.thumb_key);
    }

    if (idsToDelete.length > 0) {
      await this.pool.query('DELETE FROM citizen_reports WHERE id = ANY($1::uuid[]);', [
        idsToDelete,
      ]);
    }

    return {
      deletedCount: idsToDelete.length,
      deletedKeys,
    };
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
    await this.pool.query('DELETE FROM citizen_reports;');
  }
}

// Canonical exported name per spec
export const PostgresCitizenReportStore = PostgresReportStore;

let globalReportStore: ICitizenReportStore | null = null;

export function getCitizenReportStore(customPath?: string): ICitizenReportStore {
  if (!globalReportStore) {
    ensureServerEnvLoaded();
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test' || Boolean(customPath);

    let connectionUrl: string | undefined;

    if (process.env.NODE_ENV === 'test') {
      // In test mode: strictly read TEST_DATABASE_URL only, no fallback to DATABASE_URL
      if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL.trim().length > 0) {
        connectionUrl = getVerifiedTestDatabaseUrl();
      }
    } else {
      connectionUrl = process.env.DATABASE_URL;
    }

    if (connectionUrl && connectionUrl.trim().length > 0) {
      // Connect to PostgreSQL database as single source of truth
      globalReportStore = new PostgresReportStore(connectionUrl);
    } else {
      if (isProduction) {
        throw new Error(
          'FATAL: DATABASE_URL environment variable is missing in production mode. ' +
            'VayuDrishti requires PostgreSQL as the single source of truth for citizen reports.'
        );
      }
      if (!isTest) {
        console.warn(
          '[VayuDrishti Storage Warning] DATABASE_URL is not set. Using local file store for development/testing.'
        );
      }
      globalReportStore = new PersistentFileReportStore(customPath);
    }
  }
  return globalReportStore;
}

export function setCitizenReportStore(store: ICitizenReportStore): void {
  globalReportStore = store;
}


