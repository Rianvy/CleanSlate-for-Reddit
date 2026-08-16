import { describe, expect, it, vi } from 'vitest';
import { ActionQueue } from '../src/action-queue';
import type { QueueSnapshot, RedditItem } from '../src/domain';
import { CleanerError } from '../src/errors';

const makeItem = (id: string): RedditItem => ({
  id: `t1_${id}`,
  shortId: id,
  kind: 't1',
  source: 'comments',
  action: 'delete',
  subreddit: 'test',
  title: '',
  body: id,
  author: 'tester',
  score: 1,
  createdUtc: 1,
  permalink: `/comments/${id}`,
  url: '',
  nsfw: false,
});

describe('ActionQueue', () => {
  it('tracks successful and failed work precisely', async () => {
    const items = [makeItem('a'), makeItem('b')];
    const worker = vi.fn((item: RedditItem) =>
      item.shortId === 'b'
        ? Promise.reject(new CleanerError('denied', { status: 403 }))
        : Promise.resolve({ item, ok: true as const }),
    );
    const queue = new ActionQueue(items, worker, { overwriteComments: false, overwriteText: '', hideAfterUnvote: true }, {}, { delayMs: 0, jitterMs: 0 });
    const results = await queue.run();
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(queue.getSnapshot()).toMatchObject({ state: 'done', completed: 2, succeeded: 1, failed: 1 });
  });

  it('retries transient Reddit failures', async () => {
    const item = makeItem('retry');
    const worker = vi.fn()
      .mockRejectedValueOnce(new CleanerError('busy', { status: 503, retryAfterMs: 1 }))
      .mockResolvedValue({ item, ok: true });
    const queue = new ActionQueue([item], worker, { overwriteComments: false, overwriteText: '', hideAfterUnvote: true }, {}, { delayMs: 0, jitterMs: 0 });
    await queue.run();
    expect(worker).toHaveBeenCalledTimes(2);
    expect(queue.getSnapshot().succeeded).toBe(1);
  });

  it('waits for a Reddit rate limit and resumes without marking the item failed', async () => {
    const item = makeItem('limited');
    const snapshots: QueueSnapshot[] = [];
    const worker = vi.fn()
      .mockRejectedValueOnce(new CleanerError('rate limited', { status: 429, retryAfterMs: 1 }))
      .mockResolvedValue({ item, ok: true });
    const queue = new ActionQueue(
      [item],
      worker,
      { overwriteComments: false, overwriteText: '', hideAfterUnvote: true },
      { onUpdate: (snapshot) => snapshots.push(snapshot) },
      { delayMs: 0, jitterMs: 0 },
    );

    await queue.run();

    expect(worker).toHaveBeenCalledTimes(2);
    expect(snapshots.some((snapshot) => snapshot.rateLimitUntil !== null)).toBe(true);
    expect(queue.getSnapshot()).toMatchObject({
      state: 'done',
      completed: 1,
      succeeded: 1,
      failed: 0,
      rateLimitUntil: null,
    });
  });
});
