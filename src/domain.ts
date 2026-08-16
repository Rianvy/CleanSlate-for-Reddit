export const SECTIONS = [
  'submitted',
  'comments',
  'saved',
  'upvoted',
  'downvoted',
] as const;

export type Section = (typeof SECTIONS)[number];
export type ActionKind = 'delete' | 'unsave' | 'unvote';

export interface RedditItem {
  id: string;
  shortId: string;
  kind: 't1' | 't3';
  source: Section;
  action: ActionKind;
  subreddit: string;
  title: string;
  body: string;
  author: string;
  score: number;
  createdUtc: number;
  permalink: string;
  url: string;
  nsfw: boolean;
}

export interface ScanFilters {
  query: string;
  subreddit: string;
  excludedSubreddits: string;
  minScore: number | null;
  maxScore: number | null;
  beforeDate: string;
  afterDate: string;
  includeNsfw: boolean;
}

export interface AuthStatus {
  connected: boolean;
  username: string | null;
}

export interface RateLimit {
  used: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}

export interface ActionOptions {
  overwriteComments: boolean;
  overwriteText: string;
  hideAfterUnvote: boolean;
}

export interface ActionResult {
  item: RedditItem;
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
}

export interface QueueSnapshot {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  state: 'idle' | 'running' | 'paused' | 'cancelled' | 'done';
  current: RedditItem | null;
  rateLimitUntil: number | null;
}

export const actionForSection = (section: Section): ActionKind => {
  if (section === 'saved') return 'unsave';
  if (section === 'upvoted' || section === 'downvoted') return 'unvote';
  return 'delete';
};
