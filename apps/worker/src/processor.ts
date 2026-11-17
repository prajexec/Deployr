import { executeBuild } from './builder.js';
import { logger } from '@deployservice/shared';

export interface DeploymentJobData {
  deploymentId: string;
  repoUrl: string;
}

export async function processDeploymentJob(
  rawJobData: unknown,
  buildExecutor: typeof executeBuild = executeBuild
): Promise<void> {
  const data = (rawJobData && typeof rawJobData === 'object' ? rawJobData : {}) as Record<
    string,
    unknown
  >;
  const deploymentId = typeof data.deploymentId === 'string' ? data.deploymentId : '';
  const repoUrl = typeof data.repoUrl === 'string' ? data.repoUrl : '';

  logger.info({ deploymentId, repoUrl }, 'Worker processing build job');

  // Explicitly pass only deploymentId and repoUrl; never allow job data
  // to configure BuildOptions (e.g. enableHostInternalForTest)
  await buildExecutor(deploymentId, repoUrl);
}
