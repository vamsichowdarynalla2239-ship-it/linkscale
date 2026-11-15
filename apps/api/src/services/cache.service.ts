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
        lazyConnect: true,
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Never hang on connection failure
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
   * Returns cached destination URL or null on miss/outage.
   */
  public async getRedirectTarget(code: string): Promise<string | null> {
    if (this.simulatedOutage) {
      return null;
    }

    const key = `r:${code}`;

    // 1. Try real Redis cluster
    try {
      if (this.isConnected && this.redisClient) {
        const val = await this.redisClient.get(key);
        if (val) return val;
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis GET error for "${key}": ${err.message}. Falling back to DB.`);
    }

    // 2. Local fallback if Redis container is not running on localhost
    const entry = this.memoryStore.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.memoryStore.delete(key);
        return null;
      }
      return entry.value;
    }

    return null;
  }

  /**
   * Sets redirect resolution cache with TTL + jitter to prevent thundering herd.
   */
  public async setRedirectTarget(code: string, url: string, ttlSeconds = 3600): Promise<void> {
    if (this.simulatedOutage) {
      return;
    }

    // Add 0-300s jitter to spread out expirations
    const jitter = Math.floor(Math.random() * 300);
    const effectiveTtl = ttlSeconds + jitter;
    const key = `r:${code}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.set(key, url, 'EX', effectiveTtl);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis SET error for "${key}": ${err.message}`);
    }

    this.memoryStore.set(key, {
      value: url,
      expiresAt: Date.now() + effectiveTtl * 1000,
    });
  }

  /**
   * Evicts public redirect cache immediately upon link update or deletion.
   */
  public async invalidateRedirectTarget(code: string): Promise<void> {
    const key = `r:${code}`;

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(key);
      }
    } catch (err: any) {
      logger.warn(`[CACHE] Redis DEL error for "${key}": ${err.message}`);
    }

    this.memoryStore.delete(key);
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

