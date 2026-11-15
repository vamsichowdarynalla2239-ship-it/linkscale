import { clickWorker } from './click.worker';
import { logger } from '../utils/logger';

logger.info('[WORKER:CLI] Starting Click Event Worker process...');
clickWorker.start(100);

const shutdown = () => {
  logger.info('[WORKER:CLI] Shutting down worker...');
  clickWorker.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
