import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionQueue } from './action-queue';
import {
  SECTIONS,
  type ActionOptions,
  type ActionResult,
  type AuthStatus,
  type QueueSnapshot,
  type RedditItem,
  type ScanFilters,
  type Section,
} from './domain';
import { deduplicateItems, filterItems } from './filters';
import { CleanerError } from './errors';
import { t } from './i18n';
import { GITHUB_REPOSITORY_URL } from './project';
import { sessionClient } from './session-client';

type View = 'scan' | 'preview' | 'running' | 'done';

const DEFAULT_FILTERS: ScanFilters = {
  query: '',
  subreddit: '',
  excludedSubreddits: '',
  minScore: null,
  maxScore: null,
  beforeDate: '',
  afterDate: '',
  includeNsfw: true,
};

const EMPTY_QUEUE: QueueSnapshot = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  state: 'idle',
  current: null,
  rateLimitUntil: null,
};

const itemKey = (item: RedditItem): string => `${item.action}:${item.id}`;

const actionLabel = (item: RedditItem, hideAfterUnvote = false): string => {
  if (item.action === 'unsave') return t('unsaveAction');
  if (item.action === 'unvote') {
    return hideAfterUnvote && item.kind === 't3' ? t('unvoteAndHideAction') : t('unvoteAction');
  }
  return t('deleteAction');
};

const sectionLabel = (section: Section): string => t(section);

const displayText = (item: RedditItem): string =>
  item.title || item.body || `${item.kind === 't1' ? 'Comment' : 'Post'} ${item.shortId}`;

const displayError = (reason: unknown): string => {
  if (reason instanceof CleanerError && reason.status === 429) {
    return `${t('rateLimitTitle')}. ${t('rateLimitRequestBody')}`;
  }
  return reason instanceof Error ? reason.message : String(reason);
};

const csvCell = (value: string | number | boolean): string =>
  `"${String(value).replaceAll('"', '""')}"`;

const download = (name: string, contents: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const CleanSlateGlyph = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="5" y="5" width="9" height="9" rx="3" />
    <rect x="18" y="5" width="9" height="9" rx="3" />
    <rect x="5" y="18" width="9" height="9" rx="3" />
    <path d="M19 22.5h7M22.5 19v7" />
  </svg>
);

const NumberInput = ({
  value,
  label,
  onChange,
}: {
  value: number | null;
  label: string;
  onChange: (value: number | null) => void;
}) => (
  <label className="field compact-field">
    <span>{label}</span>
    <input
      type="number"
      value={value ?? ''}
      onChange={(event) =>
        onChange(event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber)
      }
    />
  </label>
);

export function CleanerApp() {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [view, setView] = useState<View>('scan');
  const [sections, setSections] = useState<Set<Section>>(
    new Set<Section>(['submitted', 'comments']),
  );
  const [filters, setFilters] = useState<ScanFilters>(DEFAULT_FILTERS);
  const [items, setItems] = useState<RedditItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [scanningSection, setScanningSection] = useState<Section | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [error, setError] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [overwriteComments, setOverwriteComments] = useState(false);
  const [overwriteText, setOverwriteText] = useState('[deleted by user]');
  const [hideAfterUnvote, setHideAfterUnvote] = useState(true);
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE);
  const [clock, setClock] = useState(Date.now());
  const [results, setResults] = useState<ActionResult[]>([]);
  const [page, setPage] = useState(1);
  const queueRef = useRef<ActionQueue | null>(null);

  useEffect(() => {
    void sessionClient
      .authStatus()
      .then(setAuth)
      .catch((reason: unknown) => setError(displayError(reason)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (queue.rateLimitUntil === null) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [queue.rateLimitUntil]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(itemKey(item))),
    [items, selected],
  );
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const visibleItems = items.slice((page - 1) * pageSize, page * pageSize);
  const includesDeletion = selectedItems.some((item) => item.action === 'delete');
  const includesUnvotedPosts = selectedItems.some(
    (item) => item.action === 'unvote' && item.kind === 't3',
  );

  const setFilter = <K extends keyof ScanFilters>(key: K, value: ScanFilters[K]): void => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleSection = (section: Section): void => {
    setSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const refreshSession = async (): Promise<void> => {
    setWorking(true);
    setError('');
    try {
      setAuth(await sessionClient.authStatus());
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setWorking(false);
    }
  };

  const scan = async (): Promise<void> => {
    if (sections.size === 0) {
      setError(t('noSections'));
      return;
    }
    setWorking(true);
    setError('');
    setItems([]);
    try {
      const scanned: RedditItem[] = [];
      const scanSection = await sessionClient.createScanner();
      for (const section of SECTIONS.filter((candidate) => sections.has(candidate))) {
        setScanningSection(section);
        setScannedCount(0);
        scanned.push(...(await scanSection(section, { onProgress: setScannedCount })));
      }
      const filtered = filterItems(deduplicateItems(scanned), filters);
      setItems(filtered);
      setSelected(new Set(filtered.map(itemKey)));
      setPage(1);
      setView('preview');
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setScanningSection(null);
      setScannedCount(0);
      setWorking(false);
    }
  };

  const startQueue = async (queueItems: RedditItem[]): Promise<void> => {
    const ordered = [...queueItems].sort((a, b) => Number(a.action === 'delete') - Number(b.action === 'delete'));
    const options: ActionOptions = { overwriteComments, overwriteText, hideAfterUnvote };
    setWorking(true);
    setError('');
    try {
      const actionWorker = await sessionClient.createActionWorker();
      setResults([]);
      setQueue({ ...EMPTY_QUEUE, total: ordered.length });
      setView('running');
      const nextQueue = new ActionQueue(ordered, actionWorker, options, {
        onUpdate: setQueue,
        onResult: (result) => setResults((current) => [...current, result]),
      });
      queueRef.current = nextQueue;
      await nextQueue.run();
      setView('done');
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setWorking(false);
    }
  };

  const runSelected = (): void => {
    if (selectedItems.length === 0) return;
    if (includesDeletion && confirmText !== 'DELETE') return;
    void startQueue(selectedItems);
  };

  const toggleItem = (item: RedditItem): void => {
    const key = itemKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exportItems = (format: 'json' | 'csv'): void => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      download(`cleanslate-reddit-preview-${stamp}.json`, JSON.stringify(selectedItems, null, 2), 'application/json');
      return;
    }
    const header = ['action', 'kind', 'subreddit', 'score', 'created', 'permalink', 'text'];
    const rows = selectedItems.map((item) =>
      [
        item.action,
        item.kind,
        item.subreddit,
        item.score,
        new Date(item.createdUtc * 1000).toISOString(),
        item.permalink,
        displayText(item),
      ]
        .map(csvCell)
        .join(','),
    );
    download(`cleanslate-reddit-preview-${stamp}.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
  };

  const resetScan = (): void => {
    setItems([]);
    setSelected(new Set());
    setResults([]);
    setQueue(EMPTY_QUEUE);
    setConfirmText('');
    setView('scan');
  };

  const renderSetup = () => (
    <div className="setup-card">
      <div className="eyebrow">{t('sessionMode')} · {t('privacy')}</div>
      <h2>{t('loginTitle')}</h2>
      <p>{t('loginBody')}</p>
      <div className="button-row">
        <a className="button ghost" href="https://www.reddit.com/login/" target="_blank" rel="noreferrer">
          {t('login')}
        </a>
        <button className="button primary" disabled={working} onClick={() => void refreshSession()}>
          {working ? t('loading') : t('checkAgain')}
        </button>
      </div>
    </div>
  );

  const renderScanner = () => (
    <div className="workspace-grid">
      <section className="surface">
        <div className="section-heading">
          <div>
            <span className="step">01</span>
            <h2>{t('sectionsTitle')}</h2>
          </div>
          <span className="connected"><i />u/{auth?.username}</span>
        </div>
        <div className="section-grid">
          {SECTIONS.map((section, index) => (
            <button
              key={section}
              className={`section-toggle ${sections.has(section) ? 'active' : ''}`}
              onClick={() => toggleSection(section)}
              aria-pressed={sections.has(section)}
            >
              <span className="section-index">{String(index + 1).padStart(2, '0')}</span>
              <span className={`action-dot action-${section}`} />
              <span className="section-copy">
                <strong>{sectionLabel(section)}</strong>
                <small>{section === 'saved' ? t('unsaveAction') : section === 'upvoted' || section === 'downvoted' ? t('unvoteAction') : t('deleteAction')}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="surface filters-surface">
        <div className="section-heading">
          <div><span className="step">02</span><h2>{t('filtersTitle')}</h2></div>
        </div>
        <div className="filter-grid">
          <label className="field span-2">
            <span>{t('search')}</span>
            <input value={filters.query} onChange={(event) => setFilter('query', event.currentTarget.value)} placeholder={t('searchPlaceholder')} />
          </label>
          <label className="field">
            <span>{t('subreddit')}</span>
            <input value={filters.subreddit} onChange={(event) => setFilter('subreddit', event.currentTarget.value)} placeholder={t('subredditPlaceholder')} />
          </label>
          <label className="field">
            <span>{t('excluded')}</span>
            <input value={filters.excludedSubreddits} onChange={(event) => setFilter('excludedSubreddits', event.currentTarget.value)} placeholder={t('subredditPlaceholder')} />
          </label>
          <NumberInput value={filters.minScore} label={`${t('scoreRange')} · ${t('minimum')}`} onChange={(value) => setFilter('minScore', value)} />
          <NumberInput value={filters.maxScore} label={`${t('scoreRange')} · ${t('maximum')}`} onChange={(value) => setFilter('maxScore', value)} />
          <label className="field"><span>{t('after')}</span><input type="date" value={filters.afterDate} onChange={(event) => setFilter('afterDate', event.currentTarget.value)} /></label>
          <label className="field"><span>{t('before')}</span><input type="date" value={filters.beforeDate} onChange={(event) => setFilter('beforeDate', event.currentTarget.value)} /></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={filters.includeNsfw} onChange={(event) => setFilter('includeNsfw', event.currentTarget.checked)} /><span>{t('includeNsfw')}</span></label>
      </section>
      <button className="button primary scan-button" disabled={working} onClick={() => void scan()}>
        {scanningSection ? `${t('scanning')} · ${sectionLabel(scanningSection)} · ${scannedCount}` : t('scan')}
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );

  const renderPreview = () => (
    <div className="preview">
      <div className="preview-head">
        <div><span className="step">03</span><h2>{t('previewTitle')}</h2><p><strong>{items.length}</strong> {t('found')} · <strong>{selectedItems.length}</strong> {t('selected')}</p></div>
        <div className="button-row compact">
          <button className="button ghost small" onClick={() => setSelected(new Set(items.map(itemKey)))}>{t('selectAll')}</button>
          <button className="button ghost small" onClick={() => setSelected(new Set())}>{t('selectNone')}</button>
          <button className="button ghost small" disabled={!selectedItems.length} onClick={() => exportItems('json')}>{t('exportJson')}</button>
          <button className="button ghost small" disabled={!selectedItems.length} onClick={() => exportItems('csv')}>{t('exportCsv')}</button>
        </div>
      </div>

      {items.length === 0 ? <div className="empty-state">{t('noItems')}</div> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="check-cell" /><th>{t('item')}</th><th>{t('action')}</th><th>{t('score')}</th><th>{t('date')}</th></tr></thead>
              <tbody>
                {visibleItems.map((item) => (
                  <tr key={itemKey(item)} className={selected.has(itemKey(item)) ? 'is-selected' : ''}>
                    <td className="check-cell"><input type="checkbox" checked={selected.has(itemKey(item))} onChange={() => toggleItem(item)} aria-label={displayText(item)} /></td>
                    <td><a href={`https://www.reddit.com${item.permalink}`} target="_blank" rel="noreferrer" title={t('viewOnReddit')}>{displayText(item)}</a><small>r/{item.subreddit} · {sectionLabel(item.source)}</small></td>
                    <td><span className={`action-badge ${item.action}`}>{actionLabel(item, hideAfterUnvote)}</span></td>
                    <td>{item.score}</td>
                    <td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(item.createdUtc * 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && <div className="pagination"><button className="button ghost small" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>{t('previous')}</button><span>{t('page')} {page} {t('of')} {pageCount}</span><button className="button ghost small" disabled={page === pageCount} onClick={() => setPage((value) => value + 1)}>{t('next')}</button></div>}
        </>
      )}

      <div className="execution-card">
        <label className="check-row"><input type="checkbox" checked={overwriteComments} onChange={(event) => setOverwriteComments(event.currentTarget.checked)} /><span>{t('overwrite')}</span></label>
        {includesUnvotedPosts && <label className="check-row"><input type="checkbox" checked={hideAfterUnvote} onChange={(event) => setHideAfterUnvote(event.currentTarget.checked)} /><span><strong>{t('hideAfterUnvote')}</strong><small>{t('hideAfterUnvoteHint')}</small></span></label>}
        {overwriteComments && <label className="field"><span>{t('overwriteText')}</span><input value={overwriteText} maxLength={500} onChange={(event) => setOverwriteText(event.currentTarget.value)} /></label>}
        {includesDeletion && <label className="field danger-field"><span>{t('confirm')}</span><input value={confirmText} onChange={(event) => setConfirmText(event.currentTarget.value)} placeholder={t('confirmPlaceholder')} autoComplete="off" /><small>{t('destructiveWarning')}</small></label>}
        <div className="button-row"><button className="button ghost" onClick={resetScan}>{t('newScan')}</button><button className="button danger" disabled={working || !selectedItems.length || (includesDeletion && confirmText !== 'DELETE')} onClick={runSelected}>{working ? t('loading') : `${t('run')} · ${selectedItems.length}`}</button></div>
      </div>
    </div>
  );

  const renderProgress = () => {
    const percent = queue.total ? Math.round((queue.completed / queue.total) * 100) : 0;
    const waitSeconds = queue.rateLimitUntil === null
      ? 0
      : Math.max(0, Math.ceil((queue.rateLimitUntil - clock) / 1_000));
    const waitLabel = waitSeconds >= 60
      ? `${Math.ceil(waitSeconds / 60)} ${t('minutesShort')}`
      : `${waitSeconds} ${t('secondsShort')}`;
    return <div className="progress-view">
      <div className="progress-orbit"><span>{percent}%</span></div>
      <h2>{t('progress')}</h2>
      <p>{queue.current ? displayText(queue.current) : t('loading')}</p>
      {queue.rateLimitUntil !== null && <div className="rate-limit-banner" role="status" aria-live="polite">
        <span className="rate-limit-icon" aria-hidden="true">!</span>
        <span><strong>{t('rateLimitTitle')}</strong><small>{t('rateLimitBody')} {t('resumeIn')} {waitLabel}.</small></span>
      </div>}
      <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
      <div className="metric-grid"><div><strong>{queue.completed}</strong><span>{t('completed')}</span></div><div className="success"><strong>{queue.succeeded}</strong><span>{t('succeeded')}</span></div><div className="failure"><strong>{queue.failed}</strong><span>{t('failed')}</span></div></div>
      <div className="button-row centered">
        <button className="button secondary" onClick={() => queue.state === 'paused' ? queueRef.current?.resume() : queueRef.current?.pause()}>{queue.state === 'paused' ? t('resume') : t('pause')}</button>
        <button className="button ghost" onClick={() => queueRef.current?.cancel()}>{t('stop')}</button>
      </div>
    </div>;
  };

  const renderDone = () => {
    const failedItems = results.filter((result) => !result.ok).map((result) => result.item);
    return <div className="done-view"><div className={`done-mark ${queue.state === 'cancelled' ? 'cancelled' : ''}`}>{queue.state === 'cancelled' ? '■' : '✓'}</div><h2>{queue.state === 'cancelled' ? t('cancelled') : t('done')}</h2><div className="metric-grid"><div><strong>{queue.completed}</strong><span>{t('completed')}</span></div><div className="success"><strong>{queue.succeeded}</strong><span>{t('succeeded')}</span></div><div className="failure"><strong>{queue.failed}</strong><span>{t('failed')}</span></div></div>{failedItems.length > 0 && <div className="error-list">{results.filter((result) => !result.ok).slice(0, 10).map((result) => <p key={itemKey(result.item)}><strong>{displayText(result.item)}</strong><span>{result.error}</span></p>)}</div>}<div className="button-row centered">{failedItems.length > 0 && <button className="button secondary" onClick={() => void startQueue(failedItems)}>{t('retryErrors')}</button>}<button className="button primary" onClick={resetScan}>{t('newScan')}</button></div></div>;
  };

  return (
    <div className="cleaner-root">
      <button className="cleaner-fab" onClick={() => setOpen((value) => !value)} aria-label={t('open')} aria-expanded={open}>
        <span className="fab-symbol"><CleanSlateGlyph /></span>
        <span className="fab-label">CleanSlate</span>
        {view === 'running' && <span className="fab-progress">{queue.completed}/{queue.total}</span>}
      </button>

      {open && <div className="modal-layer" role="dialog" aria-modal="true" aria-label={t('appName')}>
        <button className="backdrop" onClick={() => setOpen(false)} aria-label={t('close')} />
        <main className="panel">
          <header className="app-header">
            <div className="brand"><span className="brand-mark"><CleanSlateGlyph /></span><div><span className="brand-kicker">{t('workspace')}</span><h1>{t('appName')}</h1><p>{t('tagline')}</p></div></div>
            <div className="header-actions">
              <a className="github-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label={t('sourceCode')}>
                <span aria-hidden="true">&lt;/&gt;</span> GitHub
              </a>
              <button className="close-button" onClick={() => setOpen(false)} aria-label={t('close')}>×</button>
            </div>
          </header>
          <div className="panel-body">
            {error && <div className="alert"><strong>{t('genericError')}</strong><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
            {loading || !auth ? <div className="loading-state">{t('loading')}</div> : !auth.connected ? renderSetup() : view === 'scan' ? renderScanner() : view === 'preview' ? renderPreview() : view === 'running' ? renderProgress() : renderDone()}
          </div>
          <footer><span className="privacy-dot" />{t('localOnly')}<a className="footer-source" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">{t('sourceCode')} ↗</a></footer>
        </main>
      </div>}
    </div>
  );
}
