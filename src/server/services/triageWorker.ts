/**
 * AI-Assisted Citizen Report Triage Queue Worker (Phase 5 f3b)
 * ============================================================
 * Concurrency-safe queue worker claiming triage jobs using
 * PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Strict Isolation Rules:
 * 1. Runs in the background (Node runtime).
 * 2. Upload requests enqueue PENDING row and return IMMEDIATELY (201).
 * 3. Worker fills results asynchronously.
 * 4. Triage errors (model missing, timeout, bad image, crash) NEVER change report status.
 * 5. Stuck RUNNING leases are safely reclaimed.
 */

import { getCitizenReportStore } from '../storage/reportStore';
import { getImageStorage } from '../storage/imageStorage';
import { getReportTriageStore, IReportTriageStore } from '../storage/triageStore';
import {
  getTriageProvider,
  ReportTriageProvider,
  ModelUnavailableError,
} from './triageProvider';
import { evaluateCategoryMismatch } from '../../types/triage';
import { scrubSensitiveErrorInfo } from '../storage/alertDeliveryStore';

export interface TriageWorkerOptions {
  intervalMs?: number;
  leaseTimeoutMs?: number;
  perImageTimeoutMs?: number;
  maxAttempts?: number;
  mismatchMinConfidence?: number;
  uncertainBelow?: number;
}

export class TriageWorker {
  private store: IReportTriageStore;
  private provider: ReportTriageProvider;
  private intervalMs: number;
  private leaseTimeoutMs: number;
  private perImageTimeoutMs: number;
  private maxAttempts: number;
  private mismatchMinConfidence: number;
  private uncertainBelow: number;

  private isWorking: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options?: TriageWorkerOptions) {
    this.store = getReportTriageStore();
    this.provider = getTriageProvider();
    this.intervalMs = options?.intervalMs ?? 5000;
    this.leaseTimeoutMs = options?.leaseTimeoutMs ?? 30000;
    this.perImageTimeoutMs =
      options?.perImageTimeoutMs ??
      parseInt(process.env.TRIAGE_TIMEOUT_MS || '15000', 10);
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.mismatchMinConfidence =
      options?.mismatchMinConfidence ??
      parseFloat(process.env.TRIAGE_MISMATCH_MIN_CONFIDENCE || '0.60');
    this.uncertainBelow =
      options?.uncertainBelow ??
      parseFloat(process.env.TRIAGE_UNCERTAIN_BELOW || '0.40');
  }

  public setProvider(provider: ReportTriageProvider): void {
    this.provider = provider;
  }

  public setStore(store: IReportTriageStore): void {
    this.store = store;
  }

  /**
   * Concurrency-safe triage cycle.
   * Concurrency 1 per worker instance.
   */
  public async processCycle(): Promise<{
    processed: number;
    completed: number;
    failed: number;
    unavailable: number;
    reclaimed: number;
  }> {
    if (this.isWorking) {
      return { processed: 0, completed: 0, failed: 0, unavailable: 0, reclaimed: 0 };
    }

    this.isWorking = true;
    let processed = 0;
    let completed = 0;
    let failed = 0;
    let unavailable = 0;
    let reclaimed = 0;

    try {
      // 1. Reclaim any stuck leases where worker crashed or stalled
      reclaimed = await this.store.reclaimStuckLeases().catch(() => 0);

      // Check if triage is disabled globally
      if (process.env.TRIAGE_ENABLED === 'false') {
        return { processed: 0, completed: 0, failed: 0, unavailable: 0, reclaimed };
      }

      // 2. Claim pending triage row using SELECT ... FOR UPDATE SKIP LOCKED
      const claimedRows = await this.store.claimPending(1, this.leaseTimeoutMs);
      if (claimedRows.length === 0) {
        return { processed: 0, completed: 0, failed: 0, unavailable: 0, reclaimed };
      }

      const item = claimedRows[0];
      processed++;

      // 3. Retrieve report and image
      const reportStore = getCitizenReportStore();
      const report = await reportStore.getReportById(item.report_id);

      if (!report) {
        // Orphaned triage item (report deleted or missing)
        failed++;
        await this.store.failTriage(
          item.report_id,
          `Report with ID ${item.report_id} not found in store.`
        );
        return { processed, completed, failed, unavailable, reclaimed };
      }

      const imageStorage = getImageStorage();
      const imageItem = await imageStorage.getImage(report.image_key);

      if (!imageItem || !imageItem.buffer) {
        failed++;
        await this.store.failTriage(
          item.report_id,
          `Image buffer for key ${report.image_key} not found.`
        );
        return { processed, completed, failed, unavailable, reclaimed };
      }

      // 4. Run classification with per-image timeout
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `Triage inference timed out after ${this.perImageTimeoutMs}ms`
                )
              ),
            this.perImageTimeoutMs
          );
        });

        // Classify the re-encoded, EXIF-stripped image buffer
        const triageResult = await Promise.race([
          this.provider.classify(imageItem.buffer),
          timeoutPromise,
        ]);

        // 5. Evaluate category mismatch
        const { categoryMismatch } = evaluateCategoryMismatch(
          report.category,
          triageResult.topLabel,
          triageResult.confidence,
          this.mismatchMinConfidence,
          this.uncertainBelow
        );

        // 6. Complete triage record
        await this.store.completeTriage(item.report_id, triageResult, categoryMismatch);
        completed++;
      } catch (classifyErr: unknown) {
        const isModelUnavailable =
          classifyErr instanceof ModelUnavailableError ||
          (classifyErr instanceof Error &&
            classifyErr.message.includes('MODEL_UNAVAILABLE'));

        const errMsg =
          classifyErr instanceof Error ? classifyErr.message : String(classifyErr);
        const scrubbed = scrubSensitiveErrorInfo(errMsg);

        if (isModelUnavailable) {
          unavailable++;
          await this.store.failTriage(item.report_id, scrubbed, 'UNAVAILABLE');
        } else {
          // Increment attempts or fail permanently
          const nextAttempts = item.attempts + 1;
          if (nextAttempts >= this.maxAttempts) {
            failed++;
            await this.store.failTriage(
              item.report_id,
              `Max attempts (${this.maxAttempts}) exceeded: ${scrubbed}`,
              'FAILED'
            );
          } else {
            // Put back into PENDING with error logged
            failed++;
            await this.store.failTriage(
              item.report_id,
              `Attempt ${nextAttempts} failed: ${scrubbed}`,
              'FAILED'
            );
          }
        }
      }

      return { processed, completed, failed, unavailable, reclaimed };
    } finally {
      this.isWorking = false;
    }
  }

  public startWorker(): void {
    if (this.timer) return;
    this.processCycle().catch(() => {});
    this.timer = setInterval(() => {
      this.processCycle().catch(() => {});
    }, this.intervalMs);
  }

  public stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let globalTriageWorker: TriageWorker | null = null;

export function getGlobalTriageWorker(): TriageWorker {
  if (!globalTriageWorker) {
    globalTriageWorker = new TriageWorker();
  }
  return globalTriageWorker;
}

export function setGlobalTriageWorker(worker: TriageWorker | null): void {
  globalTriageWorker = worker;
}
