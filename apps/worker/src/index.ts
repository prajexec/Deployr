import { logger } from '@deployservice/shared';

logger.info('Worker initialized (Phase 1 placeholder, keeping alive)');

// Keep worker process running
const interval = setInterval(() => {}, 60000);

process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});

process.on('SIGINT', () => {
  clearInterval(interval);
  process.exit(0);
});
