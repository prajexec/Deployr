import Docker from 'dockerode';
import { Queue } from 'bullmq';
import {
  DEPLOYMENT_QUEUE_NAME,
  DeploymentStatus,
  getConfig,
  getRedisClient,
  getStuckDeployments,
  logger,
  updateDeploymentStatus,
} from '@deployservice/shared';
import { activeDeployments, getDockerClient } from './builder.js';
import { DeploymentLogWriter } from './stream-writer.js';

export interface RecoveryOptions {
  dockerClient?: Docker;
  redisClient?: any;
  queue?: Queue<any>;
  buildTimeoutMs?: number;
}

export interface RecoveryResult {
  recoveredCount: number;
  recoveredDeploymentIds: string[];
}

/**
 * Recovers stuck deployments left in cloning/building/uploading states
 * after an unexpected worker crash or termination.
 *
 * Never marks a deployment failed if it is:
 * 1. In this worker's activeDeployments
 * 2. Queued or active in BullMQ
 * 3. Younger than the build timeout
 */
export async function recoverStuckDeployments(
  options: RecoveryOptions = {}
): Promise<RecoveryResult> {
  const docker = options.dockerClient || getDockerClient();
  const redis = options.redisClient || getRedisClient();
  const buildTimeoutMs =
    options.buildTimeoutMs ?? getConfig().BUILD_TIMEOUT_MS ?? 5 * 60 * 1000;

  const stuckRows = await getStuckDeployments(buildTimeoutMs);
  const recoveredIds: string[] = [];

  if (stuckRows.length === 0) {
    return { recoveredCount: 0, recoveredDeploymentIds: [] };
  }

  // Query BullMQ for active or queued jobs to avoid reaping live tasks
  const bullMqDeploymentIds = new Set<string>();
  let tempQueue: Queue<any> | null = null;
  const queue =
    options.queue ||
    (tempQueue = new Queue(DEPLOYMENT_QUEUE_NAME, { connection: redis }));

  try {
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
    for (const job of jobs) {
      if (job.data?.deploymentId) {
        bullMqDeploymentIds.add(job.data.deploymentId);
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed querying BullMQ jobs during recovery');
  } finally {
    if (tempQueue) {
      await tempQueue.close().catch(() => {});
    }
  }

  const now = Date.now();
  for (const dep of stuckRows) {
    // 1. If currently active in memory on this worker, skip
    if (activeDeployments.has(dep.id)) {
      continue;
    }

    // 2. If queued or active in BullMQ, skip
    if (bullMqDeploymentIds.has(dep.id)) {
      continue;
    }

    // 3. If younger than the build timeout, skip
    const startTime = new Date(dep.started_at || dep.created_at).getTime();
    if (now - startTime < buildTimeoutMs) {
      continue;
    }

    logger.warn(
      { deploymentId: dep.id, status: dep.status },
      'Recovering stuck deployment after worker crash'
    );

    // 1. Clean up container if present
    const containerName = `deployservice-build-${dep.id}`;
    try {
      const ctr = docker.getContainer(containerName);
      await ctr.kill().catch(() => {});
      await ctr.remove({ force: true }).catch(() => {});
    } catch {
      // ignore
    }

    // 2. Clean up volume if present
    const volumeName = `deployservice-vol-${dep.id}`;
    try {
      const vol = docker.getVolume(volumeName);
      await vol.remove({ force: true }).catch(() => {});
    } catch {
      // ignore
    }

    // 3. Mark terminal status in Postgres
    try {
      await updateDeploymentStatus(dep.id, DeploymentStatus.FAILED, {
        error_message: 'Build worker terminated unexpectedly (recovered by supervisor)',
        finished_at: new Date(),
      });
    } catch (err: any) {
      logger.error(
        { deploymentId: dep.id, err: err.message },
        'Failed updating stuck deployment status during recovery'
      );
    }

    // 4. Emit terminal event on Redis stream
    try {
      const writer = new DeploymentLogWriter(dep.id, redis);
      await writer.finish('failed', 1);
    } catch {
      // ignore
    }

    recoveredIds.push(dep.id);
  }

  if (recoveredIds.length > 0) {
    logger.info({ count: recoveredIds.length, recoveredIds }, 'Stuck deployment recovery complete');
  }

  return {
    recoveredCount: recoveredIds.length,
    recoveredDeploymentIds: recoveredIds,
  };
}
