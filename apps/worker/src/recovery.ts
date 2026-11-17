import Docker from 'dockerode';
import {
  DeploymentStatus,
  getRedisClient,
  getStuckDeployments,
  logger,
  updateDeploymentStatus,
} from '@deployservice/shared';
import { activeDeployments, getDockerClient } from './builder.js';
import { DeploymentLogWriter } from './stream-writer.js';

export interface RecoveryOptions {
  dockerClient?: Docker;
  maxAgeMs?: number;
  includeAllOnStartup?: boolean;
}

export interface RecoveryResult {
  recoveredCount: number;
  recoveredDeploymentIds: string[];
}

/**
 * Recovers stuck deployments left in cloning/building/uploading states
 * after an unexpected worker crash or termination.
 */
export async function recoverStuckDeployments(
  options: RecoveryOptions = {}
): Promise<RecoveryResult> {
  const docker = options.dockerClient || getDockerClient();
  const redis = getRedisClient();
  const maxAgeMs = options.includeAllOnStartup ? 0 : (options.maxAgeMs ?? 5 * 60 * 1000);

  const stuckRows = await getStuckDeployments(maxAgeMs);
  const recoveredIds: string[] = [];

  for (const dep of stuckRows) {
    // If currently active in memory on this worker, skip
    if (activeDeployments.has(dep.id)) {
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
