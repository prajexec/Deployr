import { Worker } from 'bullmq';
import { getConfig, getRedisClient, logger } from '@deployservice/shared';
import { ensureBuildNetwork, reapOrphanedContainers } from './builder.js';
import { processDeploymentJob } from './processor.js';
import { recoverStuckDeployments } from './recovery.js';

const config = getConfig();
const redis = getRedisClient();

logger.info({ concurrency: config.MAX_CONCURRENT_BUILDS }, 'Starting deployment worker...');

let worker: Worker | null = null;
let recoveryInterval: NodeJS.Timeout | null = null;

async function bootstrap() {
  // 1. Clean up orphaned containers/volumes from previous crashes
  try {
    const { containersReaped, volumesReaped } = await reapOrphanedContainers();
    if (containersReaped > 0 || volumesReaped > 0) {
      logger.info(
        { containersReaped, volumesReaped },
        'Reaped orphaned build resources on startup'
      );
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed during startup orphan container reaping');
  }

  // 2. Recover any stuck deployments in Postgres left by previous crashed worker
  try {
    const { recoveredCount, recoveredDeploymentIds } = await recoverStuckDeployments({
      includeAllOnStartup: true,
    });
    if (recoveredCount > 0) {
      logger.info(
        { recoveredCount, recoveredDeploymentIds },
        'Recovered stuck deployments on worker startup'
      );
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed during startup stuck deployment recovery');
  }

  // 3. Ensure isolated build network exists before processing any jobs
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
      await processDeploymentJob(job.data);
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

  // Periodic recovery sweep every 60 seconds
  recoveryInterval = setInterval(() => {
    recoverStuckDeployments().catch((err: any) => {
      logger.warn({ err: err.message }, 'Error in periodic stuck deployment recovery');
    });
  }, 60 * 1000);
}

bootstrap().catch((err) => {
  logger.error({ err: err.message }, 'Fatal error during worker bootstrap');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down gracefully...');
  try {
    if (recoveryInterval) {
      clearInterval(recoveryInterval);
      recoveryInterval = null;
    }
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
