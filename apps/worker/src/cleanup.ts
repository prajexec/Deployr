import Docker from 'dockerode';
import { logger } from '@deployservice/shared';
import { getDockerClient, reapOrphanedContainers } from './builder.js';

export interface CleanupOptions {
  dockerClient?: Docker;
  redisClient?: any;
  streamRetentionSeconds?: number;
  orphanMaxAgeMs?: number;
}

export interface CleanupResult {
  containersReaped: number;
  volumesReaped: number;
  streamsExamined: number;
}

/**
 * Cleanup task: reaps orphaned Docker build resources and ensures
 * Redis streams have retention limits configured.
 */
export async function runCleanupTask(options: CleanupOptions = {}): Promise<CleanupResult> {
  const docker = options.dockerClient || getDockerClient();
  const redis = options.redisClient;
  const streamRetentionSeconds = options.streamRetentionSeconds ?? 86400; // 24 hours
  const orphanMaxAgeMs = options.orphanMaxAgeMs ?? 300000; // 5 minutes

  // 1. Clean up orphaned containers and volumes
  const { containersReaped, volumesReaped } = await reapOrphanedContainers(docker, orphanMaxAgeMs);

  // 2. Set TTL on any unexpired Redis log streams
  let streamsExamined = 0;
  if (redis) {
    try {
      const keys = await redis.keys('deployservice:logs:d-*');
      streamsExamined = keys.length;
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl < 0) {
          // If no expiration set, ensure 24h retention
          await redis.expire(key, streamRetentionSeconds);
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed during stream cleanup in cleanup task');
    }
  }

  logger.info(
    { containersReaped, volumesReaped, streamsExamined },
    'Periodic cleanup task completed'
  );

  return {
    containersReaped,
    volumesReaped,
    streamsExamined,
  };
}
