/**
 * CLI Migration Script
 * ====================
 * Usage: npx -y vite-node scripts/migrate.ts
 */

import { runDatabaseMigrations } from '../src/server/db/migrator';

async function main() {
  console.log('Running database migrations...');
  try {
    const result = await runDatabaseMigrations();
    console.log(`✓ Migration run completed. Total migrations: ${result.totalAvailable}`);
    if (result.applied.length > 0) {
      console.log(`  Newly applied: ${result.applied.join(', ')}`);
    } else {
      console.log('  All migrations already up to date.');
    }
  } catch (err) {
    console.error('Migration failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
