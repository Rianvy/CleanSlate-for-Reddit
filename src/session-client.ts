import { actionForSection } from './domain';
import type {
  ActionOptions,
  ActionResult,
  AuthStatus,
  RateLimit,
  RedditItem,
  Section,
} from './domain';
import { CleanerError } from './errors';

interface RedditSession {
  username: string;
  modhash: string;
}

interface ScanOptions {
  maxItems?: number;
  pageDelayMs?: number;
  onProgress?: (count: number) => void;
}

interface RedditChild {
  kind?: string;
  data?: Record<string, unknown>;
}

interface RedditListing {
  data?: {
    after?: string | null;
    children?: RedditChild[];
  };
}

const REDDIT_ORIGIN = 'https://www.reddit.com';
const OLD_REDDIT_ORIGIN = 'https://old.reddit.com';
const SCAN_PAGE_SIZE = 100;
const DEFAULT_MAX_ITEMS = 2_000;
const DEFAULT_PAGE_DELAY_MS = 300;

const sleep = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const toNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const toString = (value: unknown): string => (typeof value === 'string' ? value : '');

const rateLimitFrom = (response: Response): RateLimit => {
  const parse = (name: string): number | null => {
    const value = response.headers.get(name);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    used: parse('x-ratelimit-used'),
    remaining: parse('x-ratelimit-remaining'),
    resetSeconds: parse('x-ratelimit-reset'),
  };
};

const retryAfterMs = (response: Response): number | undefined => {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  const reset = rateLimitFrom(response).resetSeconds;
  return reset === null ? undefined : Math.max(1_000, reset * 1_000);
};

const redditFetch = async (
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { Accept: 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const retry = retryAfterMs(response);
    throw new CleanerError(`Reddit request failed (${response.status})`, {
      code: response.status === 429 ? 'RATE_LIMITED' : 'REDDIT_REQUEST_FAILED',
      status: response.status,
      ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    });
  }
  return response;
};

const trySession = async (origin: string): Promise<RedditSession | null> => {
  try {
    const response = await fetch(`${origin}/api/me.json`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { name?: string; modhash?: string };
    };
    const username = payload.data?.name ?? '';
    if (!username) return null;
    return {
      username,
      modhash: payload.data?.modhash ?? '',
    };
  } catch {
    return null;
  }
};

const getSession = async (requireModhash = false): Promise<RedditSession> => {
  const primary = await trySession(REDDIT_ORIGIN);
  if (primary && (!requireModhash || primary.modhash)) return primary;

  const fallback = await trySession(OLD_REDDIT_ORIGIN);
  if (fallback && (!requireModhash || fallback.modhash)) return fallback;

  if ((primary || fallback) && requireModhash) {
    throw new CleanerError('Reddit session found, but no modhash is available. Open old.reddit.com and retry.', {
      code: 'MODHASH_MISSING',
    });
  }
  throw new CleanerError('Log in to Reddit and reload this page', {
    code: 'NOT_AUTHENTICATED',
  });
};

const mapItem = (section: Section, child: RedditChild): RedditItem | null => {
  const data = child.data ?? {};
  const kind = child.kind;
  if (kind !== 't1' && kind !== 't3') return null;
  const id = toString(data.name);
  if (!id) return null;
  return {
    id,
    shortId: toString(data.id),
    kind,
    source: section,
    action: actionForSection(section),
    subreddit: toString(data.subreddit),
    title: toString(data.title),
    body: toString(data.body) || toString(data.selftext),
    author: toString(data.author),
    score: toNumber(data.score),
    createdUtc: toNumber(data.created_utc),
    permalink: toString(data.permalink),
    url: toString(data.url),
    nsfw: Boolean(data.over_18),
  };
};

const scanUser = async (
  username: string,
  section: Section,
  options: ScanOptions = {},
): Promise<RedditItem[]> => {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const items: RedditItem[] = [];
  let after: string | null = null;
  const seenCursors = new Set<string>();
  const encodedUsername = encodeURIComponent(username);

  while (items.length < maxItems) {
    const params = new URLSearchParams({
      raw_json: '1',
      limit: String(SCAN_PAGE_SIZE),
      count: String(items.length),
    });
    if (after) params.set('after', after);
    const response = await redditFetch(
      `${REDDIT_ORIGIN}/user/${encodedUsername}/${section}.json?${params.toString()}`,
    );
    const listing = (await response.json()) as RedditListing;
    const children = listing.data?.children ?? [];
    if (children.length === 0) break;
    for (const child of children) {
      const item = mapItem(section, child);
      if (item) {
        items.push(item);
        options.onProgress?.(items.length);
      }
      if (items.length >= maxItems) break;
    }
    const nextCursor = listing.data?.after ?? null;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    after = nextCursor;
    await sleep(pageDelayMs);
  }
  return items;
};

const createScanner = async () => {
  const session = await getSession();
  return async (section: Section, options: ScanOptions = {}): Promise<RedditItem[]> =>
    scanUser(session.username, section, options);
};

const assertApiSuccess = async (response: Response): Promise<void> => {
  const text = await response.text();
  if (!text) return;
  try {
    const payload = JSON.parse(text) as { json?: { errors?: unknown[][] } };
    const errors = payload.json?.errors ?? [];
    if (errors.length > 0) {
      const message = errors.map((entry) => entry.filter(Boolean).join(': ')).join('; ');
      throw new CleanerError(message || 'Reddit rejected the action', {
        code: 'REDDIT_ACTION_REJECTED',
      });
    }
  } catch (error) {
    if (error instanceof CleanerError) throw error;
  }
};

const postForm = async (
  session: RedditSession,
  path: string,
  values: Record<string, string>,
  origin = REDDIT_ORIGIN,
): Promise<void> => {
  const response = await redditFetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Modhash': session.modhash,
    },
    body: new URLSearchParams({ ...values, uh: session.modhash }),
  });
  await assertApiSuccess(response);
};

const actWithSession = async (
  session: RedditSession,
  item: RedditItem,
  options: ActionOptions,
): Promise<ActionResult> => {
  if (item.action === 'delete') {
    if (item.kind === 't1' && options.overwriteComments) {
      await postForm(session, '/api/editusertext', {
        api_type: 'json',
        thing_id: item.id,
        text: options.overwriteText.trim() || '[deleted by user]',
      });
    }
    await postForm(session, '/api/del', { id: item.id });
  } else if (item.action === 'unsave') {
    await postForm(session, '/api/unsave', { id: item.id });
  } else {
    await postForm(session, '/api/vote', { id: item.id, dir: '0' });
    if (options.hideAfterUnvote && item.kind === 't3') {
      await postForm(session, '/api/hide', { id: item.id }, OLD_REDDIT_ORIGIN);
    }
  }
  return { item, ok: true };
};

const createActionWorker = async () => {
  const session = await getSession(true);
  return async (item: RedditItem, options: ActionOptions): Promise<ActionResult> =>
    actWithSession(session, item, options);
};

const authStatus = async (): Promise<AuthStatus> => {
  try {
    const session = await getSession();
    return {
      connected: true,
      username: session.username,
    };
  } catch {
    return {
      connected: false,
      username: null,
    };
  }
};

export const sessionClient = { authStatus, createScanner, createActionWorker };
