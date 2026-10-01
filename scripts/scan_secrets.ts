/**
 * Ephemeral secret scanner script.
 * Reads secrets from .env at runtime, checks files/directories in-memory.
 * Prints ONLY counts and key names. NEVER prints secret values.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadSecrets(): Array<{ key: string; val: string }> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return [];
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const secrets: Array<{ key: string; val: string }> = [];
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
      // Include non-trivial credentials
      if (
        v.length >= 8 &&
        !['true', 'false', 'dry_run', 'ELEVATED', 'WATCH', 'HIGH', 'http://localhost:5173'].includes(v)
      ) {
        secrets.push({ key: k, val: v });
      }
    }
  }
  return secrets;
}

function scanDirectory(dir: string, secrets: Array<{ key: string; val: string }>): { leaks: number; leakedKeys: string[] } {
  if (!fs.existsSync(dir)) return { leaks: 0, leakedKeys: [] };
  let leaks = 0;
  const leakedKeys = new Set<string>();

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const s of secrets) {
            if (content.includes(s.val)) {
              leaks++;
              leakedKeys.add(s.key);
            }
          }
        } catch {
          // ignore binary read failures
        }
      }
    }
  }

  walk(dir);
  return { leaks, leakedKeys: Array.from(leakedKeys) };
}

const targetDir = process.argv[2] || 'dist';
const secrets = loadSecrets();
console.log(`Loaded ${secrets.length} secret keys from .env for in-memory scan.`);

const result = scanDirectory(targetDir, secrets);
console.log(`Scan target: ${targetDir}`);
console.log(`Total secret value matches found: ${result.leaks}`);
if (result.leakedKeys.length > 0) {
  console.log(`Leaked key names: ${result.leakedKeys.join(', ')}`);
  process.exit(1);
} else {
  console.log('CLEAN: No secret values detected in target.');
}
