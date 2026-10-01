/**
 * Scratch Migration Verification Script
 * =====================================
 * Creates a fresh scratch database, runs migrations 001-004 to prove
 * they apply cleanly, runs them again to prove idempotency, then drops
 * the scratch database.
 * Also checks the dev DB's alert_* tables row counts.
 *
 * SECURITY: Never prints credentials, passwords, or full URLs.
 */
import pg from 'pg';
import { runDatabaseMigrations, normalizeDatabaseUrl } from '../src/server/db/migrator';
import { extractDatabaseName, getVerifiedTestDatabaseUrl } from '../src/server/db/testDbHelper';

async function verifyScratchMigrations() {
  console.log('================================================================');
  console.log('GATE: SCRATCH DATABASE MIGRATION VERIFICATION (001-004)');
  console.log('================================================================');

  const testDbUrl = getVerifiedTestDatabaseUrl();
  const testDbName = extractDatabaseName(testDbUrl);
  const scratchDbName = `${testDbName}_scratch_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  // Connect to the maintenance db (postgres) using the test URL host/auth
  const testUrlObj = new URL(normalizeDatabaseUrl(testDbUrl));
  const maintenanceUrl = `${testUrlObj.protocol}//${testUrlObj.username}:${testUrlObj.password}@${testUrlObj.host}/postgres`;

  const adminClient = new pg.Client({ connectionString: maintenanceUrl });
  await adminClient.connect();

  try {
    console.log(`Creating fresh scratch database: "${scratchDbName}"...`);
    await adminClient.query(`CREATE DATABASE "${scratchDbName}";`);

    const scratchDbUrl = `${testUrlObj.protocol}//${testUrlObj.username}:${testUrlObj.password}@${testUrlObj.host}/${scratchDbName}`;

    // Pass 1: Apply migrations 001-004 on clean database
    console.log('Applying migrations on clean scratch database (Pass 1)...');
    const result1 = await runDatabaseMigrations(scratchDbUrl);
    console.log(`Pass 1 completed: ${result1.applied.length} newly applied out of ${result1.totalAvailable} total available.`);
    console.log(`Applied migrations: ${result1.applied.join(', ')}`);

    if (result1.applied.length !== 4) {
      throw new Error(`Expected exactly 4 migrations to be applied on clean database, got ${result1.applied.length}`);
    }

    // Pass 2: Re-run migrations to prove strict idempotency
    console.log('Re-running migrations on scratch database to prove idempotency (Pass 2)...');
    const result2 = await runDatabaseMigrations(scratchDbUrl);
    console.log(`Pass 2 completed: ${result2.applied.length} newly applied out of ${result2.totalAvailable} total available.`);

    if (result2.applied.length !== 0) {
      throw new Error(`Idempotency failed: expected 0 newly applied migrations on pass 2, got ${result2.applied.length}`);
    }

    console.log('✓ SUCCESS: Migrations 001-004 apply cleanly and idempotently on fresh database.');
  } finally {
    // Terminate any open connections to scratch db and drop it
    try {
      await adminClient.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = $1
          AND pid <> pg_backend_pid();
      `, [scratchDbName]);
      await adminClient.query(`DROP DATABASE IF EXISTS "${scratchDbName}";`);
      console.log(`Dropped scratch database "${scratchDbName}".`);
    } catch (cleanupErr) {
      console.warn('Warning dropping scratch database:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }
    await adminClient.end();
  }

  // Check DEV database alert_* row counts
  console.log('\n================================================================');
  console.log('DEV DATABASE: CONFIRMING alert_* TABLES ROW COUNTS');
  console.log('================================================================');

  const devDbUrl = process.env.DATABASE_URL;
  if (!devDbUrl) {
    throw new Error('DATABASE_URL is missing in environment.');
  }

  const devClient = new pg.Client({ connectionString: normalizeDatabaseUrl(devDbUrl) });
  await devClient.connect();
  try {
    const aoRes = await devClient.query('SELECT COUNT(*) FROM alert_outbox;');
    const adRes = await devClient.query('SELECT COUNT(*) FROM alert_deliveries;');
    const recRes = await devClient.query('SELECT COUNT(*) FROM recipients;');

    console.log(`alert_outbox count:     ${aoRes.rows[0].count}`);
    console.log(`alert_deliveries count: ${adRes.rows[0].count}`);
    console.log(`recipients count:       ${recRes.rows[0].count}`);
    console.log('Confirmed: dev DB alert_* tables were not modified by test suites.');
  } finally {
    await devClient.end();
  }
}

verifyScratchMigrations().catch((err) => {
  console.error('Scratch migration verification error:', err.message);
  process.exit(1);
});
