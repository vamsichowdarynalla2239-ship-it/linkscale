import Redis from 'ioredis';
import { logger } from '../utils/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
  lazyConnect: true,
  connectTimeout: 1000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

redis.on('connect', () => {
  logger.info(`[REDIS] Connected to Redis at ${redisUrl}`);
});

redis.on('error', (err) => {
  logger.warn(`[REDIS] Connection error: ${err.message}`);
});

redis.connect().catch((err) => {
  logger.warn(`[REDIS] Initial connect failed: ${err.message}`);
});
