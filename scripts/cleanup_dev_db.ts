/**
 * Item 8: Safe Dev Database Cleanup Script
 * ========================================
 * Safely inspects the DEV database (DATABASE_URL) and removes ONLY obvious
 * integration test artifact rows, preserving all ambiguous rows for review.
 *
 * SECURITY: Never logs or prints credentials, tokens, or DATABASE_URL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { DiskImageStorage } from '../src/server/storage/imageStorage';
import { normalizeDatabaseUrl } from '../src/server/db/migrator';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        let v = trimmed.slice(eqIdx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
}
loadEnv();

async function runCleanup() {
  const devDbUrl = process.env.DATABASE_URL;
  if (!devDbUrl) {
    console.error('FATAL: DATABASE_URL is missing in environment.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: normalizeDatabaseUrl(devDbUrl) });
  const storage = new DiskImageStorage();

  try {
    console.log('================================================================');
    console.log('DEV DATABASE CLEANUP: INITIAL COUNTS (DATABASE_URL)');
    console.log('================================================================');

    const crBefore = parseInt((await pool.query('SELECT COUNT(*) FROM citizen_reports;')).rows[0].count, 10);
    const rtBefore = parseInt((await pool.query('SELECT COUNT(*) FROM report_triage;')).rows[0].count, 10);
    const aoBefore = parseInt((await pool.query('SELECT COUNT(*) FROM alert_outbox;')).rows[0].count, 10);
    const adBefore = parseInt((await pool.query('SELECT COUNT(*) FROM alert_deliveries;')).rows[0].count, 10);
    const recBefore = parseInt((await pool.query('SELECT COUNT(*) FROM recipients;')).rows[0].count, 10);

    console.log(`citizen_reports:   ${crBefore}`);
    console.log(`report_triage:     ${rtBefore}`);
    console.log(`alert_outbox:      ${aoBefore}`);
    console.log(`alert_deliveries:  ${adBefore}`);
    console.log(`recipients:        ${recBefore}`);
    console.log('----------------------------------------------------------------\n');

    const reportsRes = await pool.query(`
      SELECT id, status, category, description, content_hash, nearest_station_id, image_key, thumb_key, created_at
      FROM citizen_reports
      ORDER BY created_at ASC;
    `);

    console.log(`Examining ${reportsRes.rows.length} rows in citizen_reports:\n`);

    const toDelete: typeof reportsRes.rows = [];
    const ambiguous: Array<{ id: string; status: string; created_at: string; reason: string }> = [];

    for (const row of reportsRes.rows) {
      const desc = row.description || '';
      const descSample = desc.slice(0, 40).replace(/[\r\n]+/g, ' ');
      const hash = row.content_hash || '';

      // Narrow, conservative test markers matching prompt specifications:
      // - description containing "integration test", "test harness", or "fixture"
      // - content_hash starting with "testhash" or "test_"
      const isTestDesc = /integration test|test harness|fixture test/i.test(desc);
      const isTestHash = /^testhash|^test_/i.test(hash);

      const isClearTestMarker = isTestDesc || isTestHash;

      console.log(`ID:          ${row.id}`);
      console.log(`Status:      ${row.status}`);
      console.log(`Category:    ${row.category}`);
      console.log(`Created:     ${new Date(row.created_at).toISOString()}`);
      console.log(`Description: "${descSample}"`);
      console.log(`Test Marker: ${isClearTestMarker ? 'YES (matches test pattern)' : 'NO'}`);
      console.log('----------------------------------------------------------------');

      if (isClearTestMarker) {
        toDelete.push(row);
      } else {
        ambiguous.push({
          id: row.id,
          status: row.status,
          created_at: new Date(row.created_at).toISOString(),
          reason: 'No obvious test markers found in description or content_hash.',
        });
      }
    }

    console.log(`\nIdentified ${toDelete.length} obvious test row(s) for safe deletion.`);
    console.log(`Identified ${ambiguous.length} ambiguous row(s) left untouched for Akshay.\n`);

    // Perform narrow, safe deletion ONLY for clear test markers
    for (const row of toDelete) {
      // 1. Delete image files using storage abstraction
      if (row.image_key) {
        try {
          await storage.deleteImage(row.image_key);
        } catch {}
      }
      if (row.thumb_key) {
        try {
          await storage.deleteImage(row.thumb_key);
        } catch {}
      }

      // 2. Delete report_triage row
      await pool.query('DELETE FROM report_triage WHERE report_id = $1;', [row.id]);

      // 3. Delete citizen_reports row
      await pool.query('DELETE FROM citizen_reports WHERE id = $1;', [row.id]);
    }

    console.log('================================================================');
    console.log('DEV DATABASE CLEANUP: COUNTS AFTER CLEANUP');
    console.log('================================================================');

    const crAfter = parseInt((await pool.query('SELECT COUNT(*) FROM citizen_reports;')).rows[0].count, 10);
    const rtAfter = parseInt((await pool.query('SELECT COUNT(*) FROM report_triage;')).rows[0].count, 10);
    const aoAfter = parseInt((await pool.query('SELECT COUNT(*) FROM alert_outbox;')).rows[0].count, 10);
    const adAfter = parseInt((await pool.query('SELECT COUNT(*) FROM alert_deliveries;')).rows[0].count, 10);
    const recAfter = parseInt((await pool.query('SELECT COUNT(*) FROM recipients;')).rows[0].count, 10);

    console.log(`citizen_reports:   ${crAfter} (was ${crBefore})`);
    console.log(`report_triage:     ${rtAfter} (was ${rtBefore})`);
    console.log(`alert_outbox:      ${aoAfter} (was ${aoBefore}, untouched)`);
    console.log(`alert_deliveries:  ${adAfter} (was ${adBefore}, untouched)`);
    console.log(`recipients:        ${recAfter} (was ${recBefore}, untouched)`);
    console.log('================================================================\n');

    if (ambiguous.length > 0) {
      console.log('AMBIGUOUS ROWS LEFT UNTOUCHED:');
      for (const a of ambiguous) {
        console.log(`- ID: ${a.id} | Status: ${a.status} | CreatedAt: ${a.created_at} (${a.reason})`);
      }
    } else {
      console.log('Zero ambiguous rows left in citizen_reports.');
    }
  } finally {
    await pool.end();
  }
}

runCleanup().catch((err) => {
  console.error('Cleanup error:', err.message);
  process.exit(1);
});
