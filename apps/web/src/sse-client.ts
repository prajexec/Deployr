export interface LogEntry {
  id?: string;
  ts?: string;
  stream?: string;
  data?: string;
  cont?: boolean;
}

export type OnLogCallback = (entry: LogEntry) => void;
export type OnEndCallback = (endData: { status?: string; exitCode?: number | null }) => void;
export type OnErrorCallback = (err: Error) => void;

/**
 * Fetch-based Server-Sent Events client with:
 * - Exponential backoff reconnection
 * - Last-Event-ID resume
 * - Custom header support
 * - Event parsing and clean abort handling
 */
export class SseLogStreamer {
  private url: string;
  private lastEventId: string = '0-0';
  private abortController: AbortController | null = null;
  private isStopped = false;
  private retryDelayMs = 500;

  constructor(url: string) {
    this.url = url;
  }

  public start(onLog: OnLogCallback, onEnd: OnEndCallback, onError?: OnErrorCallback): void {
    this.isStopped = false;
    this.connect(onLog, onEnd, onError);
  }

  public stop(): void {
    this.isStopped = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async connect(
    onLog: OnLogCallback,
    onEnd: OnEndCallback,
    onError?: OnErrorCallback
  ): Promise<void> {
    if (this.isStopped) return;
    this.abortController = new AbortController();

    try {
      const response = await fetch(this.url, {
        headers: {
          Accept: 'text/event-stream',
          ...(this.lastEventId !== '0-0' ? { 'Last-Event-ID': this.lastEventId } : {}),
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.retryDelayMs = 500; // Reset backoff on successful connect
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No readable stream in response');

      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (!this.isStopped) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const block of parts) {
          if (!block.trim() || block.startsWith(':')) continue;

          let eventType = 'message';
          let eventId = '';
          let eventData = '';

          const lines = block.split('\n');
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('id: ')) {
              eventId = line.slice(4).trim();
              this.lastEventId = eventId;
            } else if (line.startsWith('data: ')) {
              eventData += line.slice(6);
            }
          }

          if (eventType === 'end') {
            try {
              const parsed = JSON.parse(eventData);
              onEnd(parsed);
            } catch {
              onEnd({ status: 'deployed' });
            }
            this.stop();
            return;
          }

          if (eventData) {
            try {
              const parsed = JSON.parse(eventData);
              onLog({ id: eventId, ...parsed });
            } catch {
              onLog({ id: eventId, data: eventData });
            }
          }
        }
      }
    } catch (err: any) {
      if (this.isStopped || err.name === 'AbortError') return;

      if (onError) onError(err);

      // Exponential backoff
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 8000);
      setTimeout(() => {
        if (!this.isStopped) {
          this.connect(onLog, onEnd, onError);
        }
      }, delay);
    }
  }
}
