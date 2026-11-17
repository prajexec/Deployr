import { describe, expect, it, vi } from 'vitest';
import { DeploymentLogWriter } from './stream-writer.js';

describe('DeploymentLogWriter', () => {
  it('reassembles lines per stream and flushes complete lines', async () => {
    const pipelineXadds: any[] = [];
    const mockPipeline: any = {
      xadd: vi.fn((...args: any[]) => {
        pipelineXadds.push(args);
        return mockPipeline;
      }),
      exec: vi.fn().mockResolvedValue([]),
    };

    const mockRedis = {
      xadd: vi.fn().mockResolvedValue('1000-0'),
      pipeline: vi.fn().mockReturnValue(mockPipeline),
      expire: vi.fn().mockResolvedValue(1),
    } as any;

    const writer = new DeploymentLogWriter('d-1234567890abcdef1234567890abcdef', mockRedis, [
      'my-secret-pw',
    ]);
    await writer.start();

    // Verify start marker written
    expect(mockRedis.xadd).toHaveBeenCalledWith(
      'logs:d-1234567890abcdef1234567890abcdef',
      'MAXLEN',
      '~',
      '2000',
      '*',
      'type',
      'marker',
      'name',
      'start',
      'ts',
      expect.any(String)
    );

    // Send chunks: partial line then newline
    writer.writeChunk('stdout', 'hello my-secret-pw world');
    // Buffer has not finished with \n, so no full line yet
    expect(mockPipeline.exec).not.toHaveBeenCalled();

    writer.writeChunk('stdout', ' is good\nnext line\npartial');
    await writer.flushBatch();

    // Two lines flushed: 'hello [REDACTED] world is good\n' and 'next line\n'
    expect(mockPipeline.exec).toHaveBeenCalled();
    expect(pipelineXadds.length).toBe(2);
    expect(pipelineXadds[0]).toContain('hello [REDACTED] world is good\n');
    expect(pipelineXadds[1]).toContain('next line\n');

    // Finish should flush partial line with cont: '1' and write end marker
    await writer.finish('deployed', 0);
    expect(mockRedis.xadd).toHaveBeenCalledWith(
      'logs:d-1234567890abcdef1234567890abcdef',
      'MAXLEN',
      '~',
      '2000',
      '*',
      'type',
      'marker',
      'name',
      'end',
      'status',
      'deployed',
      'exitCode',
      '0',
      'ts',
      expect.any(String)
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('logs:d-1234567890abcdef1234567890abcdef', 86400);
  });
});
