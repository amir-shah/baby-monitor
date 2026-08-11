import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, events as eventsApi, nights as nightsApi } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  Skeleton,
  describeError,
  useToast,
} from '../components';
import { ChevronLeftIcon, ChevronRightIcon, NightIcon, RefreshIcon } from '../components/Icons';
import { NightAdjustDialog } from '../components/NightAdjustDialog';
import { NightMetrics } from '../components/NightMetrics';
import { NightQualityScore } from '../components/NightQualityScore';
import { NightNotesPanel } from '../components/NightNotesPanel';
import { NightTimeline } from '../components/NightTimeline';
import {
  EM_DASH,
  formatCount,
  formatDbfs,
  formatDuration,
  formatHumidity,
  formatPercent,
  formatTemperature,
  nightHeading,
  nightLabel,
  nightOf as nightOfInstant,
  parseNightOf,
  shiftNightOf,
} from '../lib/format';
import type { BabyEvent, NightDetail, NightPatch } from '../lib/types';
import './NightPage.css';

/**
 * One night, end to end.
 *
 * The order of the page is the order the questions get asked at 6am: how bad
 * was it (the score), what actually happened (the numbers), what did it look
 * like (the timeline), what was going on that day (the notes). Everything
 * below the timeline is optional reading.
 */
export function NightPage() {
  const { date } = useParams<{ date: string }>();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adjusting, setAdjusting] = useState(false);

  const childParam = Number(searchParams.get('child'));
  const childId = Number.isFinite(childParam) && childParam > 0 ? childParam : undefined;
  const valid = Boolean(date && parseNightOf(date));

  const nightQuery = useQuery({
    queryKey: ['night', date, childId],
    queryFn: ({ signal }) => nightsApi.get(date as string, { child_id: childId }, signal),
    enabled: valid,
  });

  const night = nightQuery.data;
  const timezone = night?.timezone ?? null;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['night', date] });
    void queryClient.invalidateQueries({ queryKey: ['nights'] });
  }, [queryClient, date]);

  const patchNight = useMutation({
    mutationFn: (patch: NightPatch) => nightsApi.update(date as string, patch, { child_id: childId }),
    onSuccess: () => {
      setAdjusting(false);
      refresh();
      toast.success('Saved. The night is being recomputed.');
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const recompute = useMutation({
    mutationFn: () => nightsApi.recompute(date as string, { child_id: childId }),
    onSuccess: () => {
      refresh();
      toast.success('Recomputed from the raw samples.');
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const correctEvent = useMutation({
    mutationFn: ({ event, corrected }: { event: BabyEvent; corrected: string | null }) =>
      eventsApi.update(event.id, { corrected_label: corrected }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['night', date] });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      toast.success(
        variables.corrected === ''
          ? 'Marked as not a real event. Thanks — that tunes the detector.'
          : 'Label updated.',
      );
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  if (!valid) {
    return (
      <Card>
        <EmptyState
          title="That is not a date"
          description="A night looks like /night/2026-08-10."
          action={
            <Button variant="primary" onClick={() => window.history.back()}>
              Go back
            </Button>
          }
        />
      </Card>
    );
  }

  const nightOfDate = date as string;

  return (
    <div className="night-page">
      <NightNav nightOf={nightOfDate} search={searchParams.toString()} />

      {nightQuery.isPending ? (
        <LoadingNight />
      ) : nightQuery.isError ? (
        <Card>
          {nightQuery.error instanceof ApiError && nightQuery.error.isNotFound ? (
            <EmptyState
              icon={<NightIcon size={28} />}
              title="No record of this night"
              description="Either the monitor was not running, or this date is before it was set up."
            />
          ) : (
            <ErrorState error={nightQuery.error} onRetry={() => void nightQuery.refetch()} />
          )}
        </Card>
      ) : night ? (
        <>
          <NightHeader
            night={night}
            onAdjust={() => setAdjusting(true)}
            onRecompute={() => recompute.mutate()}
            recomputing={recompute.isPending}
          />

          <Card title="Quality score" subtitle="How this night compares with a settled one.">
            <NightQualityScore night={night} />
          </Card>

          <Card title="The numbers" subtitle="Tap the ⓘ beside any term for what it means.">
            <NightMetrics night={night} timezone={timezone} />
          </Card>

          <Card
            title="Timeline"
            subtitle="Sleep, sound and movement across the night, on one clock."
            flush
          >
            <div className="night-page__chart">
              <NightTimeline
                night={night}
                timezone={timezone}
                onCorrectEvent={(event, corrected) => correctEvent.mutate({ event, corrected })}
                correctingEventId={correctEvent.isPending ? correctEvent.variables?.event.id : null}
              />
            </div>
          </Card>

          <RoomCard night={night} />

          <Card
            title="Notes and tags"
            subtitle="What was going on that day. This is what the factor analysis reads."
          >
            <NightNotesPanel
              childId={night.child_id}
              nightOf={nightOfDate}
              notes={night.notes}
              timezone={timezone}
              onChanged={refresh}
            />
          </Card>

          {night.events.length > 0 ? (
            <p className="night-page__all-events">
              <Link to={`/events?night_of=${nightOfDate}`}>
                See all {night.events.length} events for this night
              </Link>
            </p>
          ) : null}

          <NightAdjustDialog
            open={adjusting}
            onClose={() => setAdjusting(false)}
            night={night}
            timezone={timezone}
            onSave={(patch) => patchNight.mutate(patch)}
            busy={patchNight.isPending}
          />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header and navigation
// ---------------------------------------------------------------------------

function NightNav({ nightOf, search }: { nightOf: string; search: string }) {
  const previous = shiftNightOf(nightOf, -1);
  const next = shiftNightOf(nightOf, 1);
  const tonight = nightOfInstant();
  // There is no data in the future, and a "next" that leads nowhere is worse
  // than no button at all.
  const hasNext = next <= tonight;
  const query = search ? `?${search}` : '';

  return (
    <nav className="night-nav" aria-label="Night navigation">
      <Link className="night-nav__link" to={`/night/${previous}${query}`} rel="prev">
        <ChevronLeftIcon size={18} />
        <span className="night-nav__link-text">{nightLabel(previous)}</span>
      </Link>

      <h2 className="night-nav__current">{nightHeading(nightOf)}</h2>

      {hasNext ? (
        <Link className="night-nav__link night-nav__link--next" to={`/night/${next}${query}`} rel="next">
          <span className="night-nav__link-text">{nightLabel(next)}</span>
          <ChevronRightIcon size={18} />
        </Link>
      ) : (
        <span className="night-nav__link is-disabled" aria-hidden="true">
          <span className="night-nav__link-text">{EM_DASH}</span>
          <ChevronRightIcon size={18} />
        </span>
      )}
    </nav>
  );
}

function NightHeader({
  night,
  onAdjust,
  onRecompute,
  recomputing,
}: {
  night: NightDetail;
  onAdjust: () => void;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <div className="night-page__header">
      <div className="night-page__badges">
        {night.excluded ? (
          <Badge tone="warning" dot>
            Excluded{night.exclude_reason ? `: ${night.exclude_reason}` : ''}
          </Badge>
        ) : null}
        {night.status === 'in_progress' ? <Badge tone="accent">Still in progress</Badge> : null}
        {night.status === 'partial' ? <Badge tone="warning">Partial record</Badge> : null}
        {night.coverage !== null && night.coverage < 1 ? (
          <Badge tone="neutral" title="Fraction of the night the sensors were reporting">
            {formatPercent(night.coverage)} coverage
          </Badge>
        ) : null}
      </div>

      <div className="night-page__header-actions">
        <IconButton
          label="Recompute this night from the raw samples"
          icon={<RefreshIcon size={18} />}
          onClick={onRecompute}
          disabled={recomputing}
        />
        <Button variant="secondary" onClick={onAdjust}>
          Correct this night
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room conditions
// ---------------------------------------------------------------------------

function RoomCard({ night }: { night: NightDetail }) {
  const facts: { label: string; value: string }[] = [
    {
      label: 'Temperature',
      value:
        night.temp_c_mean === null
          ? EM_DASH
          : `${formatTemperature(night.temp_c_mean)} (${formatTemperature(night.temp_c_min)}–${formatTemperature(night.temp_c_max)})`,
    },
    { label: 'Humidity', value: formatHumidity(night.humidity_mean) },
    { label: 'Loudest', value: formatDbfs(night.peak_dbfs) },
    { label: 'Average sound', value: formatDbfs(night.mean_dbfs) },
    {
      label: 'Crying',
      value:
        night.cry_events === 0
          ? 'none'
          : `${formatCount(night.cry_events)} × ${formatDuration(night.cry_min)}`,
    },
    { label: 'Other noises', value: formatCount(night.noise_events) },
  ];

  const anyKnown = facts.some((fact) => fact.value !== EM_DASH);
  if (!anyKnown) return null;

  return (
    <Card title="Room and noise" subtitle="Conditions during the sleep period.">
      <dl className="night-room">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd data-numeric>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function LoadingNight() {
  return (
    <div className="night-page__loading" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading this night</span>
      <Card>
        <Skeleton height={132} shape="block" />
      </Card>
      <Card>
        <Skeleton height={96} shape="block" />
      </Card>
      <Card>
        <Skeleton height={200} shape="block" />
      </Card>
    </div>
  );
}

export default NightPage;
