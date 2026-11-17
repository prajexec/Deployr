import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { InfrastructureError, UserBuildError } from '@deployservice/shared';
import { processDeploymentJob } from './processor.js';

describe('Worker Job Processor Security & Retries', () => {
  it('cannot set enableHostInternalForTest or custom build options from BullMQ job data', async () => {
    const mockExecutor = vi.fn().mockResolvedValue(undefined);

    const maliciousJobData = {
      deploymentId: 'd-test-123',
      repoUrl: 'https://github.com/example/repo',
      enableHostInternalForTest: true,
      privileged: true,
      extraHosts: ['host.docker.internal:host-gateway'],
      options: {
        enableHostInternalForTest: true,
      },
    };

    await processDeploymentJob(maliciousJobData, mockExecutor);

    // Verify build executor was called with only deploymentId and repoUrl, and NO options object
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(mockExecutor).toHaveBeenCalledWith('d-test-123', 'https://github.com/example/repo');
    expect(mockExecutor.mock.calls[0].length).toBe(2);
  });

  it('safely handles malformed job payloads', async () => {
    const mockExecutor = vi.fn().mockResolvedValue(undefined);

    await processDeploymentJob(null, mockExecutor);
    expect(mockExecutor).toHaveBeenCalledWith('', '');

    await processDeploymentJob('not-an-object', mockExecutor);
    expect(mockExecutor).toHaveBeenCalledWith('', '');
  });

  it('marks user build failures as UnrecoverableError so BullMQ does not retry them', async () => {
    const mockExecutor = vi
      .fn()
      .mockRejectedValue(new UserBuildError('Syntax error in src/index.js', 1));

    await expect(
      processDeploymentJob(
        { deploymentId: 'd-user-err', repoUrl: 'https://github.com/example/repo' },
        mockExecutor
      )
    ).rejects.toThrow(UnrecoverableError);
  });

  it('re-throws infrastructure errors so BullMQ performs exponential retry', async () => {
    const infraErr = new InfrastructureError('connect ECONNREFUSED /var/run/docker.sock');
    const mockExecutor = vi.fn().mockRejectedValue(infraErr);

    await expect(
      processDeploymentJob(
        { deploymentId: 'd-infra-err', repoUrl: 'https://github.com/example/repo' },
        mockExecutor
      )
    ).rejects.toThrow(InfrastructureError);
  });
});
