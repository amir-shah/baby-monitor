/**
 * Tonight's last few events.
 *
 * Not the full log — that is what /events is for. This is the "what did I
 * miss" strip: the handful of things that happened since bedtime, newest
 * first, each with the audio clip if the detector kept one.
 *
 * The list is refreshed from `event.open` / `event.close` over SSE rather than
 * polled. `event.open` arrives before the clip has finished being written, so
 * `event.close` is what usually brings the media reference with it — hence a
 * refetch on both rather than an in-place merge of the pushed object.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, PauseIcon, PlayIcon, SeverityBadge, Skeleton } from '../../components';
import { IconButton } from '../../components/IconButton';
import { events as eventsApi, media as mediaApi } from '../../lib/api';
import { eventLabelText, formatClock, formatDurationSeconds } from '../../lib/format';
import { effectiveLabel, isFalsePositive, isOpen } from '../../lib/types';
import type { StreamSubscribe } from '../../hooks/useEventStream';
import type { BabyEvent, MediaRef, NightOf } from '../../lib/types';
import './RecentEvents.css';

const HOW_MANY = 6;

export interface RecentEventsProps {
  childId: number | undefined;
  nightOf: NightOf;
  subscribe: StreamSubscribe;
}

export function RecentEvents({ childId, nightOf, subscribe }: RecentEventsProps) {
  const queryClient = useQueryClient();
  const [playing, setPlaying] = useState<number | null>(null);

  const queryKey = ['events', 'tonight', childId ?? null, nightOf] as const;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      eventsApi.list(
        { child_id: childId, night_of: nightOf, order: 'desc', limit: HOW_MANY },
        signal,
      ),
    staleTime: 15_000,
  });

  useEffect(() => {
    const refresh = (event: BabyEvent) => {
      if (event.night_of !== nightOf) return;
      void queryClient.invalidateQueries({ queryKey });
    };
    const offOpen = subscribe('event.open', refresh);
    const offClose = subscribe('event.close', refresh);
    return () => {
      offOpen();
      offClose();
    };
    // `queryKey` is a fresh array each render; its contents are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, queryClient, nightOf, childId]);

  const stop = useCallback(() => setPlaying(null), []);

  if (query.isPending) {
    return (
      <div className="events-strip" aria-busy="true">
        <span className="visually-hidden">Loading tonight&rsquo;s events</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height="2.5rem" shape="block" />
        ))}
      </div>
    );
  }

  if (query.isError && !query.data) {
    return <ErrorState error={query.error} size="sm" onRetry={() => void query.refetch()} />;
  }

  const items = query.data?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing yet tonight"
        description="Cries, movement and wake-ups will appear here as they happen."
        size="sm"
      />
    );
  }

  return (
    <ul className="events-strip">
      {items.map((event) => (
        <EventRow
          key={event.id}
          event={event}
          playing={playing}
          onPlay={setPlaying}
          onStop={stop}
        />
      ))}
    </ul>
  );
}

function EventRow({
  event,
  playing,
  onPlay,
  onStop,
}: {
  event: BabyEvent;
  playing: number | null;
  onPlay: (mediaId: number) => void;
  onStop: () => void;
}) {
  const label = eventLabelText(effectiveLabel(event));
  const falsePositive = isFalsePositive(event);
  const open = isOpen(event);
  const clip = event.media?.find((entry) => entry.kind === 'audio_clip');

  return (
    <li className={falsePositive ? 'live-event is-dismissed' : 'live-event'}>
      <span className="live-event__play">
        {clip ? (
          <ClipButton
            clip={clip}
            label={label}
            playing={playing === clip.id}
            onPlay={onPlay}
            onStop={onStop}
          />
        ) : null}
      </span>

      <span className="live-event__body">
        <span className="live-event__line">
          <time className="live-event__time" dateTime={new Date(event.start_ms).toISOString()}>
            {formatClock(event.start_ms)}
          </time>
          <span className="live-event__label">{label}</span>
          {event.severity === 'info' ? null : (
            <SeverityBadge severity={event.severity} size="sm" />
          )}
        </span>

        <span className="live-event__meta">
          {falsePositive ? 'Marked as not a real event' : null}
          {!falsePositive && open ? 'Happening now' : null}
          {!falsePositive && !open && event.duration_s !== null
            ? formatDurationSeconds(event.duration_s)
            : null}
          {clip ? (
            <span className="live-event__clip" data-numeric>
              clip {formatDurationSeconds(clip.duration_s ?? null)}
            </span>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/**
 * A play/stop control over a plain `<audio>`.
 *
 * `preload="none"` matters: six rows each eagerly pulling a clip would have the
 * Pi serving megabytes nobody asked for every time the page mounts. The
 * element is only told to fetch when a thumb lands on the button.
 */
function ClipButton({
  clip,
  label,
  playing,
  onPlay,
  onStop,
}: {
  clip: MediaRef;
  label: string;
  playing: boolean;
  onPlay: (mediaId: number) => void;
  onStop: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    if (playing) {
      element.play().catch(() => {
        setFailed(true);
        onStop();
      });
    } else {
      element.pause();
      // Rewind, so re-opening a clip after switching away starts at the top.
      element.currentTime = 0;
    }
  }, [playing, onStop]);

  if (failed) {
    return (
      <IconButton
        label={`${label} clip is unavailable`}
        icon={<PlayIcon size={18} />}
        size="sm"
        disabled
      />
    );
  }

  return (
    <>
      <IconButton
        label={playing ? `Stop the ${label} clip` : `Play the ${label} clip`}
        icon={playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        size="sm"
        variant={playing ? 'solid' : 'ghost'}
        pressed={playing}
        onClick={() => (playing ? onStop() : onPlay(clip.id))}
      />
      <audio
        ref={audioRef}
        preload="none"
        src={mediaApi.fileUrl(clip.id)}
        onEnded={onStop}
        onError={() => setFailed(true)}
      />
    </>
  );
}
