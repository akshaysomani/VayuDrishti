/**
 * Wildfire-Domain Sanity Check (Arm 0 - Zero-Shot Baseline)
 * =========================================================
 * Evaluates LocalClipTriageProvider on a seeded random sample (50 positive, 50 negative)
 * from local wildfire smoke datasets (D-Fire).
 *
 * IMPORTANT: Labeled explicitly as:
 * "wildfire-domain sanity check, not representative of Indian urban scenes"
 * NOT an accuracy claim for the production VayuDrishti triage module.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalClipTriageProvider } from '../src/server/services/triageProvider';

interface ManifestItem {
  dataset: string;
  filename: string;
  path: string;
  ground_truth: 'positive' | 'negative';
  expected_category: string;
}

async function runSanityCheck() {
  console.log('================================================================');
  console.log('WILDFIRE-DOMAIN SANITY CHECK (Arm 0: Zero-Shot CLIP Baseline)');
  console.log('Note: Wildfire-domain sanity check, not representative of Indian urban scenes.');
  console.log('================================================================\n');

  const manifestPath = path.join(process.cwd(), 'scratch', 'sanity_eval', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('Manifest not found at:', manifestPath);
    process.exit(1);
  }

  const manifest: ManifestItem[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Loaded ${manifest.length} evaluation images (seed: 42).`);

  const provider = new LocalClipTriageProvider({
    cacheDir: path.join(process.cwd(), '.model_cache', 'transformers'),
  });

  let truePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;

  const results: any[] = [];
  const startAll = Date.now();

  for (const item of manifest) {
    if (!fs.existsSync(item.path)) continue;
    const buf = fs.readFileSync(item.path);
    const start = Date.now();
    const result = await provider.classify(buf);
    const elapsed = Date.now() - start;

    const isSmokeOrFire = result.topLabel === 'smoke' || result.topLabel === 'fire';

    if (item.ground_truth === 'positive') {
      if (isSmokeOrFire) {
        truePositives++;
      } else {
        falseNegatives++;
      }
    } else {
      if (isSmokeOrFire) {
        falsePositives++;
      } else {
        trueNegatives++;
      }
    }

    results.push({
      file: item.filename,
      truth: item.ground_truth,
      predicted: result.topLabel,
      confidence: result.confidence,
      elapsedMs: elapsed,
    });
  }

  const totalPos = truePositives + falseNegatives;
  const totalNeg = trueNegatives + falsePositives;
  const recall = totalPos > 0 ? (truePositives / totalPos) : 0;
  const fpr = totalNeg > 0 ? (falsePositives / totalNeg) : 0;
  const totalTimeMs = Date.now() - startAll;

  console.log('\n--- SANITY CHECK RESULTS ---');
  console.log(`Domain:                  Wildfire Smoke/Fire Dataset (D-Fire test split)`);
  console.log(`Evaluated Sample:        ${results.length} images (${totalPos} positive, ${totalNeg} negative)`);
  console.log(`Smoke/Fire TP:           ${truePositives}`);
  console.log(`Smoke/Fire FN:           ${falseNegatives}`);
  console.log(`Negative TN:             ${trueNegatives}`);
  console.log(`Negative FP:             ${falsePositives}`);
  console.log(`Smoke/Fire Recall:       ${(recall * 100).toFixed(1)}% (${truePositives}/${totalPos})`);
  console.log(`False-Positive Rate:     ${(fpr * 100).toFixed(1)}% (${falsePositives}/${totalNeg})`);
  console.log(`Mean Inference Time:     ${(totalTimeMs / results.length).toFixed(1)} ms/image`);
  console.log('\nDISCLAIMER:');
  console.log('wildfire-domain sanity check, not representative of Indian urban scenes.');
  console.log('Fog, haze, and construction dust cannot be learned or evaluated from these datasets.');
  console.log('================================================================\n');

  // Clean up scratch files
  try {
    const scratchDir = path.join(process.cwd(), 'scratch', 'sanity_eval');
    fs.rmSync(scratchDir, { recursive: true, force: true });
    console.log('Cleaned up scratch evaluation images.');
  } catch {}
}

runSanityCheck().catch((err) => {
  console.error('Fatal Sanity Check Error:', err);
  process.exit(1);
});
