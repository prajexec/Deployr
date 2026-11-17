import {
  closeDbPool,
  closeRedis,
  ensureBucket,
  getConfig,
  logger,
  runMigrations,
} from '@deployservice/shared';
import { buildServer } from './server.js';

async function main() {
  const config = getConfig();

  logger.info('Running database migrations...');
  try {
    await runMigrations();
  } catch (err: any) {
    logger.error({ err }, 'Failed to run migrations on startup');
    process.exit(1);
  }

  logger.info('Ensuring S3/MinIO bucket exists...');
  try {
    await ensureBucket();
  } catch (err: any) {
    logger.error({ err }, 'Failed to verify or create S3 bucket');
    // Don't necessarily exit immediately if MinIO is coming up, but log
  }

  const server = buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API server gracefully...');
    try {
      await server.close();
      await closeDbPool();
      await closeRedis();
      logger.info('Cleanup complete, exiting');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    const address = await server.listen({
      port: config.API_PORT,
      host: '0.0.0.0',
    });
    logger.info({ address }, `API server listening on ${address}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to bind API server');
    process.exit(1);
  }
}

main();
