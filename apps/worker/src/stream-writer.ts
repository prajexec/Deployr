import { Redis, redactSecrets } from '@deployservice/shared';

export interface LogBatchItem {
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
  cont?: boolean;
}

export class DeploymentLogWriter {
  private deploymentId: string;
  private redis: Redis;
  private secrets: string[];
  private stdoutBuf = '';
  private stderrBuf = '';
  private timer: NodeJS.Timeout | null = null;
  private pendingBatch: LogBatchItem[] = [];
  private isClosed = false;

  constructor(deploymentId: string, redis: Redis, secrets: string[] = []) {
    this.deploymentId = deploymentId;
    this.redis = redis;
    this.secrets = secrets;
  }

  public async start(): Promise<void> {
    try {
      // Write start marker as first entry in stream
      await this.redis.xadd(
        `logs:${this.deploymentId}`,
        'MAXLEN',
        '~',
        '2000',
        '*',
        'type',
        'marker',
        'name',
        'start',
        'ts',
        new Date().toISOString()
      );
    } catch {
      // Best-effort start marker
    }

    // Periodic partial line flush timer (250ms)
    this.timer = setInterval(() => {
      this.flushPartialLines().catch(() => {});
    }, 250);
  }

  public writeChunk(stream: 'stdout' | 'stderr', rawText: string): void {
    if (this.isClosed) return;
    const text = redactSecrets(rawText, this.secrets);
    if (stream === 'stdout') {
      this.stdoutBuf += text;
      this.extractLines('stdout');
    } else {
      this.stderrBuf += text;
      this.extractLines('stderr');
    }
  }

  public writeSystemNotice(notice: string): void {
    if (this.isClosed) return;
    this.pendingBatch.push({ stream: 'system', data: notice });
    this.flushBatch().catch(() => {});
  }

  private extractLines(stream: 'stdout' | 'stderr'): void {
    const isStdout = stream === 'stdout';
    const buf = isStdout ? this.stdoutBuf : this.stderrBuf;
    const parts = buf.split('\n');

    // All elements except the last one are complete lines ending in \n
    for (let i = 0; i < parts.length - 1; i++) {
      this.pendingBatch.push({ stream, data: parts[i] + '\n' });
    }

    // Keep trailing incomplete characters in the buffer
    const remainder = parts[parts.length - 1];
    if (isStdout) {
      this.stdoutBuf = remainder;
    } else {
      this.stderrBuf = remainder;
    }

    if (this.pendingBatch.length >= 20) {
      this.flushBatch().catch(() => {});
    }
  }

  public async flushBatch(): Promise<void> {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch.splice(0, this.pendingBatch.length);
    const key = `logs:${this.deploymentId}`;
    const now = new Date().toISOString();

    const pipeline = this.redis.pipeline();
    for (const item of batch) {
      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        '2000',
        '*',
        'type',
        'log',
        'ts',
        now,
        'stream',
        item.stream,
        'data',
        item.data,
        'cont',
        item.cont ? '1' : '0'
      );
    }

    await pipeline.exec().catch(() => {});
  }

  public async flushPartialLines(): Promise<void> {
    if (this.stdoutBuf.length > 0) {
      this.pendingBatch.push({ stream: 'stdout', data: this.stdoutBuf, cont: true });
      this.stdoutBuf = '';
    }
    if (this.stderrBuf.length > 0) {
      this.pendingBatch.push({ stream: 'stderr', data: this.stderrBuf, cont: true });
      this.stderrBuf = '';
    }
    await this.flushBatch();
  }

  public async finish(status: string, exitCode: number | null): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      await this.flushPartialLines();

      // Write terminal end marker entry
      await this.redis.xadd(
        `logs:${this.deploymentId}`,
        'MAXLEN',
        '~',
        '2000',
        '*',
        'type',
        'marker',
        'name',
        'end',
        'status',
        status,
        'exitCode',
        exitCode === null ? 'null' : String(exitCode),
        'ts',
        new Date().toISOString()
      );

      // Set 24-hour expiration TTL
      await this.redis.expire(`logs:${this.deploymentId}`, 86400);
    } catch {
      // Best-effort cleanup
    }
  }
}
