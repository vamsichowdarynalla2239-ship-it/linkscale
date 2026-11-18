import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class CacheService {
  private redisClient: Redis | null = null;
  private isConnected = false;
  private simulatedOutage = false;
  private memoryStore = new Map<string, { value: string; expiresAt: number }>();

  constructor(redisUrl?: string) {
    const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.redisClient = new Redis(url, {
        family: 0,
        lazyConnect: true,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times <= 3 ? Math.min(times * 500, 2000) : null),
        reconnectOnError: () => false,
      });

      this.redisClient.on('connect', () => {
        this.isConnected = true;
        logger.info(`[CACHE] Connected to Redis at ${url}`);
      });

      this.redisClient.on('error', (err) => {
        this.isConnected = false;
        logger.warn(`[CACHE] Redis connection unavailable: ${err.message}. Graceful fallback active.`);
      });

      // Lazy connect without blocking application boot
      this.redisClient.connect().catch((err) => {
        logger.warn(`[CACHE] Initial Redis connection failed: ${err.message}. Operational fallback active.`);
      });
    } catch (err: any) {
      logger.warn(`[CACHE] Failed to initialize Redis client: ${err.message}`);
    }
  }

  /**
   * Simulates a hard Redis failure for the Redis Down drill.
   */
  public simulateOutage(enable: boolean): void {
    this.simulatedOutage = enable;
    if (enable) {
      logger.warn('[CACHE] Outage simulation ENABLED: all cache calls will fail gracefully to DB.');
    } else {
      logger.info('[CACHE] Outage simulation DISABLED: cache operations restored.');
    }
  }

  /**
   * Public redirect cache lookup (GET /r/:code).
   * Uses isolated namespace: link:redirect:<short_code> (Module 06 Fix).
   */
  public async getRedirectTarget(code: string): Promise<string | null> {
    if (this.simulatedOutage) {
      return null;
    }

    const key = `link:redirect:${code}`;
    const legacyKey = `r:${code}`;

    // 1. Try real Redis cluster
    try {
      if (this.isConnected && this.redisClient) {
        const val = await this.redisClient.get(key) || await this.redisClient.get(legacyKey);
        if (val) return val;
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis GET error for "${key}": ${err.message}. Falling back to DB.`);
    }

    // 2. Local fallback if Redis container is not running on localhost
    const entry = this.memoryStore.get(key) || this.memoryStore.get(legacyKey);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.memoryStore.delete(key);
        this.memoryStore.delete(legacyKey);
        return null;
      }
      return entry.value;
    }

    return null;
  }

  /**
   * Sets redirect resolution cache with TTL + jitter in isolated namespace: link:redirect:<short_code>.
   */
  public async setRedirectTarget(code: string, url: string, ttlSeconds = 3600): Promise<void> {
    if (this.simulatedOutage) {
      return;
    }

    // Add 0-300s jitter to spread out expirations
    const jitter = Math.floor(Math.random() * 300);
    const effectiveTtl = ttlSeconds + jitter;
    const key = `link:redirect:${code}`;
    const legacyKey = `r:${code}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.set(key, url, 'EX', effectiveTtl);
        await this.redisClient.set(legacyKey, url, 'EX', effectiveTtl);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis SET error for "${key}": ${err.message}`);
    }

    const expTime = Date.now() + effectiveTtl * 1000;
    this.memoryStore.set(key, { value: url, expiresAt: expTime });
    this.memoryStore.set(legacyKey, { value: url, expiresAt: expTime });
  }

  /**
   * Evicts public redirect cache immediately upon link update or deletion.
   * Evicts ONLY the link:redirect:<short_code> namespace.
   * Does NOT touch the analytics:dedup namespace.
   */
  public async invalidateRedirectTarget(code: string): Promise<void> {
    const key = `link:redirect:${code}`;
    const legacyKey = `r:${code}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(key, legacyKey);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis DEL error for "${key}": ${err.message}`);
    }

    this.memoryStore.delete(key);
    this.memoryStore.delete(legacyKey);
  }

  /**
   * Deduplication check for analytics queue jobs (Module 06 Fix).
   * Uses isolated namespace: analytics:dedup:<event_or_job_id>
   */
  public async isAnalyticsJobProcessed(jobOrEventId: string): Promise<boolean> {
    if (this.simulatedOutage) {
      return false;
    }

    const key = `analytics:dedup:${jobOrEventId}`;

    try {
      if (this.isConnected && this.redisClient) {
        const val = await this.redisClient.get(key);
        if (val) return true;
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis GET error for "${key}": ${err.message}`);
    }

    const entry = this.memoryStore.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.memoryStore.delete(key);
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Marks analytics job as processed in isolated namespace: analytics:dedup:<event_or_job_id>.
   */
  public async markAnalyticsJobProcessed(jobOrEventId: string, ttlSeconds = 86400): Promise<void> {
    if (this.simulatedOutage) {
      return;
    }

    const key = `analytics:dedup:${jobOrEventId}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.set(key, '1', 'EX', ttlSeconds);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis SET error for "${key}": ${err.message}`);
    }

    this.memoryStore.set(key, {
      value: '1',
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Tenant-scoped link metadata cache lookup (org_scoping twist).
   */
  public async getTenantLink(tenantId: string, linkId: string): Promise<any | null> {
    if (this.simulatedOutage) {
      return null;
    }

    const key = `tenant:${tenantId}:link:${linkId}`;

    try {
      if (this.isConnected && this.redisClient) {
        const raw = await this.redisClient.get(key);
        if (raw) return JSON.parse(raw);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis GET error for "${key}": ${err.message}`);
    }

    const entry = this.memoryStore.get(key);
    if (entry && Date.now() <= entry.expiresAt) {
      return JSON.parse(entry.value);
    }

    return null;
  }

  /**
   * Sets tenant-scoped link metadata cache.
   */
  public async setTenantLink(tenantId: string, linkId: string, data: any, ttlSeconds = 3600): Promise<void> {
    if (this.simulatedOutage) {
      return;
    }

    const key = `tenant:${tenantId}:link:${linkId}`;
    const serialized = JSON.stringify(data);

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.set(key, serialized, 'EX', ttlSeconds);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis SET error for "${key}": ${err.message}`);
    }

    this.memoryStore.set(key, {
      value: serialized,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Evicts tenant-scoped link metadata cache.
   */
  public async invalidateTenantLink(tenantId: string, linkId: string): Promise<void> {
    const key = `tenant:${tenantId}:link:${linkId}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(key);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis DEL error for "${key}": ${err.message}`);
    }

    this.memoryStore.delete(key);
  }

  public getHealthStatus(): 'connected' | 'degraded_fallback' {
    if (this.simulatedOutage) return 'degraded_fallback';
    return this.isConnected ? 'connected' : 'degraded_fallback';
  }

  public async close(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
    }
  }
}

export const cacheService = new CacheService();

