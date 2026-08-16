import type { ActionOptions, ActionResult, QueueSnapshot, RedditItem } from './domain';
import { CleanerError, errorMessage } from './errors';

export interface QueueHooks {
  onUpdate?: (snapshot: QueueSnapshot) => void;
  onResult?: (result: ActionResult) => void;
}

export interface QueueConfig {
  delayMs?: number;
  jitterMs?: number;
  maxRetries?: number;
  pauseEveryN?: number;
  pauseDurationMs?: number;
}

type Worker = (item: RedditItem, options: ActionOptions) => Promise<ActionResult>;

const wait = async (ms: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

export class ActionQueue {
  readonly results: ActionResult[] = [];
  private readonly controller = new AbortController();
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private snapshot: QueueSnapshot;

  constructor(
    private readonly items: RedditItem[],
    private readonly worker: Worker,
    private readonly options: ActionOptions,
    private readonly hooks: QueueHooks = {},
    private readonly config: QueueConfig = {},
  ) {
    this.snapshot = {
      total: items.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      state: 'idle',
      current: null,
      rateLimitUntil: null,
    };
  }

  pause(): void {
    if (this.snapshot.state !== 'running') return;
    this.paused = true;
    this.patch({ state: 'paused' });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.patch({ state: 'running' });
    this.resumeWaiters.splice(0).forEach((resolve) => resolve());
  }

  cancel(): void {
    if (this.snapshot.state === 'done' || this.snapshot.state === 'cancelled') return;
    this.controller.abort();
    this.resume();
    this.patch({ state: 'cancelled', current: null, rateLimitUntil: null });
  }

  getSnapshot(): QueueSnapshot {
    return { ...this.snapshot };
  }

  private patch(update: Partial<QueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.hooks.onUpdate?.(this.getSnapshot());
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private async perform(item: RedditItem): Promise<ActionResult> {
    const maxRetries = this.config.maxRetries ?? 3;
    let attempt = 0;
    while (true) {
      try {
        return await this.worker(item, this.options);
      } catch (error) {
        const cleanerError = error instanceof CleanerError ? error : null;
        if (cleanerError?.status === 429) {
          const backoff = cleanerError.retryAfterMs
            ?? Math.min(15 * 60_000, 15_000 * 2 ** Math.min(attempt, 6));
          attempt += 1;
          this.patch({ rateLimitUntil: Date.now() + backoff });
          try {
            await wait(backoff, this.controller.signal);
          } finally {
            this.patch({ rateLimitUntil: null });
          }
          await this.waitWhilePaused();
          continue;
        }

        const retryable = cleanerError?.status === 503;
        if (!retryable || attempt >= maxRetries) {
          return {
            item,
            ok: false,
            error: errorMessage(error),
            ...(cleanerError?.retryAfterMs !== undefined
              ? { retryAfterMs: cleanerError.retryAfterMs }
              : {}),
          };
        }
        const backoff = cleanerError.retryAfterMs ?? Math.min(60_000, 2 ** attempt * 2_000);
        attempt += 1;
        await wait(backoff, this.controller.signal);
      }
    }
  }

  async run(): Promise<ActionResult[]> {
    if (this.snapshot.state !== 'idle') return this.results;
    this.patch({ state: 'running' });
    const baseDelay = this.config.delayMs ?? 1_200;
    const jitter = this.config.jitterMs ?? 600;
    const pauseEveryN = this.config.pauseEveryN ?? 50;
    const pauseDurationMs = this.config.pauseDurationMs ?? 5_000;

    try {
      for (const item of this.items) {
        if (this.controller.signal.aborted) break;
        await this.waitWhilePaused();
        if (this.controller.signal.aborted) break;
        this.patch({ current: item });
        const result = await this.perform(item);
        this.results.push(result);
        this.hooks.onResult?.(result);
        this.patch({
          completed: this.snapshot.completed + 1,
          succeeded: this.snapshot.succeeded + (result.ok ? 1 : 0),
          failed: this.snapshot.failed + (result.ok ? 0 : 1),
        });
        if (this.snapshot.completed < this.snapshot.total) {
          if (pauseEveryN > 0 && this.snapshot.completed % pauseEveryN === 0) {
            await wait(pauseDurationMs, this.controller.signal);
          }
          await wait(baseDelay + Math.floor(Math.random() * jitter), this.controller.signal);
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }

    if (!this.controller.signal.aborted) {
      this.patch({ state: 'done', current: null, rateLimitUntil: null });
    }
    return this.results;
  }
}
