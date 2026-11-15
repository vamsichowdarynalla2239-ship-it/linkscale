import { prisma } from '../db';
import { logger } from '../utils/logger';
import { queueService, ClickJobPayload } from '../services/queue.service';

export interface ProcessResult {
  processed: boolean;
  status: 'empty' | 'success' | 'deduplicated' | 'retried' | 'dlq';
  eventId?: string;
  error?: string;
}

export class ClickWorker {
  private isRunning = false;
  private readonly MAX_RETRIES = 3;

  /**
   * Processes a single click job from the queue.
   * Guarantees exact-once semantics via database unique constraint on eventId.
   */
  async processJob(job: ClickJobPayload): Promise<ProcessResult> {
    try {
      // 1. Database-level idempotent insert
      await prisma.clickEvent.create({
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

      logger.debug(`[WORKER] Successfully processed click event ${job.eventId} for link ${job.linkId}`);
      return { processed: true, status: 'success', eventId: job.eventId };
    } catch (err: any) {
      // 2. Idempotency Check: Prisma P2002 Unique Constraint Violation
      if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
        logger.warn(`[WORKER:IDEMPOTENT] Duplicate eventId detected: ${job.eventId}. Skipping duplicate insert.`);
        return { processed: true, status: 'deduplicated', eventId: job.eventId };
      }

      // 3. Retry Handling with Exponential Backoff
      const currentRetries = job.retryCount || 0;
      if (currentRetries < this.MAX_RETRIES) {
        job.retryCount = currentRetries + 1;
        logger.warn(`[WORKER:RETRY] Processing failed for ${job.eventId} (${err.message}). Attempt ${job.retryCount}/${this.MAX_RETRIES}`);
        
        // Re-enqueue for retry
        await queueService.enqueueClick(job);
        return { processed: false, status: 'retried', eventId: job.eventId, error: err.message };
      }

      // 4. Exhausted Retries -> Dead-Letter Queue (DLQ)
      logger.error(`[WORKER:DLQ] Retries exhausted for ${job.eventId}. Sending to Dead-Letter Queue.`);
      await queueService.sendToDlq(job, err.message || 'Unknown processing error');
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
