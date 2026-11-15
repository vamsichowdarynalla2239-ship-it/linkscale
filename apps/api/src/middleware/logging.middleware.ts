import { Request, Response, NextFunction } from 'express';
import { logger, redactSensitiveData } from '../utils/logger';

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  // Log incoming request headers in debug mode (redacted)
  logger.debug(`Incoming ${req.method} ${req.originalUrl || req.url}`, {
    request_id: req.requestId,
    method: req.method,
    route: req.originalUrl || req.url,
    headers: redactSensitiveData(req.headers),
  });

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const latencyNs = Number(end - start);
    const latencyMs = Math.round((latencyNs / 1_000_000) * 100) / 100;

    const logData = {
      request_id: req.requestId,
      method: req.method,
      route: req.originalUrl || req.url,
      status_code: res.statusCode,
      latency_ms: latencyMs,
    };

    if (res.statusCode >= 500) {
      logger.error(`HTTP ${req.method} ${req.originalUrl} failed with status ${res.statusCode}`, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(`HTTP ${req.method} ${req.originalUrl} client warning ${res.statusCode}`, logData);
    } else {
      logger.info(`HTTP ${req.method} ${req.originalUrl} completed in ${latencyMs}ms`, logData);
    }
  });

  next();
}

