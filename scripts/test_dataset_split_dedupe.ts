/**
 * Unit Tests for Dataset Split, Deduplication, and Leakage Invariants (Arm B Probe Rules)
 * ======================================================================================
 * Verifies arithmetic invariants on tiny synthetic fixtures:
 * 1. Stratified split with fixed seed is deterministic and maintains class balance.
 * 2. Heldout test set is NEVER used for training/tuning.
 * 3. Content-hash deduplication detects duplicates and strictly asserts zero overlap (leakage).
 * 4. Synthetic fixture arithmetic only — no accuracy claims.
 */

import crypto from 'node:crypto';

interface LabeledSample {
  id: string;
  hash: string;
  label: 'smoke' | 'fire' | 'clear_normal';
}

/**
 * Deterministic PRNG (Mulberry32) for reproducible seeded shuffling
 */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stratified split into train and heldout test splits with fixed seed
 */
export function stratifiedSplit<T extends { label: string }>(
  items: T[],
  testRatio: number,
  seed: number
): { train: T[]; heldoutTest: T[] } {
  const prng = mulberry32(seed);
  const byClass = new Map<string, T[]>();

  for (const item of items) {
    if (!byClass.has(item.label)) {
      byClass.set(item.label, []);
    }
    byClass.get(item.label)!.push(item);
  }

  const train: T[] = [];
  const heldoutTest: T[] = [];

  for (const [, classItems] of byClass.entries()) {
    // Deterministic shuffle with seed
    const shuffled = [...classItems].sort(() => prng() - 0.5);
    const testCount = Math.max(1, Math.round(shuffled.length * testRatio));
    const testSlice = shuffled.slice(0, testCount);
    const trainSlice = shuffled.slice(testCount);

    heldoutTest.push(...testSlice);
    train.push(...trainSlice);
  }

  return { train, heldoutTest };
}

/**
 * Asserts zero content-hash overlap between training and heldout evaluation sets
 */
export function assertZeroLeakage<T extends { hash: string }>(
  train: T[],
  heldoutTest: T[]
): { overlapCount: number; duplicateHashes: string[] } {
  const trainHashes = new Set(train.map((x) => x.hash));
  const duplicateHashes: string[] = [];

  for (const item of heldoutTest) {
    if (trainHashes.has(item.hash)) {
      duplicateHashes.push(item.hash);
    }
  }

  return {
    overlapCount: duplicateHashes.length,
    duplicateHashes,
  };
}

// -----------------------------------------------------------------------------
// Test Runner
// -----------------------------------------------------------------------------
function runUnitTests() {
  console.log('Running Dataset Split, Deduplication & Leakage Invariant Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.error(`  ✗ FAIL: ${name}`);
    }
  }

  // Generate tiny synthetic fixture: 3 classes, 30 items total
  const fixture: LabeledSample[] = [];
  const classes: Array<'smoke' | 'fire' | 'clear_normal'> = ['smoke', 'fire', 'clear_normal'];
  for (let c = 0; c < classes.length; c++) {
    for (let i = 0; i < 10; i++) {
      const id = `${classes[c]}_${i}`;
      const hash = crypto.createHash('sha256').update(id).digest('hex');
      fixture.push({ id, hash, label: classes[c] });
    }
  }

  // 1. Total count invariant
  assert(fixture.length === 30, 'Fixture contains exactly 30 synthetic samples');

  // 2. Deterministic split reproducibility with seed 42
  const split1 = stratifiedSplit(fixture, 0.3, 42);
  const split2 = stratifiedSplit(fixture, 0.3, 42);
  assert(
    JSON.stringify(split1.heldoutTest.map((x) => x.id)) ===
      JSON.stringify(split2.heldoutTest.map((x) => x.id)),
    'Stratified split with identical seed produces identical partition'
  );

  // 3. Class balance in splits (stratification)
  const heldoutSmoke = split1.heldoutTest.filter((x) => x.label === 'smoke').length;
  const heldoutFire = split1.heldoutTest.filter((x) => x.label === 'fire').length;
  const heldoutClear = split1.heldoutTest.filter((x) => x.label === 'clear_normal').length;
  assert(
    heldoutSmoke === 3 && heldoutFire === 3 && heldoutClear === 3,
    'Stratified split maintains exact 3:3:3 class balance across test partition'
  );
  assert(
    split1.train.length === 21 && split1.heldoutTest.length === 9,
    'Partition sizes strictly satisfy 70/30 split (21 train, 9 heldout)'
  );

  // 4. Zero leakage assertion on clean disjoint split
  const cleanLeakage = assertZeroLeakage(split1.train, split1.heldoutTest);
  assert(cleanLeakage.overlapCount === 0, 'Clean split has strictly 0 hash overlaps between train and heldout');

  // 5. Positive leakage detection when duplicate hash is injected
  const corruptedHeldout = [
    ...split1.heldoutTest,
    { id: 'leaked_sample', hash: split1.train[0].hash, label: 'smoke' as const },
  ];
  const dirtyLeakage = assertZeroLeakage(split1.train, corruptedHeldout);
  assert(
    dirtyLeakage.overlapCount === 1 && dirtyLeakage.duplicateHashes[0] === split1.train[0].hash,
    'assertZeroLeakage successfully intercepts injected duplicate hash (detects leakage)'
  );

  console.log(`\nSplit & Dedupe Invariant Tests Passed: ${passed} | Failed: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

runUnitTests();
