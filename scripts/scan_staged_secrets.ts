/**
 * Scan git staged diff for runtime secrets from .env
 * SECURITY: Never prints secrets; reports counts and key names only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

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

const secrets = loadSecrets();
console.log(`Loaded ${secrets.length} secret keys from .env.`);

const stagedDiff = execSync('git diff --cached', { encoding: 'utf8' });
let leaks = 0;
const leakedKeys = new Set<string>();

for (const s of secrets) {
  if (stagedDiff.includes(s.val)) {
    leaks++;
    leakedKeys.add(s.key);
  }
}

console.log(`Staged diff size: ${stagedDiff.length} characters.`);
console.log(`Secret matches found in staged diff: ${leaks}`);
if (leakedKeys.size > 0) {
  console.error(`FATAL: Staged files contain secret values for keys: ${Array.from(leakedKeys).join(', ')}`);
  process.exit(1);
} else {
  console.log('✓ CLEAN: Zero secrets found in staged diff.');
}
