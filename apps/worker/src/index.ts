import { Worker } from 'bullmq';
import {
  DeploymentStatus,
  getConfig,
  getRedisClient,
  logger,
  updateDeploymentStatus,
} from '@deployservice/shared';
import {
  activeDeployments,
  cancelActiveBuild,
  ensureBuildNetwork,
  getDockerClient,
  reapOrphanedContainers,
} from './builder.js';
import { runCleanupTask } from './cleanup.js';
import { processDeploymentJob } from './processor.js';
import { recoverStuckDeployments } from './recovery.js';

const config = getConfig();
const redis = getRedisClient();

logger.info({ concurrency: config.MAX_CONCURRENT_BUILDS }, 'Starting deployment worker...');

let worker: Worker | null = null;
let recoveryInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let cancelSubscriber: any = null;

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
    const { recoveredCount, recoveredDeploymentIds } = await recoverStuckDeployments();
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

  // Periodic cleanup sweep every 30 minutes
  cleanupInterval = setInterval(
    () => {
      runCleanupTask({ redisClient: redis }).catch((err: any) => {
        logger.warn({ err: err.message }, 'Error in periodic cleanup task');
      });
    },
    30 * 60 * 1000
  );

  // 4. Subscribe to cancellation channel
  try {
    cancelSubscriber = redis.duplicate();
    await cancelSubscriber.subscribe('deployservice:cancel');
    cancelSubscriber.on('message', async (channel: string, deploymentId: string) => {
      if (channel === 'deployservice:cancel') {
        logger.info({ deploymentId }, 'Received cancellation pub/sub message');
        await cancelActiveBuild(deploymentId);
      }
    });
    logger.info('Worker subscribed to cancellation channel');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed setting up cancellation subscriber');
  }
}

bootstrap().catch((err) => {
  logger.error({ err: err.message }, 'Fatal error during worker bootstrap');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down gracefully...');

  const forceTimeout = setTimeout(async () => {
    logger.error('Graceful shutdown timed out after 15s. Force-killing active builds...');
    const docker = getDockerClient();
    for (const depId of activeDeployments) {
      try {
        const ctr = docker.getContainer(`deployservice-build-${depId}`);
        await ctr.kill().catch(() => {});
        await ctr.remove({ force: true }).catch(() => {});
        await updateDeploymentStatus(depId, DeploymentStatus.FAILED, {
          error_message: 'Worker shutdown forced before build completed',
          finished_at: new Date(),
        }).catch(() => {});
      } catch {
        // ignore
      }
    }
    process.exit(1);
  }, 15000);

  try {
    if (recoveryInterval) {
      clearInterval(recoveryInterval);
      recoveryInterval = null;
    }
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    if (cancelSubscriber) {
      await cancelSubscriber.quit();
      cancelSubscriber = null;
    }
    if (worker) {
      await worker.close();
    }
    clearTimeout(forceTimeout);
    logger.info('Worker closed cleanly');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceTimeout);
    logger.error({ err }, 'Error closing worker');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
