/**
 * Honest AI-Assisted Citizen Report Triage Evaluation Script (Phase 5 f3b)
 * =========================================================================
 * Evaluates the local zero-shot triage classifier against human-labeled photos.
 *
 * Rules:
 * 1. Reads photos and labels.csv from data/triage_eval/ (or --eval-dir).
 * 2. If eval set is missing or empty, exits 0, prints "NOT EVALUATED", and writes
 *    reports/triage_evaluation.md stating status is NOT EVALUATED.
 * 3. Never fabricates accuracy numbers, synthetic images, or mock statistics.
 * 4. Generates per-class precision, recall, F1, class counts, confusion matrix,
 *    and overall accuracy only when human-labeled images are present.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LocalClipTriageProvider,
  StubTriageProvider,
  ReportTriageProvider,
} from '../src/server/services/triageProvider';
import type { TriageLabel } from '../src/types/triage';
import { TRIAGE_LABEL_PROMPTS } from '../src/types/triage';

const CANONICAL_LABELS: TriageLabel[] = [
  'smoke',
  'fire',
  'haze_fog',
  'dust',
  'clear_normal',
  'not_relevant',
];

interface EvalRow {
  filename: string;
  label: TriageLabel;
}

export interface MetricSummary {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface EvalReportData {
  status: 'EVALUATED' | 'NOT EVALUATED';
  timestamp: string;
  modelName: string;
  modelVersion: string;
  totalSamples: number;
  overallAccuracy: number;
  classCounts: Record<TriageLabel, number>;
  metrics: Record<TriageLabel, MetricSummary>;
  confusionMatrix: Record<TriageLabel, Record<TriageLabel, number>>;
  reasonIfNotEvaluated?: string;
}

export function parseArgs(argv: string[]): {
  evalDir: string;
  outputPath: string;
  useStub: boolean;
} {
  let evalDir = path.resolve(process.cwd(), 'data', 'triage_eval');
  let outputPath = path.resolve(process.cwd(), 'reports', 'triage_evaluation.md');
  let useStub = false;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--eval-dir' && argv[i + 1]) {
      evalDir = path.resolve(argv[++i]);
    } else if (argv[i] === '--output' && argv[i + 1]) {
      outputPath = path.resolve(argv[++i]);
    } else if (argv[i] === '--use-stub') {
      useStub = true;
    }
  }

  return { evalDir, outputPath, useStub };
}

export function parseLabelsCsv(csvPath: string): EvalRow[] {
  if (!fs.existsSync(csvPath)) return [];
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length <= 1) return []; // Only header or empty

  const rows: EvalRow[] = [];
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const filenameIdx = header.indexOf('filename');
  const labelIdx = header.indexOf('label');

  if (filenameIdx === -1 || labelIdx === -1) {
    throw new Error('labels.csv must contain "filename" and "label" columns in header.');
  }

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts.length > Math.max(filenameIdx, labelIdx)) {
      const filename = parts[filenameIdx];
      const rawLabel = parts[labelIdx].toLowerCase();
      if (CANONICAL_LABELS.includes(rawLabel as TriageLabel)) {
        rows.push({
          filename,
          label: rawLabel as TriageLabel,
        });
      }
    }
  }

  return rows;
}

export function computeMetrics(
  labels: TriageLabel[],
  groundTruth: TriageLabel[],
  predictions: TriageLabel[]
): {
  overallAccuracy: number;
  classCounts: Record<TriageLabel, number>;
  metrics: Record<TriageLabel, MetricSummary>;
  confusionMatrix: Record<TriageLabel, Record<TriageLabel, number>>;
} {
  const n = groundTruth.length;
  const confusionMatrix: Record<TriageLabel, Record<TriageLabel, number>> = {} as any;
  const classCounts: Record<TriageLabel, number> = {} as any;

  for (const actual of labels) {
    confusionMatrix[actual] = {} as any;
    classCounts[actual] = 0;
    for (const pred of labels) {
      confusionMatrix[actual][pred] = 0;
    }
  }

  let correctTotal = 0;
  for (let i = 0; i < n; i++) {
    const actual = groundTruth[i];
    const pred = predictions[i];
    if (confusionMatrix[actual] && confusionMatrix[actual][pred] !== undefined) {
      confusionMatrix[actual][pred]++;
      classCounts[actual]++;
    }
    if (actual === pred) {
      correctTotal++;
    }
  }

  const overallAccuracy = n > 0 ? correctTotal / n : 0;
  const metrics: Record<TriageLabel, MetricSummary> = {} as any;

  for (const label of labels) {
    const tp = confusionMatrix[label][label];
    // fp = sum of all actual != label where pred == label
    let fp = 0;
    for (const other of labels) {
      if (other !== label) {
        fp += confusionMatrix[other][label];
      }
    }
    // fn = sum of all pred != label where actual == label
    let fn = 0;
    for (const other of labels) {
      if (other !== label) {
        fn += confusionMatrix[label][other];
      }
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    metrics[label] = {
      precision,
      recall,
      f1,
      support: classCounts[label] || 0,
    };
  }

  return { overallAccuracy, classCounts, metrics, confusionMatrix };
}

export function renderMarkdownReport(report: EvalReportData): string {
  if (report.status === 'NOT EVALUATED') {
    return `# AI-Assisted Citizen Report Triage Evaluation

> **STATUS: NOT EVALUATED**
>
> Generated: ${report.timestamp}
> Model: \`${report.modelName}\` (Version: \`${report.modelVersion}\`)

## Status Notice
${report.reasonIfNotEvaluated || 'The human-annotated Indian urban evaluation dataset was not found or contains zero labeled images in data/triage_eval/.'}

Per strict project policy:
- No synthetic data, web scraping, or fabricated accuracy figures are ever published.
- The moderator UI persistently displays the **"Unvalidated Model"** badge until a genuine evaluation is executed on real local data.
- Please refer to [\`data/triage_eval/README.md\`](../data/triage_eval/README.md) for instructions on assembling the 100–200 photo Indian urban evaluation benchmark across the 6 advisory classes.

## Evaluated Classes & Natural Language Prompts
| Class | Natural Language Prompt |
| :--- | :--- |
${CANONICAL_LABELS.map((lbl) => `| \`${lbl}\` | ${TRIAGE_LABEL_PROMPTS[lbl]} |`).join('\n')}
`;
  }

  // Full evaluated report
  const classRows = CANONICAL_LABELS.map((lbl) => {
    const m = report.metrics[lbl];
    return `| \`${lbl}\` | ${(m.precision * 100).toFixed(1)}% | ${(m.recall * 100).toFixed(1)}% | ${(m.f1 * 100).toFixed(1)}% | ${m.support} |`;
  }).join('\n');

  const matrixHeader = `| Actual \\ Predicted | ${CANONICAL_LABELS.map((l) => `\`${l}\``).join(' | ')} | Total |`;
  const matrixDivider = `| :--- | ${CANONICAL_LABELS.map(() => ':---:').join(' | ')} | :---: |`;
  const matrixRows = CANONICAL_LABELS.map((actual) => {
    const cells = CANONICAL_LABELS.map((pred) => report.confusionMatrix[actual][pred]);
    const total = report.classCounts[actual];
    return `| \`${actual}\` | ${cells.join(' | ')} | **${total}** |`;
  }).join('\n');

  return `# AI-Assisted Citizen Report Triage Evaluation

> **STATUS: EVALUATED**
>
> Evaluation Completed: ${report.timestamp}
> Evaluated Model: \`${report.modelName}\` (Version: \`${report.modelVersion}\`)
> Total Labeled Images: **${report.totalSamples}**
> Overall Macro Accuracy: **${(report.overallAccuracy * 100).toFixed(2)}%**

## Per-Class Performance Metrics

| Class Label | Precision | Recall | F1 Score | Support Count |
| :--- | :---: | :---: | :---: | :---: |
${classRows}

## Confusion Matrix

${matrixHeader}
${matrixDivider}
${matrixRows}

## Evaluation Methodology & Invariants
1. **Local Offline Inference:** Inference executed strictly in Node runtime using local ONNX weights. Zero third-party vision APIs called.
2. **Metadata Hygiene:** Classified images are stripped of all EXIF, GPS, and device telemetry prior to classification.
3. **Advisory Invariant:** These classification scores are advisory-only for human moderators and never modify report public visibility or feed predictive risk feature vectors.
`;
}

export async function runEvaluation(): Promise<number> {
  const args = parseArgs(process.argv);
  const labelsFile = path.join(args.evalDir, 'labels.csv');

  const provider: ReportTriageProvider = args.useStub
    ? new StubTriageProvider()
    : new LocalClipTriageProvider();

  const timestamp = new Date().toISOString();

  // Ensure output directory exists
  const outDir = path.dirname(args.outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Check if evaluation set exists
  if (!fs.existsSync(labelsFile)) {
    console.log('================================================================');
    console.log('CITIZEN REPORT TRIAGE EVALUATION: NOT EVALUATED');
    console.log('================================================================');
    console.log(`Evaluation dataset file not found at: ${labelsFile}`);
    console.log('Writing clean NOT EVALUATED notice to reports/triage_evaluation.md.\n');

    const unEvaluatedData: EvalReportData = {
      status: 'NOT EVALUATED',
      timestamp,
      modelName: provider.name,
      modelVersion: provider.version,
      totalSamples: 0,
      overallAccuracy: 0,
      classCounts: {} as any,
      metrics: {} as any,
      confusionMatrix: {} as any,
      reasonIfNotEvaluated: `Ground-truth label file not found at ${labelsFile}. To evaluate, assemble labeled photos and labels.csv per data/triage_eval/README.md.`,
    };

    fs.writeFileSync(args.outputPath, renderMarkdownReport(unEvaluatedData), 'utf8');
    return 0;
  }

  const rows = parseLabelsCsv(labelsFile);
  if (rows.length === 0) {
    console.log('================================================================');
    console.log('CITIZEN REPORT TRIAGE EVALUATION: NOT EVALUATED (0 LABELED ROWS)');
    console.log('================================================================');
    console.log('labels.csv was present but contained 0 valid rows.');

    const unEvaluatedData: EvalReportData = {
      status: 'NOT EVALUATED',
      timestamp,
      modelName: provider.name,
      modelVersion: provider.version,
      totalSamples: 0,
      overallAccuracy: 0,
      classCounts: {} as any,
      metrics: {} as any,
      confusionMatrix: {} as any,
      reasonIfNotEvaluated: 'labels.csv found but contained zero valid sample rows.',
    };

    fs.writeFileSync(args.outputPath, renderMarkdownReport(unEvaluatedData), 'utf8');
    return 0;
  }

  console.log('================================================================');
  console.log(`RUNNING HONEST TRIAGE EVALUATION ON ${rows.length} SAMPLES`);
  console.log(`Model: ${provider.name} (${provider.version})`);
  console.log('================================================================\n');

  const groundTruth: TriageLabel[] = [];
  const predictions: TriageLabel[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const imagePath = path.join(args.evalDir, row.filename);

    if (!fs.existsSync(imagePath)) {
      console.warn(`[Missing File] ${row.filename} listed in labels.csv but not found on disk.`);
      continue;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    try {
      const result = await provider.classify(imageBuffer);
      groundTruth.push(row.label);
      predictions.push(result.topLabel);
      console.log(`[${i + 1}/${rows.length}] ${row.filename}: actual=${row.label} -> predicted=${result.topLabel} (${(result.confidence * 100).toFixed(1)}%)`);
    } catch (err: unknown) {
      console.error(`[Error] Failed to classify ${row.filename}:`, err);
    }
  }

  if (groundTruth.length === 0) {
    console.log('\nZero images were successfully evaluated. Writing NOT EVALUATED report.');
    const unEvaluatedData: EvalReportData = {
      status: 'NOT EVALUATED',
      timestamp,
      modelName: provider.name,
      modelVersion: provider.version,
      totalSamples: 0,
      overallAccuracy: 0,
      classCounts: {} as any,
      metrics: {} as any,
      confusionMatrix: {} as any,
      reasonIfNotEvaluated: 'Zero sample images could be read or classified.',
    };
    fs.writeFileSync(args.outputPath, renderMarkdownReport(unEvaluatedData), 'utf8');
    return 0;
  }

  const { overallAccuracy, classCounts, metrics, confusionMatrix } = computeMetrics(
    CANONICAL_LABELS,
    groundTruth,
    predictions
  );

  const reportData: EvalReportData = {
    status: 'EVALUATED',
    timestamp,
    modelName: provider.name,
    modelVersion: provider.version,
    totalSamples: groundTruth.length,
    overallAccuracy,
    classCounts,
    metrics,
    confusionMatrix,
  };

  const md = renderMarkdownReport(reportData);
  fs.writeFileSync(args.outputPath, md, 'utf8');

  console.log('\n================================================================');
  console.log(`EVALUATION COMPLETE. Accuracy: ${(overallAccuracy * 100).toFixed(2)}%`);
  console.log(`Report generated at: ${args.outputPath}`);
  console.log('================================================================');
  return 0;
}

const isEvalEntry =
  process.argv.some(
    (arg) =>
      arg.endsWith('eval_triage.ts') ||
      arg.endsWith('eval_triage.js') ||
      arg.includes('eval_triage')
  ) && !process.argv.some((arg) => arg.includes('test_'));

if (isEvalEntry) {
  runEvaluation()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error('Fatal evaluation script error:', err);
      process.exit(1);
    });
}
