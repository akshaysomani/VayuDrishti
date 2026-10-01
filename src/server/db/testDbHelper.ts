/**
 * Test Database Isolation & Safety Helper
 * =======================================
 * Ensures all automated tests that touch PostgreSQL strictly and exclusively
 * connect to the isolated test database (TEST_DATABASE_URL ending in "_test").
 *
 * Rules:
 * 1. TEST_DATABASE_URL must be set and non-empty.
 * 2. Database name must end in "_test".
 * 3. Database name must NEVER equal the dev database name (DATABASE_URL).
 * 4. Zero fallback to DATABASE_URL under any circumstances.
 * 5. Runs migrations against the test database on startup.
 * 6. Truncates only test database tables between suites.
 *
 * SECURITY: Never logs or prints credentials to console or output.
 */

import pg from 'pg';
import { normalizeDatabaseUrl, runDatabaseMigrations } from './migrator';

/**
 * Extracts database name from connection URL.
 * Handles both standard URLs and URLs with parameters (e.g. ?schema=public).
 */
export function extractDatabaseName(urlStr: string): string {
  try {
    const normalized = normalizeDatabaseUrl(urlStr);
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/^\/+/, '');
    if (pathname) {
      return decodeURIComponent(pathname);
    }
  } catch {
    const match = urlStr.match(/\/([^/?#]+)(?:\?.*)?$/);
    if (match && match[1]) {
      return match[1];
    }
  }
  throw new Error('Unable to extract database name from connection string.');
}

/**
 * Validates and returns TEST_DATABASE_URL.
 * Throws immediately if invalid, with zero fallback to DATABASE_URL.
 */
export function getVerifiedTestDatabaseUrl(): string {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl || testDbUrl.trim().length === 0) {
    throw new Error(
      'FATAL TEST ISOLATION ERROR: TEST_DATABASE_URL is missing in environment. ' +
        'Tests touching PostgreSQL must strictly run against an isolated test database. ' +
        'Fallback to DATABASE_URL is strictly forbidden.'
    );
  }

  const testDbName = extractDatabaseName(testDbUrl);

  // Guard against pointing to the development database
  const devDbUrl = process.env.DATABASE_URL;
  if (devDbUrl && devDbUrl.trim().length > 0) {
    try {
      const devDbName = extractDatabaseName(devDbUrl);
      if (testDbName === devDbName) {
        throw new Error(
          `FATAL TEST ISOLATION ERROR: TEST_DATABASE_URL points to the development database "${testDbName}". ` +
            'Test database name must never equal the dev database name.'
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('FATAL TEST ISOLATION ERROR')) {
        throw err;
      }
    }
  }

  // Guard: Database name must strictly end in "_test"
  if (!testDbName.endsWith('_test')) {
    throw new Error(
      `FATAL TEST ISOLATION ERROR: TEST_DATABASE_URL database name "${testDbName}" does not end in "_test". ` +
        'Automated tests are only permitted to execute against a database whose name ends in "_test".'
    );
  }

  return testDbUrl;
}

/**
 * Truncates tables in the test database.
 * Refuses to run if the database name does not end in "_test".
 */
export async function truncateTestDatabase(dbUrl?: string): Promise<void> {
  const targetUrl = dbUrl || getVerifiedTestDatabaseUrl();
  const dbName = extractDatabaseName(targetUrl);

  if (!dbName.endsWith('_test')) {
    throw new Error(
      `REFUSING TRUNCATE: Database "${dbName}" does not end in "_test". ` +
        'Truncation is strictly forbidden on non-test databases.'
    );
  }

  const normalized = normalizeDatabaseUrl(targetUrl);
  const client = new pg.Client({ connectionString: normalized });
  await client.connect();
  try {
    await client.query('TRUNCATE TABLE citizen_reports, report_triage, alert_deliveries, alert_outbox, recipients CASCADE;');
  } catch {
    // If migration 002/003 hasn't run yet in some context, fall back to citizen_reports
    await client.query('TRUNCATE TABLE citizen_reports CASCADE;');
  } finally {
    await client.end();
  }
}

/**
 * Prepares the test database:
 * 1. Validates test database isolation rules.
 * 2. Runs schema migrations to ensure schema is fully up to date.
 * 3. Truncates tables to provide a clean state.
 */
export async function prepareTestDatabase(): Promise<{
  testDbUrl: string;
  testDbName: string;
}> {
  const testDbUrl = getVerifiedTestDatabaseUrl();
  const testDbName = extractDatabaseName(testDbUrl);

  // 1. Run migrations against the test database using the existing migration runner
  await runDatabaseMigrations(testDbUrl);

  // 2. Clean test tables
  await truncateTestDatabase(testDbUrl);

  return { testDbUrl, testDbName };
}
