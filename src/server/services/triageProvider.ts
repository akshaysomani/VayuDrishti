/**
 * Report Triage Provider Interface & Implementations (Phase 5 f3b)
 * ================================================================
 * Server-side zero-shot image classification for citizen reports.
 * Privacy & Safety Policy:
 * 1. Runs strictly locally in Node via ONNX runtime.
 * 2. NEVER transmits photo data to any external API or cloud vision service.
 * 3. Classifies only the re-encoded, EXIF-stripped image buffer.
 * 4. Model cache directory is git-ignored.
 * 5. If model is unavailable, missing, or offline, fails safely to UNAVAILABLE status.
 */

import * as path from 'node:path';
import type { TriageLabel, TriageResult } from '../../types/triage';
import { TRIAGE_LABEL_PROMPTS } from '../../types/triage';

export interface ReportTriageProvider {
  readonly name: string;
  readonly version: string;
  readonly arm: string;
  classify(imageBuffer: Buffer): Promise<TriageResult>;
}

export class ModelUnavailableError extends Error {
  public readonly code = 'MODEL_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * Local Zero-Shot CLIP Provider
 * Uses @huggingface/transformers running locally via ONNX Runtime.
 */
export class LocalClipTriageProvider implements ReportTriageProvider {
  public readonly name: string;
  public readonly version: string;
  public readonly revision: string;
  public readonly arm: string = 'arm_0_zero_shot';
  private modelId: string;
  private classifierPromise: Promise<any> | null = null;
  private cacheDir: string;

  constructor(options?: {
    modelId?: string;
    version?: string;
    revision?: string;
    cacheDir?: string;
  }) {
    this.modelId = options?.modelId || process.env.TRIAGE_MODEL_NAME || 'Xenova/clip-vit-base-patch32';
    this.revision = options?.revision || process.env.TRIAGE_MODEL_REVISION || 'd15189d7028b43f1d3e65039190477f6af591c2a';
    this.name = `LocalCLIP(${this.modelId})`;
    this.version = options?.version || `1.0.0-${this.revision.slice(0, 7)}`;
    this.cacheDir =
      options?.cacheDir ||
      process.env.TRIAGE_MODEL_CACHE_DIR ||
      path.join(process.cwd(), '.model_cache', 'transformers');
  }

  private async getClassifier(): Promise<any> {
    if (!this.classifierPromise) {
      this.classifierPromise = (async () => {
        try {
          const { pipeline, env } = await import('@huggingface/transformers');
          env.cacheDir = this.cacheDir;
          // When running in production or offline mode, localFilesOnly can be honored if configured
          if (process.env.TRIAGE_LOCAL_FILES_ONLY === 'true') {
            env.localModelPath = this.cacheDir;
            env.allowRemoteModels = false;
          } else {
            env.allowRemoteModels = true;
            env.localModelPath = this.cacheDir;
          }

          const pipe = await pipeline(
            'zero-shot-image-classification',
            this.modelId,
            {
              device: 'cpu',
              revision: this.revision,
            }
          );
          return pipe;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new ModelUnavailableError(
            `Failed to load local zero-shot classification model "${this.modelId}": ${msg}`
          );
        }
      })();
    }
    return this.classifierPromise;
  }

  public async classify(imageBuffer: Buffer): Promise<TriageResult> {
    let classifier: any;
    try {
      classifier = await this.getClassifier();
    } catch (err) {
      if (err instanceof ModelUnavailableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ModelUnavailableError(`Classifier initialization failed: ${msg}`);
    }

    try {
      const { RawImage } = await import('@huggingface/transformers');
      const sharpModule = await import('sharp');
      const sharp = sharpModule.default;

      // Preprocess image buffer with Sharp to exact 224x224 sRGB 3-channel raw bytes
      // This ensures camera rotation is honored, alpha channel is removed, and prevents libvips colorspace/resize issues
      const { data, info } = await sharp(imageBuffer)
        .rotate()
        .resize(224, 224, { fit: 'fill' })
        .removeAlpha()
        .toColorspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });

      const rawImage = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);

      const labels = Object.keys(TRIAGE_LABEL_PROMPTS) as TriageLabel[];
      const candidatePrompts = labels.map((l) => TRIAGE_LABEL_PROMPTS[l]);

      // Map prompt string back to canonical TriageLabel
      const promptToLabel = new Map<string, TriageLabel>();
      labels.forEach((l) => {
        promptToLabel.set(TRIAGE_LABEL_PROMPTS[l], l);
      });

      const output = await classifier(rawImage, candidatePrompts);

      // output is array of { label: string, score: number }
      const rawScores: Record<TriageLabel, number> = {
        smoke: 0,
        fire: 0,
        haze_fog: 0,
        dust: 0,
        clear_normal: 0,
        not_relevant: 0,
      };

      if (Array.isArray(output)) {
        for (const item of output) {
          const label = promptToLabel.get(item.label);
          if (label && typeof item.score === 'number') {
            rawScores[label] = item.score;
          }
        }
      }

      // Normalize scores to sum to 1.0
      const sum = Object.values(rawScores).reduce((a, b) => a + b, 0) || 1.0;
      const scores: Record<TriageLabel, number> = {
        smoke: rawScores.smoke / sum,
        fire: rawScores.fire / sum,
        haze_fog: rawScores.haze_fog / sum,
        dust: rawScores.dust / sum,
        clear_normal: rawScores.clear_normal / sum,
        not_relevant: rawScores.not_relevant / sum,
      };

      // Select top label
      let topLabel: TriageLabel = 'clear_normal';
      let maxConfidence = -1;
      for (const [lbl, score] of Object.entries(scores) as [TriageLabel, number][]) {
        if (score > maxConfidence) {
          maxConfidence = score;
          topLabel = lbl;
        }
      }

      return {
        topLabel,
        confidence: maxConfidence,
        scores,
        modelName: this.name,
        modelVersion: this.version,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Inference execution failed on image buffer: ${msg}`);
    }
  }
}

/**
 * Deterministic Stub Provider for Test Plumbing & Mocking
 * Guarantees zero network calls and deterministic results for automated test suites.
 */
export class StubTriageProvider implements ReportTriageProvider {
  public readonly name: string = 'StubZeroShotModel';
  public readonly version: string = '1.0.0-stub';
  public readonly arm: string = 'arm_0_zero_shot';

  private presetResult: Partial<TriageResult> | null = null;
  private shouldThrow: Error | null = null;

  constructor(preset?: Partial<TriageResult>, errorToThrow?: Error) {
    this.presetResult = preset ?? null;
    this.shouldThrow = errorToThrow ?? null;
  }

  public setPreset(preset: Partial<TriageResult> | null): void {
    this.presetResult = preset;
  }

  public setThrow(err: Error | null): void {
    this.shouldThrow = err;
  }

  public async classify(_imageBuffer: Buffer): Promise<TriageResult> {
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }

    if (this.presetResult && this.presetResult.topLabel) {
      const top = this.presetResult.topLabel;
      const conf = this.presetResult.confidence ?? 0.88;
      const remaining = Math.max(0, (1.0 - conf) / 5);

      const baseScores: Record<TriageLabel, number> = {
        smoke: remaining,
        fire: remaining,
        haze_fog: remaining,
        dust: remaining,
        clear_normal: remaining,
        not_relevant: remaining,
        ...(this.presetResult.scores ?? {}),
      };
      baseScores[top] = conf;

      return {
        topLabel: top,
        confidence: conf,
        scores: baseScores,
        modelName: this.presetResult.modelName || this.name,
        modelVersion: this.presetResult.modelVersion || this.version,
      };
    }

    // Default deterministic result: high confidence 'smoke'
    return {
      topLabel: 'smoke',
      confidence: 0.88,
      scores: {
        smoke: 0.88,
        fire: 0.04,
        haze_fog: 0.04,
        dust: 0.02,
        clear_normal: 0.01,
        not_relevant: 0.01,
      },
      modelName: this.name,
      modelVersion: this.version,
    };
  }
}

let activeProvider: ReportTriageProvider | null = null;

export function getTriageProvider(): ReportTriageProvider {
  if (!activeProvider) {
    const isTest = process.env.NODE_ENV === 'test';
    if (isTest || process.env.TRIAGE_USE_STUB === 'true') {
      activeProvider = new StubTriageProvider();
    } else {
      activeProvider = new LocalClipTriageProvider();
    }
  }
  return activeProvider;
}

export function setTriageProvider(provider: ReportTriageProvider | null): void {
  activeProvider = provider;
}
