/**
 * Ordered, Idempotent PostgreSQL Migration Runner
 * ==============================================
 * Tracks executed schema migrations in table `schema_migrations`.
 * Applies outstanding SQL migrations sequentially within database transactions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  totalAvailable: number;
}

export function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    new URL(rawUrl);
    return rawUrl;
  } catch {
    const match = rawUrl.match(/^(postgres(?:ql)?:\/\/)([^:]+):(.*)@([^/:]+)(?::(\d+))?(\/.*)?$/);
    if (match) {
      const proto = match[1];
      const user = match[2];
      const pass = match[3];
      const host = match[4];
      const port = match[5];
      const rest = match[6] || '';
      const portPart = port ? `:${port}` : '';
      return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}${portPart}${rest}`;
    }
    return rawUrl;
  }
}

export async function runDatabaseMigrations(
  connectionString?: string,
  migrationsDir?: string
): Promise<MigrationResult> {
  const dbUrl = connectionString || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL environment variable is required to run migrations.');
  }

  const normalizedUrl = normalizeDatabaseUrl(dbUrl);
  const client = new pg.Client({ connectionString: normalizedUrl });
  await client.connect();

  const dir = migrationsDir || path.join(process.cwd(), 'migrations');
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    // 1. Ensure schema_migrations ledger exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Fetch existing migrations
    const existingRes = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC;');
    const appliedSet = new Set<string>(existingRes.rows.map((r: { version: string }) => r.version));

    // 3. Read migration files sorted lexicographically
    if (!fs.existsSync(dir)) {
      throw new Error(`Migrations directory not found: ${dir}`);
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      if (appliedSet.has(file)) {
        alreadyApplied.push(file);
        continue;
      }

      const filePath = path.join(dir, file);
      const sqlContent = fs.readFileSync(filePath, 'utf8');

      // Run each migration in a dedicated transaction
      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW());',
          [file]
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      applied,
      alreadyApplied,
      totalAvailable: files.length,
    };
  } finally {
    await client.end();
  }
}
