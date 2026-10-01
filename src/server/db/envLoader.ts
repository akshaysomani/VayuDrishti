import fs from 'node:fs';
import path from 'node:path';

/**
 * Ensures variables from root .env are loaded into Node's process.env.
 * Required because Vite dev server/middleware executes in Node, but Vite
 * only injects VITE_* variables into client-side import.meta.env by default.
 *
 * Security: Never prints or logs environment values.
 */
export function ensureServerEnvLoaded(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
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
          if (process.env[k] === undefined) {
            process.env[k] = v;
          }
        }
      }
    }
  } catch {
    // Fail silently in non-filesystem environments
  }
}

// Auto-run on import
ensureServerEnvLoaded();
