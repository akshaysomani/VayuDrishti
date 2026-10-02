/**
 * Machine-Generated Automated Test Suite Runner & Baseline Guard
 * =============================================================
 * Runs all VayuDrishti test suites as isolated child processes,
 * captures outputs, extracts deterministic assertion counts,
 * enforces non-regression against committed test_baseline.json,
 * and formats a clean verification table.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

interface SuiteConfig {
  name: string;
  script: string;
}

interface SuiteResult {
  name: string;
  script: string;
  passed: number;
  failed: number;
  total: number;
  baseline: number;
  exitCode: number | null;
  error?: string;
}

const SUITES: SuiteConfig[] = [
  { name: 'Live Alerts', script: 'scripts/test_live_alerts.ts' },
  { name: 'Citizen Reports', script: 'scripts/test_citizen_reports.ts' },
  { name: 'PostgreSQL Store', script: 'scripts/test_postgres_store.ts' },
  { name: 'HTTP Integration', script: 'scripts/test_http_integration.ts' },
  { name: 'Alert Delivery', script: 'scripts/test_alert_delivery.ts' },
  { name: 'Citizen Triage', script: 'scripts/test_triage.ts' },
  { name: 'Rainfall Data', script: 'scripts/test_rainfall_data.ts' },
];

function loadBaseline(): Record<string, number> {
  const baselinePath = path.resolve(process.cwd(), 'test_baseline.json');
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`test_baseline.json not found at ${baselinePath}`);
  }
  const raw = fs.readFileSync(baselinePath, 'utf8');
  const parsed = JSON.parse(raw);
  const map: Record<string, number> = {};
  for (const [suiteName, info] of Object.entries(parsed.suites as Record<string, any>)) {
    map[suiteName] = info.baseline_total;
  }
  return map;
}

function runSuite(suite: SuiteConfig, baseline: number): Promise<SuiteResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = isWindows
      ? spawn('cmd.exe', ['/c', `npx -y vite-node ${suite.script}`], {
          cwd: process.cwd(),
          env: { ...process.env },
          shell: false,
        })
      : spawn('npx', ['-y', 'vite-node', suite.script], {
          cwd: process.cwd(),
          env: { ...process.env },
          shell: false,
        });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });

    child.on('close', (code) => {
      // Regex parses: "TOTAL ... PASSED: <N> | FAILED: <N>"
      // Covers: "TOTAL: 73 | PASSED: 73 | FAILED: 0", "TOTAL TESTS: 73 | ...", etc.
      const match = output.match(/TOTAL(?:\s+TESTS)?:?\s+(\d+)\s+\|\s+PASSED:\s+(\d+)\s+\|\s+FAILED:\s+(\d+)/i);

      if (!match) {
        return resolve({
          name: suite.name,
          script: suite.script,
          passed: 0,
          failed: 1,
          total: 0,
          baseline,
          exitCode: code,
          error: 'Could not parse totals line from suite output',
        });
      }

      const total = parseInt(match[1], 10);
      const passed = parseInt(match[2], 10);
      const failed = parseInt(match[3], 10);

      resolve({
        name: suite.name,
        script: suite.script,
        passed,
        failed,
        total,
        baseline,
        exitCode: code,
      });
    });

    child.on('error', (err) => {
      resolve({
        name: suite.name,
        script: suite.script,
        passed: 0,
        failed: 1,
        total: 0,
        baseline,
        exitCode: -1,
        error: err.message,
      });
    });
  });
}

function formatTable(results: SuiteResult[]): string {
  const colWidths = {
    name: 20,
    script: 34,
    passed: 8,
    failed: 8,
    total: 8,
  };

  const header =
    '| ' +
    'Suite Name'.padEnd(colWidths.name) +
    ' | ' +
    'Script File'.padEnd(colWidths.script) +
    ' | ' +
    'Passed'.padStart(colWidths.passed) +
    ' | ' +
    'Failed'.padStart(colWidths.failed) +
    ' | ' +
    'Total'.padStart(colWidths.total) +
    ' |';

  const separator =
    '|-' +
    '-'.repeat(colWidths.name) +
    '-|-' +
    '-'.repeat(colWidths.script) +
    '-|-' +
    '-'.repeat(colWidths.passed) +
    '-|-' +
    '-'.repeat(colWidths.failed) +
    '-|-' +
    '-'.repeat(colWidths.total) +
    '-|';

  const rows = results.map((r) => {
    return (
      '| ' +
      r.name.padEnd(colWidths.name) +
      ' | ' +
      r.script.padEnd(colWidths.script) +
      ' | ' +
      String(r.passed).padStart(colWidths.passed) +
      ' | ' +
      String(r.failed).padStart(colWidths.failed) +
      ' | ' +
      String(r.total).padStart(colWidths.total) +
      ' |'
    );
  });

  const totalPassed = results.reduce((acc, r) => acc + r.passed, 0);
  const totalFailed = results.reduce((acc, r) => acc + r.failed, 0);
  const grandTotal = results.reduce((acc, r) => acc + r.total, 0);

  const summaryRow =
    '| ' +
    'TOTAL'.padEnd(colWidths.name) +
    ' | ' +
    'All Suites'.padEnd(colWidths.script) +
    ' | ' +
    String(totalPassed).padStart(colWidths.passed) +
    ' | ' +
    String(totalFailed).padStart(colWidths.failed) +
    ' | ' +
    String(grandTotal).padStart(colWidths.total) +
    ' |';

  return [header, separator, ...rows, separator, summaryRow].join('\n');
}

async function main() {
  console.log('================================================================');
  console.log('VAYU DRISHTI AUTOMATED TEST SUITE RUNNER WITH BASELINE GUARD');
  console.log('================================================================\n');

  const baselineMap = loadBaseline();
  const results: SuiteResult[] = [];
  let hasFailure = false;

  for (const suite of SUITES) {
    const baseline = baselineMap[suite.name] ?? 0;
    process.stdout.write(`Running [${suite.name}] (${suite.script})... `);
    const result = await runSuite(suite, baseline);
    results.push(result);

    if (result.exitCode !== 0 || result.failed > 0 || result.error) {
      console.log('FAILED');
      if (result.error) {
        console.error(`  Error: ${result.error}`);
      }
      hasFailure = true;
    } else if (result.total < baseline) {
      console.log('BASELINE REGRESSION');
      console.error(
        `  Error: Test count (${result.total}) dropped below committed baseline (${baseline})!`
      );
      hasFailure = true;
    } else {
      console.log(`PASSED (${result.passed}/${result.total})`);
    }
  }

  console.log('\n--- TEST SUITE SUMMARY TABLE ---');
  const table = formatTable(results);
  console.log(table);
  console.log('--------------------------------\n');

  if (hasFailure) {
    console.error('FAILED: One or more test suites failed, could not be parsed, or regressed below baseline.');
    process.exit(1);
  }

  console.log('✓ SUCCESS: All suites passed with zero failures and verified against baselines.');
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
