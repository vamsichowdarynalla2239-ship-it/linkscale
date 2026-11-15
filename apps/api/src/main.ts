import { env } from './config/env';
import { createApp } from './app';
import { prisma } from './db';
import { redis } from './config/redis';
import { logger } from './utils/logger';

const app = createApp();
const HOST = '0.0.0.0';

const server = app.listen(env.PORT, HOST, () => {
  logger.info(`🚀 API server booted in ${env.NODE_ENV} mode listening on http://${HOST}:${env.PORT}`);
});

// Configure explicit HTTP server timeouts (surpasses 60s load balancer keep-alive)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN HANDLER (SIGTERM / SIGINT)
// -----------------------------------------------------------------------------
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`[SHUTDOWN] Received ${signal}. Starting graceful shutdown...`);

  // Force exit safety timeout if drain stalls
  const forceExitTimeout = setTimeout(() => {
    logger.error('[SHUTDOWN] Forced shutdown after timeout limit (10s). Terminating.');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  // 1. Stop HTTP server from accepting new ingress traffic
  server.close(async (err) => {
    if (err) {
      logger.error(`[SHUTDOWN] Error while closing HTTP server: ${err.message}`);
    } else {
      logger.info('[SHUTDOWN] HTTP server closed cleanly. In-flight requests drained.');
    }

    try {
      // 2. Disconnect database pool
      await prisma.$disconnect();
      logger.info('[SHUTDOWN] PostgreSQL/Prisma connection pool disconnected.');

      // 3. Disconnect Redis client if active
      if (redis.status === 'ready' || redis.status === 'connecting') {
        await redis.quit();
        logger.info('[SHUTDOWN] Redis connection closed.');
      }
    } catch (cleanupErr: any) {
      logger.error(`[SHUTDOWN] Error during resource cleanup: ${cleanupErr.message}`);
    }

    clearTimeout(forceExitTimeout);
    logger.info('[SHUTDOWN] Graceful shutdown complete. Exiting process.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
