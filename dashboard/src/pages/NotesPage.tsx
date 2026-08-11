/**
 * Notes and tags — the human half of the dataset.
 *
 * Everything the analytics page can ever say about *why* a night went the way
 * it did is computed from what gets written here, which makes this page's real
 * design constraint an unusual one: **it has to be quicker to log something
 * than to skip it.** So the composer is open on arrival with the cursor ready,
 * the one-tap row sits above it for the three or four things that happen every
 * evening, and the journal and the tag manager are below rather than in front.
 *
 * Filters live in the URL. "Every night we gave him dessert" is a link worth
 * keeping, and it survives a reload at 3am when nobody wants to rebuild it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  IconButton,
  CloseIcon,
  Skeleton,
  Spinner,
  describeError,
  useToast,
} from '../components';
import { NoteComposer } from '../components/NoteComposer';
import { QuickTagRow } from '../components/QuickTagRow';
import { useEventStream } from '../hooks/useEventStream';
import {
  children as childrenApi,
  notes as notesApi,
  system as systemApi,
  tags as tagsApi,
} from '../lib/api';
import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  nightLabel,
  nightOf as computeNightOf,
  setDefaultTimezone,
  shiftNightOf,
} from '../lib/format';
import { DEFAULT_MIN_NIGHTS, sortTagsForPicker, tagLabel } from '../lib/notesModel';
import type { Note, TagWithStats } from '../lib/types';
import { ConfirmDialog } from './notes/ConfirmDialog';
import { NotesTimeline } from './notes/NotesTimeline';
import { TagManager } from './notes/TagManager';
import './NotesPage.css';

/** One page of journal. "Show more" grows the window rather than paginating. */
const PAGE_SIZE = 50;

type View = 'journal' | 'tags';

const RANGES = [
  { value: '30', label: 'Last 30 nights' },
  { value: '90', label: 'Last 90 nights' },
  { value: '365', label: 'Last year' },
  { value: 'all', label: 'Everything' },
] as const;

type RangeValue = (typeof RANGES)[number]['value'];

export function NotesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const view: View = params.get('view') === 'tags' ? 'tags' : 'journal';
  const tagFilter = useMemo(() => {
    const raw = params.get('tag');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [params]);
  const range = (params.get('range') ?? '90') as RangeValue;
  const queryText = params.get('q') ?? '';

  const [searchInput, setSearchInput] = useState(queryText);
  const [debounced, setDebounced] = useState(queryText);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);

  // Typing should not fire a request per keystroke, but the URL should still
  // end up holding what was searched for.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (debounced) next.set('q', debounced);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [debounced, setParams]);

  // -- Who and when ---------------------------------------------------------

  const childrenQuery = useQuery({
    queryKey: ['children'],
    queryFn: ({ signal }) => childrenApi.list({}, signal),
    staleTime: 5 * 60_000,
  });

  const child = useMemo(() => {
    const items = childrenQuery.data?.items ?? [];
    return items.find((candidate) => candidate.active) ?? items[0];
  }, [childrenQuery.data]);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => systemApi.config(signal),
    staleTime: 10 * 60_000,
  });

  const timezone = child?.timezone ?? configQuery.data?.site?.timezone ?? null;
  const boundaryHour = child?.day_boundary_hour ?? DEFAULT_DAY_BOUNDARY_HOUR;

  useEffect(() => {
    setDefaultTimezone(timezone);
  }, [timezone]);

  // A tab left open overnight must not keep logging to yesterday, so the
  // current night is state on a slow timer rather than a value read at render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const tonight = computeNightOf(now, { tz: timezone, boundaryHour });

  const minNights = readMinNights(configQuery.data);
  const minNightsTotal = readMinNightsTotal(configQuery.data);

  // -- The journal ----------------------------------------------------------

  const from = range === 'all' ? undefined : shiftNightOf(tonight, -Number(range));

  const notesQuery = useQuery({
    queryKey: ['notes', 'journal', child?.id ?? null, from ?? 'all', tagFilter.join(','), debounced, limit],
    queryFn: ({ signal }) =>
      notesApi.list(
        {
          child_id: child?.id,
          from,
          tag: tagFilter.length > 0 ? tagFilter : undefined,
          q: debounced || undefined,
          limit,
        },
        signal,
      ),
    staleTime: 15_000,
  });

  const tagsQuery = useQuery({
    queryKey: ['tags', 'with-stats'],
    queryFn: ({ signal }) => tagsApi.list({ with_stats: true }, signal),
    staleTime: 60_000,
  });

  const tagsBySlug = useMemo(() => {
    const map = new Map<string, TagWithStats>();
    for (const tag of tagsQuery.data?.items ?? []) map.set(tag.slug, tag);
    return map;
  }, [tagsQuery.data]);

  const filterableTags = useMemo(
    () => sortTagsForPicker((tagsQuery.data?.items ?? []).filter((tag) => !tag.archived)).slice(0, 14),
    [tagsQuery.data],
  );

  // A note posted from HomeKit, a shortcut or another phone lands here too.
  const { subscribe } = useEventStream({ childId: child?.id, types: ['note'] });
  useEffect(() => {
    return subscribe('note', () => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
    });
  }, [subscribe, queryClient]);

  const remove = useMutation({
    mutationFn: (note: Note) => notesApi.remove(note.id),
    onSuccess: () => {
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success('Note deleted.');
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
  });

  // -- URL helpers ----------------------------------------------------------

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const toggleTag = useCallback(
    (slug: string) => {
      const next = tagFilter.includes(slug)
        ? tagFilter.filter((entry) => entry !== slug)
        : [...tagFilter, slug];
      setLimit(PAGE_SIZE);
      setParam('tag', next.join(','));
    },
    [tagFilter, setParam],
  );

  const notes = notesQuery.data?.items ?? [];
  const total = notesQuery.data?.total ?? notes.length;
  const filtered = tagFilter.length > 0 || debounced.length > 0;
  const activeTags = useMemo(() => new Set(tagFilter), [tagFilter]);

  return (
    <div className="notes-page">
      <nav className="notes-page__tabs" aria-label="Notes sections">
        <button
          type="button"
          className={view === 'journal' ? 'notes-page__tab is-active' : 'notes-page__tab'}
          aria-current={view === 'journal' ? 'page' : undefined}
          onClick={() => setParam('view', null)}
        >
          Journal
        </button>
        <button
          type="button"
          className={view === 'tags' ? 'notes-page__tab is-active' : 'notes-page__tab'}
          aria-current={view === 'tags' ? 'page' : undefined}
          onClick={() => setParam('view', 'tags')}
        >
          Tags
        </button>
      </nav>

      {view === 'tags' ? (
        <TagManager minNights={minNights} minNightsTotal={minNightsTotal} />
      ) : (
        <>
          <Card
            title={`Log something for ${nightLabel(tonight).toLowerCase()}`}
            subtitle="One tap for the usual things; the box below for everything else."
          >
            <div className="notes-page__entry">
              <QuickTagRow childId={child?.id} nightOf={tonight} timezone={timezone} />
              <NoteComposer
                childId={child?.id}
                nightOf={tonight}
                timezone={timezone}
                boundaryHour={boundaryHour}
              />
            </div>
          </Card>

          <Card
            title="Journal"
            subtitle={
              notesQuery.isPending
                ? 'Loading…'
                : `${total} ${total === 1 ? 'note' : 'notes'}${filtered ? ' matching' : ''}`
            }
          >
            <div className="notes-page__filters">
              <div className="notes-page__search">
                <label className="visually-hidden" htmlFor="notes-search">
                  Search notes
                </label>
                <input
                  id="notes-search"
                  className="input"
                  type="search"
                  value={searchInput}
                  placeholder="Search what you wrote"
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                />
                {searchInput ? (
                  <IconButton
                    label="Clear search"
                    icon={<CloseIcon size={16} />}
                    size="sm"
                    onClick={() => setSearchInput('')}
                  />
                ) : null}
              </div>

              <div className="notes-page__range">
                <label className="visually-hidden" htmlFor="notes-range">
                  Nights to show
                </label>
                <select
                  id="notes-range"
                  className="input notes-page__select"
                  value={range}
                  onChange={(event) => {
                    setLimit(PAGE_SIZE);
                    setParam('range', event.target.value === '90' ? null : event.target.value);
                  }}
                >
                  {RANGES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>

              {tagsQuery.isPending ? (
                <div className="chip-row" aria-busy="true">
                  {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} width="6rem" height="2.25rem" shape="block" />
                  ))}
                </div>
              ) : (
                <div className="chip-row" role="group" aria-label="Filter by tag">
                  {filterableTags.map((tag) => (
                    <Chip
                      key={tag.slug}
                      selected={activeTags.has(tag.slug)}
                      onClick={() => toggleTag(tag.slug)}
                    >
                      {tagLabel(tag)}
                    </Chip>
                  ))}
                </div>
              )}

              {filtered ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchInput('');
                    setLimit(PAGE_SIZE);
                    setParam('tag', null);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          </Card>

          {notesQuery.isPending ? (
            <Card>
              <div aria-busy="true" className="notes-page__loading">
                <span className="visually-hidden">Loading notes</span>
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} height="5rem" shape="block" />
                ))}
              </div>
            </Card>
          ) : notesQuery.error ? (
            <Card>
              <ErrorState error={notesQuery.error} onRetry={() => void notesQuery.refetch()} />
            </Card>
          ) : (
            <NotesTimeline
              notes={notes}
              childId={child?.id}
              timezone={timezone}
              boundaryHour={boundaryHour}
              tagsBySlug={tagsBySlug}
              editingId={editingId}
              onEdit={setEditingId}
              onDelete={setPendingDelete}
              onFilterTag={toggleTag}
              activeTags={activeTags}
            />
          )}

          {notes.length < total ? (
            <div className="notes-page__more">
              <Button
                variant="secondary"
                onClick={() => setLimit((current) => current + PAGE_SIZE)}
                disabled={notesQuery.isFetching}
              >
                {notesQuery.isFetching ? <Spinner size={16} /> : null}
                Show more ({total - notes.length} older)
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this note?"
        description={
          <>
            {pendingDelete?.body ? <q>{pendingDelete.body}</q> : 'This note'} will be removed from the
            journal and from the analysis. There is no undo.
          </>
        }
        confirmLabel="Delete note"
        busy={remove.isPending}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

/**
 * `GET /api/config` is typed loosely on purpose, and the service wraps the
 * effective config in `{"config": …}`. Read through both shapes so the gate
 * shown here is the gate the API actually applies.
 */
function analyticsSection(config: unknown): Record<string, unknown> | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const root = config as Record<string, unknown>;
  const inner = typeof root.config === 'object' && root.config !== null ? (root.config as Record<string, unknown>) : root;
  const analytics = inner.analytics;
  return typeof analytics === 'object' && analytics !== null
    ? (analytics as Record<string, unknown>)
    : undefined;
}

function readMinNights(config: unknown): number {
  const value = analyticsSection(config)?.min_nights_per_group;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_NIGHTS;
}

function readMinNightsTotal(config: unknown): number | null {
  const value = analyticsSection(config)?.min_nights_total;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export default NotesPage;
