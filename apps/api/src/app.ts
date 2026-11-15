import express, { Express, Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from './middleware/request-id.middleware';
import { loggingMiddleware } from './middleware/logging.middleware';
import { notFoundHandler, globalErrorHandler } from './middleware/error.middleware';
import { linkRoutes } from './routes/link.routes';
import { redirectRoutes } from './routes/redirect.routes';
import { prisma } from './db';

export const createApp = (): Express => {
  const app = express();

  // 1. Request ID Middleware (generates or propagates X-Request-Id)
  app.use(requestIdMiddleware);

  // 2. Structured JSON Logging Middleware with secret redaction
  app.use(loggingMiddleware);

  // 3. Body parser
  app.use(express.json());

  // 4. Health check endpoint (Liveness probe: verifies process is alive)
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ ok: true, status: 'healthy', request_id: req.requestId });
  });

  // 4b. Readiness probe endpoint (Verifies database connectivity before accepting traffic)
  app.get('/ready', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      res.status(200).json({
        status: 'ready',
        database: 'connected',
        timestamp: new Date().toISOString(),
        request_id: req.requestId,
      });
    } catch (err: any) {
      res.status(503).json({
        status: 'unready',
        error: 'Database dependency unavailable',
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

  // 8. 404 handler for unrecognized routes
  app.use(notFoundHandler);

  // 9. Global error handling middleware (catches all AppErrors and unhandled exceptions)
  app.use(globalErrorHandler);

  return app;
};
