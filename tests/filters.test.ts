import { describe, expect, it } from 'vitest';
import type { RedditItem, ScanFilters } from '../src/domain';
import { deduplicateItems, matchesFilters } from '../src/filters';

const item: RedditItem = {
  id: 't1_abc',
  shortId: 'abc',
  kind: 't1',
  source: 'comments',
  action: 'delete',
  subreddit: 'privacy',
  title: '',
  body: 'A useful browser privacy tip',
  author: 'tester',
  score: 12,
  createdUtc: new Date('2025-01-15T12:00:00Z').getTime() / 1000,
  permalink: '/r/privacy/comments/x/_/abc/',
  url: '',
  nsfw: false,
};

const filters: ScanFilters = {
  query: '',
  subreddit: '',
  excludedSubreddits: '',
  minScore: null,
  maxScore: null,
  beforeDate: '',
  afterDate: '',
  includeNsfw: false,
};

describe('matchesFilters', () => {
  it('combines text, subreddit and score filters', () => {
    expect(matchesFilters(item, { ...filters, query: 'PRIVACY', subreddit: 'r/privacy', minScore: 10 })).toBe(true);
    expect(matchesFilters(item, { ...filters, query: 'cookies' })).toBe(false);
    expect(matchesFilters(item, { ...filters, excludedSubreddits: 'news, privacy' })).toBe(false);
    expect(matchesFilters(item, { ...filters, maxScore: 11 })).toBe(false);
  });

  it('uses inclusive local calendar dates', () => {
    expect(matchesFilters(item, { ...filters, afterDate: '2025-01-15', beforeDate: '2025-01-15' })).toBe(true);
    expect(matchesFilters(item, { ...filters, afterDate: '2025-01-16' })).toBe(false);
  });
});

describe('deduplicateItems', () => {
  it('deduplicates only identical actions, preserving separate unsave and delete operations', () => {
    const saved = { ...item, source: 'saved' as const, action: 'unsave' as const };
    expect(deduplicateItems([item, item, saved])).toEqual([item, saved]);
  });
});
