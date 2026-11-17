import { getConfig, logger } from '@deployservice/shared';
import { buildRouter } from './server.js';

const config = getConfig();
const app = buildRouter();

try {
  const address = await app.listen({
    port: config.ROUTER_PORT,
    host: '0.0.0.0',
  });
  logger.info({ address }, `Router listening on ${address}`);
} catch (err) {
  logger.fatal({ err }, 'Failed to start router');
  process.exit(1);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Router shutting down...');
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
