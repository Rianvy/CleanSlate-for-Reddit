import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOptions, RedditItem } from '../src/domain';
import { sessionClient } from '../src/session-client';

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const makeChild = (index: number) => ({
  kind: 't3',
  data: {
    name: `t3_${index}`,
    id: String(index),
    subreddit: 'test',
    title: `Post ${index}`,
    score: index,
    created_utc: 1_700_000_000 + index,
    permalink: `/r/test/comments/${index}/post/`,
    url: `https://www.reddit.com/r/test/comments/${index}/post/`,
    over_18: index % 2 === 0,
  },
});

const makeItem = (action: RedditItem['action']): RedditItem => ({
  id: 't3_item',
  shortId: 'item',
  kind: 't3',
  source: action === 'unsave' ? 'saved' : 'upvoted',
  action,
  subreddit: 'test',
  title: 'Test item',
  body: '',
  author: 'tester',
  score: 1,
  createdUtc: 1_700_000_000,
  permalink: '/r/test/comments/item/post/',
  url: 'https://www.reddit.com/r/test/comments/item/post/',
  nsfw: false,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessionClient scanning', () => {
  it('follows Reddit after cursors and collects every page', async () => {
    const listingUrls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url === 'https://www.reddit.com/api/me.json') {
        return Promise.resolve(jsonResponse({ data: { name: 'tester', modhash: '' } }));
      }
      listingUrls.push(url);
      const after = new URL(url).searchParams.get('after');
      return Promise.resolve(after
        ? jsonResponse({ data: { after: null, children: Array.from({ length: 78 }, (_, index) => makeChild(index + 100)) } })
        : jsonResponse({ data: { after: 't3_cursor', children: Array.from({ length: 100 }, (_, index) => makeChild(index)) } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const progress: number[] = [];
    const scan = await sessionClient.createScanner();
    const items = await scan('upvoted', {
      pageDelayMs: 0,
      onProgress: (count) => progress.push(count),
    });

    expect(items).toHaveLength(178);
    expect(progress.at(-1)).toBe(178);
    expect(listingUrls).toHaveLength(2);
    expect(new URL(listingUrls[0]!).searchParams.get('limit')).toBe('100');
    expect(new URL(listingUrls[1]!).searchParams.get('after')).toBe('t3_cursor');
    expect(new URL(listingUrls[1]!).searchParams.get('count')).toBe('100');
  });
});

describe('sessionClient actions', () => {
  it('obtains one modhash and reuses it for the whole queue', async () => {
    const sessionUrls: string[] = [];
    const actionRequests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith('/api/me.json')) {
        sessionUrls.push(url);
        return Promise.resolve(jsonResponse({
          data: {
            name: 'tester',
            modhash: url.startsWith('https://old.reddit.com') ? 'modhash-once' : '',
          },
        }));
      }
      const requestBody = init?.body;
      const body = typeof requestBody === 'string'
        ? requestBody
        : requestBody instanceof URLSearchParams
          ? requestBody.toString()
          : '';
      actionRequests.push({ url, body });
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const options: ActionOptions = { overwriteComments: false, overwriteText: '', hideAfterUnvote: true };
    const act = await sessionClient.createActionWorker();
    await act(makeItem('unsave'), options);
    await act(makeItem('unvote'), options);

    expect(sessionUrls).toEqual([
      'https://www.reddit.com/api/me.json',
      'https://old.reddit.com/api/me.json',
    ]);
    expect(actionRequests.map(({ url }) => url)).toEqual([
      'https://www.reddit.com/api/unsave',
      'https://www.reddit.com/api/vote',
      'https://old.reddit.com/api/hide',
    ]);
    expect(actionRequests.every(({ body }) => body.includes('uh=modhash-once'))).toBe(true);
  });
});
