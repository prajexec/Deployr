import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as shared from '@deployservice/shared';
import { activeDeployments } from './builder.js';
import { recoverStuckDeployments } from './recovery.js';

describe('Worker Crash Recovery', () => {
  beforeEach(() => {
    activeDeployments.clear();
    vi.restoreAllMocks();
  });

  it('recovers stuck deployments in non-terminal states and cleans up Docker resources', async () => {
    const stuckDeployments: any[] = [
      {
        id: 'd-stuck1',
        project_id: 'prj_test1',
        status: shared.DeploymentStatus.BUILDING,
        created_at: new Date(Date.now() - 600000),
        started_at: new Date(Date.now() - 600000),
      },
      {
        id: 'd-stuck2',
        project_id: 'prj_test2',
        status: shared.DeploymentStatus.CLONING,
        created_at: new Date(Date.now() - 600000),
        started_at: new Date(Date.now() - 600000),
      },
    ];

    vi.spyOn(shared, 'getStuckDeployments').mockResolvedValue(stuckDeployments);
    const mockUpdateStatus = vi
      .spyOn(shared, 'updateDeploymentStatus')
      .mockResolvedValue({} as any);

    const mockRedis = {
      xadd: vi.fn().mockResolvedValue('1-0'),
      expire: vi.fn().mockResolvedValue(1),
    };
    vi.spyOn(shared, 'getRedisClient').mockReturnValue(mockRedis as any);

    const mockKill = vi.fn().mockResolvedValue(undefined);
    const mockRemoveCtr = vi.fn().mockResolvedValue(undefined);
    const mockRemoveVol = vi.fn().mockResolvedValue(undefined);

    const mockDocker: any = {
      getContainer: vi.fn().mockReturnValue({
        kill: mockKill,
        remove: mockRemoveCtr,
      }),
      getVolume: vi.fn().mockReturnValue({
        remove: mockRemoveVol,
      }),
    };

    const mockQueue: any = {
      getJobs: vi.fn().mockResolvedValue([]),
    };

    const result = await recoverStuckDeployments({
      dockerClient: mockDocker,
      queue: mockQueue,
      buildTimeoutMs: 300000,
    });

    expect(result.recoveredCount).toBe(2);
    expect(result.recoveredDeploymentIds).toEqual(['d-stuck1', 'd-stuck2']);

    expect(mockUpdateStatus).toHaveBeenCalledTimes(2);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'd-stuck1',
      shared.DeploymentStatus.FAILED,
      expect.objectContaining({
        error_message: expect.stringMatching(/Build worker terminated unexpectedly/),
      })
    );
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'd-stuck2',
      shared.DeploymentStatus.FAILED,
      expect.objectContaining({
        error_message: expect.stringMatching(/Build worker terminated unexpectedly/),
      })
    );

    expect(mockDocker.getContainer).toHaveBeenCalledWith('deployservice-build-d-stuck1');
    expect(mockDocker.getContainer).toHaveBeenCalledWith('deployservice-build-d-stuck2');
    expect(mockDocker.getVolume).toHaveBeenCalledWith('deployservice-vol-d-stuck1');
    expect(mockDocker.getVolume).toHaveBeenCalledWith('deployservice-vol-d-stuck2');
  });

  it('skips deployments actively running in memory on this worker', async () => {
    activeDeployments.add('d-active1');

    const stuckDeployments: any[] = [
      {
        id: 'd-active1',
        project_id: 'prj_test1',
        status: shared.DeploymentStatus.BUILDING,
        created_at: new Date(Date.now() - 600000),
      },
    ];

    vi.spyOn(shared, 'getStuckDeployments').mockResolvedValue(stuckDeployments);
    const mockUpdateStatus = vi
      .spyOn(shared, 'updateDeploymentStatus')
      .mockResolvedValue({} as any);

    const mockDocker: any = {
      getContainer: vi.fn(),
      getVolume: vi.fn(),
    };

    const mockQueue: any = {
      getJobs: vi.fn().mockResolvedValue([]),
    };

    const result = await recoverStuckDeployments({
      dockerClient: mockDocker,
      queue: mockQueue,
      buildTimeoutMs: 300000,
    });

    expect(result.recoveredCount).toBe(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });

  it('skips deployments queued or active in BullMQ', async () => {
    const stuckDeployments: any[] = [
      {
        id: 'd-queued-or-active',
        project_id: 'prj_test1',
        status: shared.DeploymentStatus.BUILDING,
        created_at: new Date(Date.now() - 600000),
        started_at: new Date(Date.now() - 600000),
      },
    ];

    vi.spyOn(shared, 'getStuckDeployments').mockResolvedValue(stuckDeployments);
    const mockUpdateStatus = vi
      .spyOn(shared, 'updateDeploymentStatus')
      .mockResolvedValue({} as any);

    const mockDocker: any = {
      getContainer: vi.fn(),
      getVolume: vi.fn(),
    };

    const mockQueue: any = {
      getJobs: vi.fn().mockResolvedValue([
        {
          data: { deploymentId: 'd-queued-or-active' },
        },
      ]),
    };

    const result = await recoverStuckDeployments({
      dockerClient: mockDocker,
      queue: mockQueue,
      buildTimeoutMs: 300000,
    });

    expect(result.recoveredCount).toBe(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });

  it('skips deployments younger than the build timeout', async () => {
    const stuckDeployments: any[] = [
      {
        id: 'd-young',
        project_id: 'prj_test1',
        status: shared.DeploymentStatus.BUILDING,
        created_at: new Date(Date.now() - 30000), // 30s ago (< 300s timeout)
        started_at: new Date(Date.now() - 30000),
      },
    ];

    vi.spyOn(shared, 'getStuckDeployments').mockResolvedValue(stuckDeployments);
    const mockUpdateStatus = vi
      .spyOn(shared, 'updateDeploymentStatus')
      .mockResolvedValue({} as any);

    const mockDocker: any = {
      getContainer: vi.fn(),
      getVolume: vi.fn(),
    };

    const mockQueue: any = {
      getJobs: vi.fn().mockResolvedValue([]),
    };

    const result = await recoverStuckDeployments({
      dockerClient: mockDocker,
      queue: mockQueue,
      buildTimeoutMs: 300000, // 5 min timeout
    });

    expect(result.recoveredCount).toBe(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });
});
