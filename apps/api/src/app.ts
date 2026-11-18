import express, { Express, Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from './middleware/request-id.middleware';
import { loggingMiddleware } from './middleware/logging.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { notFoundHandler, globalErrorHandler } from './middleware/error.middleware';
import { linkRoutes } from './routes/link.routes';
import { redirectRoutes } from './routes/redirect.routes';
import { prisma } from './db';
import { register } from './utils/metrics';
import { notificationService } from './services/notification.service';
import { cacheService } from './services/cache.service';
import { withTimeout } from './utils/resilience';
import { config } from './config/env';

export const createApp = (): Express => {
  const app = express();

  // 1. Request ID Middleware (generates or propagates X-Request-Id)
  app.use(requestIdMiddleware);

  // 2. Structured JSON Logging Middleware with secret redaction
  app.use(loggingMiddleware);

  // 2b. Prometheus Metrics Middleware (RED Golden Signals)
  app.use(metricsMiddleware);

  // 3. Body parser
  app.use(express.json());

  // 3b. Prometheus metrics scrape endpoint
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', register.contentType);
    res.status(200).send(await register.metrics());
  });

  // 4. Health check endpoint (Liveness probe: lightweight & dependency-free)
  app.get(['/health', '/live'], (req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      status: 'healthy',
      version: process.env.APP_VERSION || '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      request_id: req.requestId,
    });
  });

  // 4b. Hardened Readiness probe endpoint (Verifies critical dependencies with bounded timeout)
  app.get('/ready', async (req: Request, res: Response) => {
    const version = process.env.APP_VERSION || '1.0.0';
    const checks: Record<string, string | number> = {
      database: 'disconnected',
      cache: cacheService.getHealthStatus(),
      notification_circuit_breaker: notificationService.getBreakerState(),
      config_fingerprint: config.CONFIG_FINGERPRINT,
      uptime_seconds: Math.floor(process.uptime()),
    };

    let ready = true;
    try {
      await withTimeout(
        () => prisma.$queryRawUnsafe('SELECT 1'),
        {
          timeoutMs: 2000,
          dependency: 'database',
          operation: 'readiness_probe',
          requestId: req.requestId,
        }
      );
      checks.database = 'connected';
    } catch {
      checks.database = 'disconnected';
      ready = false;
    }

    if (ready) {
      res.status(200).json({
        ok: true,
        status: 'ready',
        version,
        database: 'connected',
        checks,
        timestamp: new Date().toISOString(),
        request_id: req.requestId,
      });
    } else {
      res.status(503).json({
        ok: false,
        status: 'unready',
        version,
        error: 'Database dependency unavailable',
        checks,
        timestamp: new Date().toISOString(),
        request_id: req.requestId,
      });
    }
  });

  // 5. Test/Debug endpoint to simulate unhandled 500 error safely
  app.get('/debug/simulate-error', (_req: Request, _res: Response, next: NextFunction) => {
    const error = new Error('Simulated database connection failure with internal secrets: postgres://user:secretpass@db.internal:5432/production');
    next(error);
  });

  // 6. Admin link management routes
  app.use('/links', linkRoutes);

  // 7. Public redirect routes (Option A prefix: /r/:code)
  app.use('/r', redirectRoutes);

  // 7b. Resilient notification delivery endpoint (Timeout + Circuit Breaker + Fallback Queue)
  app.post('/notifications/send', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel = 'email', recipient, message } = req.body || {};
      if (!recipient || !message || !['email', 'sms', 'push'].includes(channel)) {
        res.status(400).json({
          error: {
            code: 'INVALID_NOTIFICATION_PAYLOAD',
            message: 'channel (email|sms|push), recipient, and message are required',
            request_id: req.requestId,
          },
        });
        return;
      }

      const result = await notificationService.send({
        channel,
        recipient,
        message,
        requestId: req.requestId,
      });

      const statusCode = result.degraded ? 202 : 200;
      res.status(statusCode).json({
        ...result,
        request_id: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  });

  // 8. 404 handler for unrecognized routes
  app.use(notFoundHandler);

  // 9. Global error handling middleware (catches all AppErrors and unhandled exceptions)
  app.use(globalErrorHandler);

  return app;
};
