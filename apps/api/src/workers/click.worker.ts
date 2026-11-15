import { prisma } from '../db';
import { logger } from '../utils/logger';
import { queueService, ClickJobPayload } from '../services/queue.service';
import { cacheService } from '../services/cache.service';
import { ConnectionPool, workerPool } from '../utils/pool';

export interface ProcessResult {
  processed: boolean;
  status: 'empty' | 'success' | 'deduplicated' | 'retried' | 'dlq';
  eventId?: string;
  error?: string;
  delayMs?: number;
}

export class ClickWorker {
  private isRunning = false;
  private readonly MAX_RETRIES = 5;
  private pool: ConnectionPool;

  constructor(pool: ConnectionPool = workerPool) {
    this.pool = pool;
  }

  /**
   * Calculates exponential backoff with full jitter (Bug #10 Fix Part 1).
   * Prevents retry storms from hammering downstream dependencies.
   */
  public calculateBackoff(retryCount: number): number {
    const baseDelayMs = 1000; // 1s
    const maxDelayMs = 30000; // 30s
    const exponential = Math.min(baseDelayMs * Math.pow(2, retryCount), maxDelayMs);
    const jitter = Math.floor(Math.random() * 200);
    return exponential + jitter;
  }

  /**
   * Sets dedicated connection pool (Bulkhead pattern, Bug #10 Fix Part 3).
   */
  public setPool(pool: ConnectionPool): void {
    this.pool = pool;
  }

  /**
   * Processes a single click job from the queue.
   * Guarantees exact-once semantics via database unique constraint on eventId
   * and isolated resource execution via dedicated worker connection pool.
   */
  async processJob(job: ClickJobPayload): Promise<ProcessResult> {
    try {
      // 0. Namespace-Isolated Deduplication Check (Module 06 Step 6 Fix)
      // Dedicated namespace (analytics:dedup:<id>) prevents key collision with redirect cache
      const alreadyProcessed = await cacheService.isAnalyticsJobProcessed(job.eventId);
      if (alreadyProcessed) {
        logger.info(`[WORKER:DEDUP] Job ${job.eventId} already processed in dedup cache. Skipping.`);
        return { processed: true, status: 'deduplicated', eventId: job.eventId };
      }

      // 1. Bulkhead Isolated Database Operation (Bug #10 Fix Part 3)
      await this.pool.executeSafe(async () => {
        return await prisma.clickEvent.create({
          data: {
            eventId: job.eventId,
            linkId: job.linkId,
            tenantId: job.tenantId,
            ipHash: job.ipHash,
            userAgent: job.userAgent || null,
            referrer: job.referrer || null,
            clickedAt: new Date(job.timestamp),
          },
        });
      });

      // Mark as processed in dedicated analytics:dedup namespace
      await cacheService.markAnalyticsJobProcessed(job.eventId);

      logger.debug(`[WORKER] Successfully processed click event ${job.eventId} for link ${job.linkId}`);
      return { processed: true, status: 'success', eventId: job.eventId };
    } catch (err: any) {
      // 2. Idempotency Check: Prisma P2002 Unique Constraint Violation
      if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
        logger.warn(`[WORKER:IDEMPOTENT] Duplicate eventId detected: ${job.eventId}. Skipping duplicate insert.`);
        return { processed: true, status: 'deduplicated', eventId: job.eventId };
      }

      // 3. Retry Handling with Exponential Backoff (Bug #10 Fix Part 1)
      const currentRetries = job.retryCount || 0;
      if (currentRetries < this.MAX_RETRIES) {
        job.retryCount = currentRetries + 1;
        const delayMs = this.calculateBackoff(currentRetries);
        logger.warn(`[WORKER:RETRY] Processing failed for ${job.eventId} (${err.message}). Attempt ${job.retryCount}/${this.MAX_RETRIES}. Backing off for ${delayMs}ms`);
        
        // Re-enqueue with exponential backoff delay
        await queueService.enqueueClick(job, delayMs);
        return { processed: false, status: 'retried', eventId: job.eventId, error: err.message, delayMs };
      }

      // 4. Exhausted Retries -> Dead-Letter Queue (DLQ) (Bug #10 Fix Part 2)
      logger.error(`[WORKER:DLQ] Retries exhausted (${this.MAX_RETRIES}/${this.MAX_RETRIES}) for ${job.eventId}. Sending to Dead-Letter Queue.`);
      await queueService.sendToDlq(job, err.message || 'Maximum retries exhausted');
      return { processed: false, status: 'dlq', eventId: job.eventId, error: err.message };
    }
  }

  /**
   * Dequeues and processes the next available job.
   */
  async processNextJob(): Promise<ProcessResult> {
    const job = await queueService.dequeueClick();
    if (!job) {
      return { processed: false, status: 'empty' };
    }
    return await this.processJob(job);
  }

  /**
   * Drains all currently queued jobs (useful for test harnesses and batch workers).
   */
  async drainQueue(limit: number = 100): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];
    let processedCount = 0;

    while (processedCount < limit) {
      const res = await this.processNextJob();
      if (res.status === 'empty') {
        break;
      }
      results.push(res);
      processedCount++;
    }

    return results;
  }

  /**
   * Starts a continuous background worker loop.
   */
  start(pollIntervalMs: number = 100): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('[WORKER] Click background worker started.');

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.processNextJob();
      } catch (err: any) {
        logger.error(`[WORKER] Loop exception: ${err.message}`);
      }
      setTimeout(loop, pollIntervalMs);
    };

    setTimeout(loop, pollIntervalMs);
  }

  /**
   * Stops the worker loop.
   */
  stop(): void {
    this.isRunning = false;
    logger.info('[WORKER] Click background worker stopped.');
  }
}

export const clickWorker = new ClickWorker();
