import { Worker } from 'bullmq';
import { getConfig, getRedisClient, logger } from '@deployservice/shared';
import { ensureBuildNetwork, executeBuild, reapOrphanedContainers } from './builder.js';

const config = getConfig();
const redis = getRedisClient();

logger.info(
  { concurrency: config.MAX_CONCURRENT_BUILDS },
  'Starting deployment worker...'
);

let worker: Worker | null = null;

async function bootstrap() {
  // 1. Clean up orphaned containers/volumes from previous crashes
  try {
    const reapedCount = await reapOrphanedContainers();
    if (reapedCount > 0) {
      logger.info({ reapedCount }, 'Reaped orphaned build containers on startup');
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed during startup orphan container reaping');
  }

  // 2. Ensure isolated build network exists before processing any jobs
  try {
    await ensureBuildNetwork();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed during startup build network creation');
    process.exit(1);
  }

  // 3. Start BullMQ worker consumer
  worker = new Worker(
    'deployments',
    async (job) => {
      const { deploymentId, repoUrl } = job.data as {
        deploymentId: string;
        repoUrl: string;
      };

      logger.info({ deploymentId, repoUrl, jobId: job.id }, 'Worker received build job');
      await executeBuild(deploymentId, repoUrl);
    },
    {
      connection: redis,
      concurrency: config.MAX_CONCURRENT_BUILDS,
    }
  );

  worker.on('ready', () => {
    logger.info('Deployment worker ready and listening for jobs.');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Job completed successfully');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
  });
}

bootstrap().catch((err) => {
  logger.error({ err: err.message }, 'Fatal error during worker bootstrap');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down gracefully...');
  try {
    if (worker) {
      await worker.close();
    }
    logger.info('Worker closed cleanly');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error closing worker');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
