import { Queue } from 'bullmq';
import { getRedisClient } from '@deployservice/shared';

export const DEPLOYMENT_QUEUE_NAME = 'deployments';

export interface DeploymentJobPayload {
  deploymentId: string;
  repoUrl: string;
}

let deploymentQueue: Queue<DeploymentJobPayload> | null = null;

export function getDeploymentQueue(): Queue<DeploymentJobPayload> {
  if (!deploymentQueue) {
    const redis = getRedisClient();
    deploymentQueue = new Queue<DeploymentJobPayload>(DEPLOYMENT_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 1, // Do not retry user build failures
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return deploymentQueue;
}
