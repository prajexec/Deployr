import { logger, Redis } from '@deployservice/shared';

export interface StreamLogEntry {
  id: string;
  type?: string;
  name?: string;
  ts?: string;
  stream?: 'stdout' | 'stderr' | 'system';
  data?: string;
  cont?: boolean;
  status?: string;
  exitCode?: number | null;
}

export type LogListener = (entry: StreamLogEntry) => void;

/**
 * Numerically compares two Redis Stream IDs (<ms>-<seq>).
 * Returns -1 if a < b, 1 if a > b, 0 if a === b.
 */
export function compareStreamIds(a: string, b: string): number {
  if (a === b) return 0;
  const [msAStr, seqAStr] = a.split('-');
  const [msBStr, seqBStr] = b.split('-');
  const msA = BigInt(msAStr || 0);
  const msB = BigInt(msBStr || 0);

  if (msA !== msB) {
    return msA < msB ? -1 : 1;
  }

  const seqA = BigInt(seqAStr || 0);
  const seqB = BigInt(seqBStr || 0);

  if (seqA !== seqB) {
    return seqA < seqB ? -1 : 1;
  }

  return 0;
}

/**
 * Parses flat Redis stream field-value arrays into a typed StreamLogEntry.
 */
export function parseStreamFields(id: string, fields: string[]): StreamLogEntry {
  const entry: StreamLogEntry = { id };
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k === 'type') entry.type = v;
    else if (k === 'name') entry.name = v;
    else if (k === 'ts') entry.ts = v;
    else if (k === 'stream') entry.stream = v as any;
    else if (k === 'data') entry.data = v;
    else if (k === 'cont') entry.cont = v === '1' || v === 'true';
    else if (k === 'status') entry.status = v;
    else if (k === 'exitCode') entry.exitCode = v === 'null' ? null : Number(v);
  }
  return entry;
}

export class LogStreamManager {
  private dedicatedRedis: Redis;
  private isRunning = false;
  private activeStreams = new Map<
    string,
    {
      lastId: string;
      listeners: Set<LogListener>;
    }
  >();
  private loopPromise: Promise<void> | null = null;

  constructor(redisClient: Redis) {
    this.dedicatedRedis = redisClient;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loopPromise = this.runReaderLoop();
  }

  public async stop() {
    this.isRunning = false;
    try {
      this.dedicatedRedis.disconnect();
    } catch {
      // ignore
    }
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
  }

  /**
   * Registers a listener for live updates on deploymentId.
   * fromId is the highest ID already replayed by the client.
   */
  public subscribe(
    deploymentId: string,
    listener: LogListener,
    fromId: string = '0-0'
  ): () => void {
    let streamState = this.activeStreams.get(deploymentId);
    if (!streamState) {
      streamState = {
        lastId: fromId,
        listeners: new Set(),
      };
      this.activeStreams.set(deploymentId, streamState);
    } else {
      // Advance lastId if fromId is higher
      if (compareStreamIds(fromId, streamState.lastId) > 0) {
        streamState.lastId = fromId;
      }
    }

    streamState.listeners.add(listener);

    return () => {
      const state = this.activeStreams.get(deploymentId);
      if (state) {
        state.listeners.delete(listener);
        if (state.listeners.size === 0) {
          this.activeStreams.delete(deploymentId);
        }
      }
    };
  }

  public getActiveDeploymentCount(): number {
    return this.activeStreams.size;
  }

  private async runReaderLoop() {
    while (this.isRunning) {
      if (this.activeStreams.size === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      const streamEntries = Array.from(this.activeStreams.entries());
      const keys = streamEntries.map(([depId]) => `logs:${depId}`);
      const ids = streamEntries.map(([, state]) => state.lastId);

      try {
        // Dedicated connection reads across all active deployment streams
        // BLOCK for up to 1000ms
        const response: any = await this.dedicatedRedis.xread(
          'BLOCK',
          1000,
          'STREAMS',
          ...keys,
          ...ids
        );

        if (response && Array.isArray(response)) {
          for (const [streamKey, rawEntries] of response) {
            const depId = streamKey.replace('logs:', '');
            const state = this.activeStreams.get(depId);
            if (!state || !Array.isArray(rawEntries)) continue;

            for (const [entryId, fields] of rawEntries) {
              // Ensure strictly monotonic ID update
              if (compareStreamIds(entryId, state.lastId) > 0) {
                state.lastId = entryId;
              }

              const parsed = parseStreamFields(entryId, fields);
              for (const listener of state.listeners) {
                try {
                  listener(parsed);
                } catch (err: any) {
                  logger.warn({ err: err.message, depId }, 'Error invoking log listener');
                }
              }
            }
          }
        }
      } catch (err: any) {
        if (!this.isRunning) break;
        // Backoff slightly on transient network error
        logger.warn({ err: err.message }, 'LogStreamManager error in xread loop');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}
