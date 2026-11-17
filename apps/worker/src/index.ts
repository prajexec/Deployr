/**
 * PHASE 1 PLACEHOLDER: Worker Entrypoint
 *
 * In Phase 1, the worker container must start and remain alive for docker-compose orchestration checks.
 * Real BullMQ queue processing, repo cloning, and containerized build isolation will be implemented in Phase 2 & 3.
 */
import { logger } from '@deployservice/shared';

logger.info('Worker initialized (Phase 1 placeholder, keeping process alive)');

// Keep-alive timer to prevent container exit in Phase 1
const keepAliveTimer = setInterval(() => {}, 60000);

const shutdown = (signal: string) => {
  logger.info({ signal }, 'Worker shutting down...');
  clearInterval(keepAliveTimer);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
