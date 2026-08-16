import type { RedditItem, ScanFilters } from './domain';

const splitList = (value: string): Set<string> =>
  new Set(
    value
      .split(',')
      .map((entry) => entry.trim().replace(/^r\//i, '').toLowerCase())
      .filter(Boolean),
  );

const startOfDay = (value: string): number | null => {
  if (!value) return null;
  const timestamp = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp / 1000 : null;
};

const endOfDay = (value: string): number | null => {
  if (!value) return null;
  const timestamp = new Date(`${value}T23:59:59`).getTime();
  return Number.isFinite(timestamp) ? timestamp / 1000 : null;
};

export const matchesFilters = (item: RedditItem, filters: ScanFilters): boolean => {
  const query = filters.query.trim().toLowerCase();
  if (query && !`${item.title}\n${item.body}`.toLowerCase().includes(query)) return false;

  const included = splitList(filters.subreddit);
  const excluded = splitList(filters.excludedSubreddits);
  const subreddit = item.subreddit.toLowerCase();
  if (included.size > 0 && !included.has(subreddit)) return false;
  if (excluded.has(subreddit)) return false;
  if (filters.minScore !== null && item.score < filters.minScore) return false;
  if (filters.maxScore !== null && item.score > filters.maxScore) return false;
  if (!filters.includeNsfw && item.nsfw) return false;

  const after = startOfDay(filters.afterDate);
  const before = endOfDay(filters.beforeDate);
  if (after !== null && item.createdUtc < after) return false;
  if (before !== null && item.createdUtc > before) return false;
  return true;
};

export const filterItems = (items: RedditItem[], filters: ScanFilters): RedditItem[] =>
  items.filter((item) => matchesFilters(item, filters));

export const deduplicateItems = (items: RedditItem[]): RedditItem[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.action}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
