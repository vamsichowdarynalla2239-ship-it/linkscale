import Redis from 'ioredis';
import { logger } from '../utils/logger';

export interface ClickJobPayload {
  eventId: string;
  linkId: string;
  tenantId: string;
  ipHash: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  timestamp: string;
  retryCount?: number;
}

export interface DlqItem {
  job: ClickJobPayload;
  failedAt: string;
  reason: string;
}

export class QueueService {
  private redisClient: Redis | null = null;
  private isConnected = false;
  private simulatedOutage = false;
  private memoryQueue: ClickJobPayload[] = [];
  private memoryDlq: DlqItem[] = [];

  private readonly QUEUE_KEY = 'queue:clicks';
  private readonly DLQ_KEY = 'queue:clicks:dlq';

  constructor(redisUrl?: string) {
    const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redisClient = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        reconnectOnError: () => false,
      });

      this.redisClient.on('connect', () => {
        this.isConnected = true;
        logger.info(`[QUEUE] Connected to Redis queue broker at ${url}`);
      });

      this.redisClient.on('error', (err) => {
        this.isConnected = false;
        logger.warn(`[QUEUE] Redis broker connection unavailable: ${err.message}. In-memory fallback active.`);
      });

      this.redisClient.connect().catch((err) => {
        logger.warn(`[QUEUE] Initial Redis broker connect failed: ${err.message}. Operational fallback active.`);
      });
    } catch (err: any) {
      logger.warn(`[QUEUE] Failed to initialize Redis queue client: ${err.message}`);
    }
  }

  /**
   * Outage simulation toggle for Queue-Down drills.
   */
  public simulateOutage(enable: boolean): void {
    this.simulatedOutage = enable;
    if (enable) {
      logger.warn('[QUEUE] Outage simulation ENABLED: all enqueue operations will fail gracefully.');
    } else {
      logger.info('[QUEUE] Outage simulation DISABLED: queue operations restored.');
    }
  }

  /**
   * Enqueues a click event job onto the queue with optional backoff delay.
   * If the queue is down, catches error and returns false without throwing (Graceful Degradation).
   */
  public async enqueueClick(job: ClickJobPayload, delayMs: number = 0): Promise<boolean> {
    if (this.simulatedOutage) {
      logger.warn(`[QUEUE] Outage active: dropped click job ${job.eventId} gracefully.`);
      return false;
    }

    if (delayMs > 0) {
      setTimeout(async () => {
        await this.enqueueClick(job, 0);
      }, delayMs);
      return true;
    }

    try {
      if (this.redisClient && this.isConnected) {
        await this.redisClient.lpush(this.QUEUE_KEY, JSON.stringify(job));
        logger.debug(`[QUEUE] Enqueued click job ${job.eventId} to Redis queue`);
        return true;
      }
    } catch (err: any) {
      logger.warn(`[QUEUE] Redis lpush failed: ${err.message}. Falling back to memory queue.`);
    }

    // In-memory reliable fallback
    this.memoryQueue.push(job);
    logger.debug(`[QUEUE] Enqueued click job ${job.eventId} to in-memory queue`);
    return true;
  }

  /**
   * Dequeues the next click event job.
   */
  public async dequeueClick(): Promise<ClickJobPayload | null> {
    if (this.simulatedOutage) {
      return null;
    }

    try {
      if (this.redisClient && this.isConnected) {
        const raw = await this.redisClient.rpop(this.QUEUE_KEY);
        if (raw) {
          return JSON.parse(raw);
        }
      }
    } catch (err: any) {
      logger.warn(`[QUEUE] Redis rpop failed: ${err.message}`);
    }

    return this.memoryQueue.shift() || null;
  }

  /**
   * Routes a failed job to the Dead-Letter Queue (DLQ) after retries are exhausted.
   */
  public async sendToDlq(job: ClickJobPayload, reason: string): Promise<void> {
    const item: DlqItem = {
      job,
      failedAt: new Date().toISOString(),
      reason,
    };

    logger.error(`[QUEUE:DLQ] Job ${job.eventId} routed to DLQ. Reason: ${reason}`);

    try {
      if (this.redisClient && this.isConnected) {
        await this.redisClient.lpush(this.DLQ_KEY, JSON.stringify(item));
        return;
      }
    } catch (err: any) {
      logger.warn(`[QUEUE:DLQ] Failed to write to Redis DLQ: ${err.message}`);
    }

    this.memoryDlq.push(item);
  }

  /**
   * Returns current pending queue length.
   */
  public async getQueueLength(): Promise<number> {
    try {
      if (this.redisClient && this.isConnected) {
        return await this.redisClient.llen(this.QUEUE_KEY);
      }
    } catch {
      // Fallback
    }
    return this.memoryQueue.length;
  }

  /**
   * Returns DLQ item count.
   */
  public async getDlqLength(): Promise<number> {
    try {
      if (this.redisClient && this.isConnected) {
        return await this.redisClient.llen(this.DLQ_KEY);
      }
    } catch {
      // Fallback
    }
    return this.memoryDlq.length;
  }

  /**
   * Clears queue and DLQ (useful for test isolation).
   */
  public async clear(): Promise<void> {
    try {
      if (this.redisClient && this.isConnected) {
        await this.redisClient.del(this.QUEUE_KEY, this.DLQ_KEY);
      }
    } catch {
      // Ignore
    }
    this.memoryQueue = [];
    this.memoryDlq = [];
  }
}

export const queueService = new QueueService();
