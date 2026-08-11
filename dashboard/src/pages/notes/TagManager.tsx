/**
 * The tag manager.
 *
 * Its real job is not editing labels — it is answering "why isn't my tag in
 * the analysis yet?" before anyone has to ask. The correlation engine refuses
 * to report on a tag with fewer than `analytics.min_nights_per_group` nights
 * behind it, and that gate is invisible from the analytics page (the tag
 * simply is not there). So every row states where it stands against the same
 * number the API uses, read from `GET /api/config` rather than hard-coded, and
 * the header says how many tags have cleared it.
 *
 * Archiving rather than deleting is the API's design and it is worth
 * surfacing: a tag stops being offered, and every night it was ever applied to
 * keeps its history, so the answer to "does dessert matter?" cannot silently
 * change because somebody tidied up.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  PlusIcon,
  Skeleton,
  TagIcon,
  describeError,
  useToast,
} from '../../components';
import { tags as tagsApi } from '../../lib/api';
import { formatRelative, tagCategoryLabel } from '../../lib/format';
import {
  VALUE_TYPE_LABELS,
  sortTagsForManager,
  tagLabel,
  tagReadiness,
} from '../../lib/notesModel';
import type { TagReadinessState } from '../../lib/notesModel';
import type { TagWithStats } from '../../lib/types';
import { TagEditDialog } from './TagEditDialog';
import './TagManager.css';

export interface TagManagerProps {
  /** `analytics.min_nights_per_group` from the effective config. */
  minNights: number;
  /** `analytics.min_nights_total`, shown as context for the whole gate. */
  minNightsTotal?: number | null;
}

type Filter = 'all' | 'ready' | 'waiting' | 'archived';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'In use' },
  { value: 'ready', label: 'Enough nights' },
  { value: 'waiting', label: 'Needs more' },
  { value: 'archived', label: 'Archived' },
];

/** Wording and tone per readiness state. Never colour alone — each has words. */
const READINESS: Record<TagReadinessState, { label: string; tone: 'neutral' | 'success' | 'warning' }> = {
  ready: { label: 'Analysable', tone: 'success' },
  close: { label: 'Almost there', tone: 'warning' },
  sparse: { label: 'Needs more nights', tone: 'warning' },
  unused: { label: 'Never used', tone: 'neutral' },
  'display-only': { label: 'Display only', tone: 'neutral' },
};

export function TagManager({ minNights, minNightsTotal }: TagManagerProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<TagWithStats | null>(null);
  const [creating, setCreating] = useState(false);

  const tagsQuery = useQuery({
    queryKey: ['tags', 'manager'],
    queryFn: ({ signal }) => tagsApi.list({ with_stats: true, include_archived: true }, signal),
    staleTime: 30_000,
  });

  const all = useMemo(() => sortTagsForManager(tagsQuery.data?.items ?? []), [tagsQuery.data]);

  const readyCount = useMemo(
    () => all.filter((tag) => !tag.archived && tagReadiness(tag, minNights).state === 'ready').length,
    [all, minNights],
  );
  const liveCount = all.filter((tag) => !tag.archived).length;

  const shown = useMemo(() => {
    return all.filter((tag) => {
      if (filter === 'archived') return tag.archived;
      if (tag.archived) return false;
      if (filter === 'all') return true;
      const state = tagReadiness(tag, minNights).state;
      if (filter === 'ready') return state === 'ready';
      return state === 'close' || state === 'sparse' || state === 'unused';
    });
  }, [all, filter, minNights]);

  const setArchived = useMutation({
    mutationFn: async ({ tag, archived }: { tag: TagWithStats; archived: boolean }) => {
      if (archived) return tagsApi.remove(tag.id);
      return tagsApi.update(tag.id, { archived: false });
    },
    onSuccess: (_result, { tag, archived }) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.toast(
        archived
          ? `${tagLabel(tag)} archived. Every night it was applied to keeps it.`
          : `${tagLabel(tag)} is back in the list.`,
        {
          action: {
            label: 'Undo',
            onClick: () => setArchived.mutate({ tag, archived: !archived }),
          },
        },
      );
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
  });

  return (
    <Card
      title="Tags"
      subtitle={
        <>
          {readyCount} of {liveCount} {liveCount === 1 ? 'tag has' : 'tags have'} enough nights to be
          analysed. A tag needs {minNights} nights before the analysis will report on it
          {minNightsTotal ? `, and the window needs ${minNightsTotal} analysable nights overall` : ''}.
        </>
      }
      actions={
        <Button variant="secondary" size="sm" iconStart={<PlusIcon size={16} />} onClick={() => setCreating(true)}>
          New tag
        </Button>
      }
    >
      <div className="tags">
        <div className="chip-row tags__filters" role="group" aria-label="Filter tags">
          {FILTERS.map((entry) => (
            <Chip key={entry.value} selected={filter === entry.value} onClick={() => setFilter(entry.value)}>
              {entry.label}
            </Chip>
          ))}
        </div>

        {tagsQuery.isPending ? (
          <div className="tags__list" aria-busy="true">
            <span className="visually-hidden">Loading tags</span>
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height="4.5rem" shape="block" />
            ))}
          </div>
        ) : tagsQuery.error ? (
          <ErrorState error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} size="sm" />
        ) : shown.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<TagIcon size={22} />}
            title={filter === 'archived' ? 'Nothing archived' : 'No tags here'}
            description={
              filter === 'ready'
                ? `Nothing has reached ${minNights} nights yet. Keep logging — this fills up on its own.`
                : 'Tags appear as soon as you use one on a note.'
            }
          />
        ) : (
          <ul className="tags__list">
            {shown.map((tag) => (
              <TagRow
                key={tag.id}
                tag={tag}
                minNights={minNights}
                busy={setArchived.isPending}
                onEdit={() => setEditing(tag)}
                onArchive={(archived) => setArchived.mutate({ tag, archived })}
              />
            ))}
          </ul>
        )}
      </div>

      <TagEditDialog open={creating} onClose={() => setCreating(false)} />
      <TagEditDialog open={editing !== null} tag={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function TagRow({
  tag,
  minNights,
  busy,
  onEdit,
  onArchive,
}: {
  tag: TagWithStats;
  minNights: number;
  busy: boolean;
  onEdit: () => void;
  onArchive: (archived: boolean) => void;
}) {
  const readiness = tagReadiness(tag, minNights);
  const badge = READINESS[readiness.state];
  const progress = Math.max(0, Math.min(1, readiness.nights / Math.max(1, minNights)));

  return (
    <li className={tag.archived ? 'tag-row is-archived' : 'tag-row'}>
      <div className="tag-row__main">
        <div className="tag-row__title">
          {tag.color ? (
            <span className="tag-row__dot" style={{ background: tag.color }} aria-hidden="true" />
          ) : null}
          <span className="tag-row__label">{tagLabel(tag)}</span>
          {tag.builtin ? <Badge size="sm">Built in</Badge> : null}
          {tag.archived ? <Badge size="sm" tone="neutral">Archived</Badge> : null}
        </div>

        <p className="tag-row__meta">
          <code className="tag-row__slug">{tag.slug}</code>
          <span aria-hidden="true">·</span>
          <span>{tagCategoryLabel(tag.category)}</span>
          <span aria-hidden="true">·</span>
          <span>{VALUE_TYPE_LABELS[tag.value_type]}</span>
          {tag.unit ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{tag.unit}</span>
            </>
          ) : null}
        </p>

        <div className="tag-row__usage">
          <Badge tone={badge.tone} size="sm">
            {badge.label}
          </Badge>
          <span className="tag-row__summary">{readiness.summary}</span>
        </div>

        {readiness.state !== 'display-only' ? (
          <div
            className="tag-row__meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={minNights}
            aria-valuenow={Math.min(readiness.nights, minNights)}
            aria-label={`${readiness.nights} of ${minNights} nights needed`}
          >
            <span
              className={readiness.state === 'ready' ? 'tag-row__fill is-ready' : 'tag-row__fill'}
              style={{ inlineSize: `${progress * 100}%` }}
            />
          </div>
        ) : null}

        {tag.last_ms ? (
          <p className="tag-row__last">Last used {formatRelative(tag.last_ms)}</p>
        ) : null}
      </div>

      <div className="tag-row__actions">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        {tag.archived ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onArchive(false)}>
            Restore
          </Button>
        ) : (
          <IconButton
            label={`Archive ${tagLabel(tag)}`}
            icon={<ArchiveIcon />}
            size="sm"
            disabled={busy}
            onClick={() => onArchive(true)}
          />
        )}
      </div>
    </li>
  );
}

/** A box with a lid: archiving puts a tag away, it never destroys it. */
function ArchiveIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M10 12h4" />
    </svg>
  );
}
