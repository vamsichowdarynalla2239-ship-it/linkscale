import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
}

interface ClientRecord {
  timestamps: number[];
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator, message } = options;
  const store = new Map<string, ClientRecord>();

  // Periodically cleanup expired records every 60s
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);
      if (record.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, 60_000);
  cleanupInterval.unref(); // Prevent timer from keeping Node process alive

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();

    let record = store.get(key);
    if (!record) {
      record = { timestamps: [] };
      store.set(key, record);
    }

    // Filter out timestamps outside the active sliding window
    record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

    if (record.timestamps.length >= max) {
      const oldestTimestamp = record.timestamps[0];
      const resetTime = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('Retry-After', resetTime);

      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: message || 'Too many requests, please try again later.',
          request_id: req.requestId,
          retry_after_seconds: resetTime,
        },
      });
      return;
    }

    record.timestamps.push(now);
    const remaining = max - record.timestamps.length;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);

    next();
  };
}

// 1. Management API: 30 requests/min per Tenant
export const createLinkRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => req.tenantId || req.ip || 'tenant-anonymous',
  message: 'Tenant rate limit exceeded: maximum 30 link creations per minute.',
});

// 2. Public Redirect: 120 requests/min per IP
export const redirectRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req: Request) => req.ip || req.socket.remoteAddress || 'ip-anonymous',
  message: 'Public redirect rate limit exceeded: maximum 120 redirects per minute.',
});
