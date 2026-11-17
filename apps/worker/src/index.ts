import { Worker } from 'bullmq';
import { getConfig, getRedisClient, logger } from '@deployservice/shared';
import { executeBuild } from './builder.js';

const config = getConfig();
const redis = getRedisClient();

logger.info(
  { concurrency: config.MAX_CONCURRENT_BUILDS },
  'Starting deployment worker...'
);

const worker = new Worker(
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

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down gracefully...');
  try {
    await worker.close();
    logger.info('Worker closed cleanly');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error closing worker');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
