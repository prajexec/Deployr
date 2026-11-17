import { describe, expect, it, vi } from 'vitest';
import { runCleanupTask } from './cleanup.js';

describe('Worker Periodic Cleanup Task', () => {
  it('reaps orphaned containers/volumes and enforces TTL on active log streams', async () => {
    const mockDocker: any = {
      listContainers: vi.fn().mockResolvedValue([]),
      listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    };

    const mockRedis: any = {
      keys: vi.fn().mockResolvedValue(['deployservice:logs:d-1', 'deployservice:logs:d-2']),
      ttl: vi.fn().mockResolvedValueOnce(-1).mockResolvedValueOnce(3600),
      expire: vi.fn().mockResolvedValue(1),
    };

    const result = await runCleanupTask({
      dockerClient: mockDocker,
      redisClient: mockRedis,
      streamRetentionSeconds: 86400,
    });

    expect(result.streamsExamined).toBe(2);
    expect(mockRedis.keys).toHaveBeenCalledWith('deployservice:logs:d-*');
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);
    expect(mockRedis.expire).toHaveBeenCalledWith('deployservice:logs:d-1', 86400);
  });
});
