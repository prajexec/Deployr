import { UnrecoverableError } from 'bullmq';
import { executeBuild } from './builder.js';
import { logger, UserBuildError } from '@deployservice/shared';

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
  try {
    await buildExecutor(deploymentId, repoUrl);
  } catch (err: any) {
    if (err instanceof UserBuildError || err.isUserError) {
      logger.warn(
        { deploymentId, err: err.message },
        'User build error: marked unrecoverable (no BullMQ retry)'
      );
      throw new UnrecoverableError(err.message);
    }

    logger.error(
      { deploymentId, err: err.message },
      'Infrastructure error: allowing BullMQ retry with exponential backoff'
    );
    throw err;
  }
}
