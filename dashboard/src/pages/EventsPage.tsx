import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { events as eventsApi } from '../lib/api';
import type { EventsQuery } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  SeverityBadge,
  Select,
  Skeleton,
  describeError,
  useToast,
} from '../components';
import { CheckIcon, EventsIcon } from '../components/Icons';
import { ClipPlayer } from '../components/ClipPlayer';
import { EventLabelPicker } from '../components/EventLabelPicker';
import {
  eventLabelText,
  formatClock,
  formatDbfs,
  formatDuration,
  formatPercent,
  nightLabel,
  shiftNightOf,
  titleCase,
} from '../lib/format';
import { EVENT_KINDS, effectiveLabel, isFalsePositive } from '../lib/types';
import type { BabyEvent, EventKind, NightOf } from '../lib/types';
import './EventsPage.css';

// ---------------------------------------------------------------------------
// Filter state, held in the URL
// ---------------------------------------------------------------------------

/**
 * Filters live in the query string rather than in component state. It costs
 * nothing and it buys the back button, a reloadable page, and a link you can
 * send yourself — "every cry over 80% confidence last week" is a URL.
 */
interface Filters {
  from: NightOf | '';
  to: NightOf | '';
  kind: EventKind | '';
  label: string;
  minConfidence: string;
  acknowledged: '' | 'yes' | 'no';
  order: 'desc' | 'asc';
  limit: number;
  offset: number;
}

const DEFAULTS: Filters = {
  from: '',
  to: '',
  kind: '',
  label: '',
  minConfidence: '',
  acknowledged: '',
  order: 'desc',
  limit: 50,
  offset: 0,
};

function readFilters(params: URLSearchParams): Filters {
  const single = params.get('night_of');
  const kind = params.get('kind');
  const acknowledged = params.get('acknowledged');
  const limit = Number(params.get('limit'));
  const offset = Number(params.get('offset'));

  return {
    // A deep link from a night page arrives as ?night_of=…, which is just a
    // one-day range as far as this screen is concerned.
    from: params.get('from') ?? single ?? '',
    to: params.get('to') ?? single ?? '',
    kind: isKind(kind) ? kind : '',
    label: params.get('label') ?? '',
    minConfidence: params.get('min_confidence') ?? '',
    acknowledged: acknowledged === 'yes' || acknowledged === 'no' ? acknowledged : '',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    limit: [25, 50, 100].includes(limit) ? limit : DEFAULTS.limit,
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}

function writeFilters(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from && filters.from === filters.to) {
    params.set('night_of', filters.from);
  } else {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.label) params.set('label', filters.label);
  if (filters.minConfidence) params.set('min_confidence', filters.minConfidence);
  if (filters.acknowledged) params.set('acknowledged', filters.acknowledged);
  if (filters.order !== DEFAULTS.order) params.set('order', filters.order);
  if (filters.limit !== DEFAULTS.limit) params.set('limit', String(filters.limit));
  if (filters.offset > 0) params.set('offset', String(filters.offset));
  return params;
}

function isKind(value: string | null): value is EventKind {
  return value !== null && (EVENT_KINDS as readonly string[]).includes(value);
}

function toQuery(filters: Filters): EventsQuery {
  const query: EventsQuery = {
    limit: filters.limit,
    offset: filters.offset,
    order: filters.order,
  };

  // A night range goes to the server as night keys, not as instants. Turning
  // "the 3rd to the 7th" into milliseconds here would need the child's
  // timezone and day boundary, and this page would have used the browser's —
  // which returns the wrong events to anyone opening the dashboard from
  // another zone, silently and only near the boundary.
  if (filters.from && filters.from === filters.to) {
    query.night_of = filters.from;
  } else {
    if (filters.from) query.night_from = filters.from;
    if (filters.to) query.night_to = filters.to;
  }

  if (filters.kind) query.kind = filters.kind;
  if (filters.label) query.label = filters.label;
  if (filters.minConfidence) query.min_confidence = Number(filters.minConfidence);
  if (filters.acknowledged) query.acknowledged = filters.acknowledged === 'yes';
  return query;
}

function activeFilterCount(filters: Filters): number {
  let count = 0;
  if (filters.from || filters.to) count += 1;
  if (filters.kind) count += 1;
  if (filters.label) count += 1;
  if (filters.minConfidence) count += 1;
  if (filters.acknowledged) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * The event log across every night.
 *
 * The point of this screen is not browsing, it is *correction*. Every mislabel
 * a parent fixes here is training data the detector-tuning report reads, and
 * the only version of that loop anyone actually uses is the one that costs a
 * single tap — so the label buttons sit in the row, not behind a dialog.
 */
export function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState<number | null>(null);

  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const query = useMemo(() => toQuery(filters), [filters]);

  const update = useCallback(
    (patch: Partial<Filters>) => {
      // Any filter change resets paging: page 4 of the old result set is a
      // different set of events, and landing on an empty page reads as a bug.
      const next = { ...filters, ...patch };
      if (!('offset' in patch)) next.offset = 0;
      setSearchParams(writeFilters(next), { replace: true });
    },
    [filters, setSearchParams],
  );

  const list = useQuery({
    queryKey: ['events', query],
    queryFn: ({ signal }) => eventsApi.list(query, signal),
    placeholderData: keepPreviousData,
  });

  const correct = useMutation({
    mutationFn: ({ id, corrected }: { id: number; corrected: string | null }) =>
      eventsApi.update(id, { corrected_label: corrected }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['night'] });
      toast.success(
        variables.corrected === ''
          ? 'Marked as not a real event.'
          : variables.corrected === null
            ? 'Correction removed.'
            : `Relabelled as ${eventLabelText(variables.corrected)}.`,
      );
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const acknowledge = useMutation({
    mutationFn: ({ id, value }: { id: number; value: boolean }) =>
      eventsApi.acknowledge(id, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const showingFrom = total === 0 ? 0 : filters.offset + 1;
  const showingTo = Math.min(filters.offset + filters.limit, total);
  const count = activeFilterCount(filters);

  return (
    <div className="events-page">
      <FilterPanel filters={filters} onChange={update} activeCount={count} />

      <Card
        title="Events"
        subtitle={
          list.isPending
            ? 'Loading…'
            : total === 0
              ? 'Nothing matches these filters.'
              : `Showing ${showingFrom}–${showingTo} of ${total}.`
        }
        actions={
          <Select
            label="Order"
            hideLabel
            size="sm"
            value={filters.order}
            onValueChange={(value) => update({ order: value })}
            options={[
              { value: 'desc', label: 'Newest first' },
              { value: 'asc', label: 'Oldest first' },
            ]}
          />
        }
      >
        {list.isPending ? (
          <div aria-busy="true" aria-live="polite" className="events-page__loading">
            <span className="visually-hidden">Loading events</span>
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} height={56} shape="block" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<EventsIcon size={28} />}
            title="No events match"
            description={
              count > 0
                ? 'Try widening the date range or clearing a filter.'
                : 'The monitor has not logged anything yet.'
            }
            action={
              count > 0 ? (
                <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="events-list" data-stale={list.isPlaceholderData ? 'true' : undefined}>
            {items.map((event) => (
              <li key={event.id}>
                <EventRow
                  event={event}
                  expanded={expanded === event.id}
                  onToggle={() => setExpanded((current) => (current === event.id ? null : event.id))}
                  onCorrect={(corrected) => correct.mutate({ id: event.id, corrected })}
                  onAcknowledge={(value) => acknowledge.mutate({ id: event.id, value })}
                  busy={correct.isPending && correct.variables?.id === event.id}
                />
              </li>
            ))}
          </ul>
        )}

        {total > filters.limit ? (
          <nav className="events-page__pager" aria-label="Event pages">
            <Button
              variant="secondary"
              disabled={filters.offset === 0}
              onClick={() => update({ offset: Math.max(0, filters.offset - filters.limit) })}
            >
              Newer
            </Button>
            <span className="events-page__pager-text" data-numeric>
              {showingFrom}–{showingTo} of {total}
            </span>
            <Button
              variant="secondary"
              disabled={showingTo >= total}
              onClick={() => update({ offset: filters.offset + filters.limit })}
            >
              Older
            </Button>
          </nav>
        ) : null}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any kind' },
  ...EVENT_KINDS.map((kind) => ({ value: kind, label: titleCase(kind) })),
];

const CONFIDENCE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any confidence' },
  { value: '0.5', label: '50% and up' },
  { value: '0.7', label: '70% and up' },
  { value: '0.85', label: '85% and up' },
  { value: '0.95', label: '95% and up' },
];

const ACK_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Seen or not' },
  { value: 'no', label: 'Not yet seen' },
  { value: 'yes', label: 'Already seen' },
];

/** The labels worth offering as a filter, grouped the way the detector emits. */
const LABEL_SUGGESTIONS = [
  'cry',
  'fuss',
  'whimper',
  'scream',
  'talk',
  'cough',
  'snore',
  'laugh',
  'door',
  'noise',
  'motion',
  'restless',
  'awakening',
  'back_to_sleep',
  'final_wake',
  'temp_high',
  'temp_low',
  'checked_in',
  'fed',
];

function FilterPanel({
  filters,
  onChange,
  activeCount,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="Filters"
      subtitle={activeCount === 0 ? 'Showing everything.' : `${activeCount} active.`}
      actions={
        <div className="events-filters__actions">
          {activeCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  from: '',
                  to: '',
                  kind: '',
                  label: '',
                  minConfidence: '',
                  acknowledged: '',
                })
              }
            >
              Clear
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className="events-filters__toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        </div>
      }
    >
      <div className={open ? 'events-filters is-open' : 'events-filters'}>
        <div className="events-filters__presets">
          <Chip selected={!filters.from && !filters.to} onClick={() => onChange({ from: '', to: '' })}>
            All nights
          </Chip>
          <Chip
            selected={isPreset(filters, 0)}
            onClick={() => onChange(presetRange(0))}
          >
            Tonight
          </Chip>
          <Chip selected={isPreset(filters, 6)} onClick={() => onChange(presetRange(6))}>
            Last 7 nights
          </Chip>
          <Chip selected={isPreset(filters, 29)} onClick={() => onChange(presetRange(29))}>
            Last 30 nights
          </Chip>
        </div>

        <div className="events-filters__grid">
          <label className="events-filters__field">
            <span className="events-filters__label">From night</span>
            <input
              type="date"
              className="events-filters__input"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </label>

          <label className="events-filters__field">
            <span className="events-filters__label">To night</span>
            <input
              type="date"
              className="events-filters__input"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </label>

          <Select
            label="Kind"
            value={filters.kind}
            onValueChange={(value) => onChange({ kind: (value as EventKind | '') || '' })}
            options={KIND_OPTIONS}
          />

          <label className="events-filters__field">
            <span className="events-filters__label">Label</span>
            <input
              type="text"
              className="events-filters__input"
              list="events-label-options"
              value={filters.label}
              placeholder="any"
              autoComplete="off"
              onChange={(event) => onChange({ label: event.target.value.trim() })}
            />
            <datalist id="events-label-options">
              {LABEL_SUGGESTIONS.map((label) => (
                <option key={label} value={label}>
                  {eventLabelText(label)}
                </option>
              ))}
            </datalist>
          </label>

          <Select
            label="Confidence"
            value={filters.minConfidence}
            onValueChange={(value) => onChange({ minConfidence: value })}
            options={CONFIDENCE_OPTIONS}
          />

          <Select
            label="Acknowledged"
            value={filters.acknowledged}
            onValueChange={(value) => onChange({ acknowledged: value as Filters['acknowledged'] })}
            options={ACK_OPTIONS}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * The default day boundary, for naming the preset ranges only.
 *
 * This is the one place the browser's clock is the right clock: "last 7 days"
 * is a label on a button, and if the phone thinks it is still yesterday
 * evening the button should say so. The resulting night keys go to the server
 * as keys, so a wrong guess here shifts which button looks selected and never
 * which events come back.
 */
const PRESET_DAY_BOUNDARY_HOUR = 12;

function presetRange(daysBack: number): Partial<Filters> {
  const today = new Date();
  const to = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  // Before the day boundary, "tonight" is still yesterday's night_of.
  const anchor = today.getHours() < PRESET_DAY_BOUNDARY_HOUR ? shiftNightOf(to, -1) : to;
  return { from: shiftNightOf(anchor, -daysBack), to: anchor };
}

function isPreset(filters: Filters, daysBack: number): boolean {
  const preset = presetRange(daysBack);
  return filters.from === preset.from && filters.to === preset.to;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

function EventRow({
  event,
  expanded,
  onToggle,
  onCorrect,
  onAcknowledge,
  busy,
}: {
  event: BabyEvent;
  expanded: boolean;
  onToggle: () => void;
  onCorrect: (corrected: string | null) => void;
  onAcknowledge: (value: boolean) => void;
  busy: boolean;
}) {
  const label = effectiveLabel(event);
  const voided = isFalsePositive(event);
  const acknowledged = event.acknowledged_ms !== null;

  return (
    <article className={voided ? 'event-row is-void' : 'event-row'}>
      <button
        type="button"
        className="event-row__summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="event-row__when">
          <span className="event-row__night">{nightLabel(event.night_of)}</span>
          <span className="event-row__time" data-numeric>
            {formatClock(event.start_ms)}
          </span>
        </span>

        <span className="event-row__what">
          <span className="event-row__label">
            {voided ? 'Not a real event' : eventLabelText(label)}
          </span>
          <span className="event-row__meta">
            {titleCase(event.kind)}
            {event.confidence !== null ? ` · ${formatPercent(event.confidence)}` : ''}
            {event.duration_s !== null ? ` · ${formatDuration(event.duration_s / 60)}` : ''}
          </span>
        </span>

        <span className="event-row__flags">
          {event.corrected_label !== null ? (
            <Badge size="sm" tone="accent">
              Corrected
            </Badge>
          ) : null}
          <SeverityBadge severity={event.severity} />
        </span>
      </button>

      {expanded ? (
        <div className="event-row__detail">
          <dl className="event-row__facts">
            <div>
              <dt>Started</dt>
              <dd>{formatClock(event.start_ms, { seconds: true })}</dd>
            </div>
            <div>
              <dt>Detector said</dt>
              <dd>{eventLabelText(event.label)}</dd>
            </div>
            {event.peak_dbfs !== null ? (
              <div>
                <dt>Peak</dt>
                <dd>{formatDbfs(event.peak_dbfs, { short: true })}</dd>
              </div>
            ) : null}
            <div>
              <dt>Source</dt>
              <dd>{titleCase(event.source)}</dd>
            </div>
            <div>
              <dt>Night</dt>
              <dd>
                <Link to={`/night/${event.night_of}`}>{event.night_of}</Link>
              </dd>
            </div>
          </dl>

          {topClasses(event).length > 0 ? (
            <p className="event-row__classes">
              Heard: {topClasses(event).map(([name, score]) => `${name} ${formatPercent(score)}`).join(', ')}
            </p>
          ) : null}

          <ClipPlayer
            clips={event.media}
            label={`${eventLabelText(label)} at ${formatClock(event.start_ms)}`}
          />

          <EventLabelPicker event={event} busy={busy} onCorrect={onCorrect} />

          <div className="event-row__ack">
            <Button
              size="sm"
              variant={acknowledged ? 'ghost' : 'secondary'}
              iconStart={acknowledged ? <CheckIcon size={16} /> : undefined}
              onClick={() => onAcknowledge(!acknowledged)}
            >
              {acknowledged ? 'Seen' : 'Mark as seen'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="event-row__quick">
          <EventLabelPicker event={event} busy={busy} onCorrect={onCorrect} collapsible />
        </div>
      )}
    </article>
  );
}

/** The classifier's top guesses, when the detector recorded them. */
function topClasses(event: BabyEvent): [string, number][] {
  const classes = event.meta.classes;
  if (!classes) return [];
  return Object.entries(classes)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

export default EventsPage;
