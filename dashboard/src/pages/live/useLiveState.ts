/**
 * The data spine of the Live page.
 *
 * One SSE connection, one `/api/state` cache entry, one source of truth. The
 * push channel writes straight into the TanStack cache with
 * `setQueryData`, so every consumer reads the same object whether the value
 * arrived over SSE or over a fallback poll — and `dataUpdatedAt` becomes an
 * honest "when did we last hear from the monitor", which is what the freshness
 * indicators are built on.
 *
 * Polling only runs while the stream is *not* open. On a healthy link the Pi
 * pushes a `state` every `sleep.sample_interval_s` (15 s by default) and the
 * dashboard makes no requests at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { children as childrenApi, state as stateApi, system } from '../../lib/api';
import type { StreamStatus } from '../../lib/api';
import { useEventStream } from '../../hooks/useEventStream';
import type { StreamSubscribe } from '../../hooks/useEventStream';
import { nightOf as computeNightOf, setDefaultTimezone } from '../../lib/format';
import type { Child, EffectiveConfig, EpochMs, LiveState, NightOf, StreamTypeFilter } from '../../lib/types';

/** Only what this page renders. Motion and sound signals are pure noise here. */
const LIVE_STREAM_TYPES: readonly StreamTypeFilter[] = ['state', 'event', 'note'];

/** How much history the sound sparkline keeps. */
export const SOUND_WINDOW_MS = 10 * 60_000;

/** Hard cap on retained points, so a fast sample interval cannot grow forever. */
const SOUND_MAX_POINTS = 400;

/** One sample tick, reduced to what the sparkline draws. */
export interface SoundPoint {
  ts: EpochMs;
  dbfs: number | null;
  floor: number | null;
}

/**
 * The sparkline survives navigating away and back.
 *
 * It is built purely from live ticks — there is no "recent sound" endpoint to
 * seed it from that would not mean pulling the whole night's series — so
 * losing it on every route change would mean a blank chart for the first
 * minute after every visit, which is exactly when someone is looking.
 */
const soundHistory = new Map<string, SoundPoint[]>();

function historyKey(childId: number | undefined): string {
  return childId === undefined ? 'default' : String(childId);
}

function appendPoint(key: string, point: SoundPoint): SoundPoint[] {
  const previous = soundHistory.get(key) ?? [];
  const last = previous.at(-1);
  // The same tick can arrive twice (a poll racing an SSE push).
  if (last && last.ts >= point.ts) return previous;
  const cutoff = point.ts - SOUND_WINDOW_MS;
  const next = [...previous, point].filter((entry) => entry.ts >= cutoff).slice(-SOUND_MAX_POINTS);
  soundHistory.set(key, next);
  return next;
}

// ---------------------------------------------------------------------------
// A shared clock
// ---------------------------------------------------------------------------

/**
 * A ticking `Date.now()`, so "asleep for 1h 12m" advances without every
 * component running its own timer.
 *
 * Ten seconds by default: fast enough that a minute counter is never visibly
 * wrong, slow enough that a phone left on the bedside table is not re-rendering
 * once a second all night.
 */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    // A backgrounded tab's timers are throttled to near nothing, so the clock
    // is stale the instant the phone comes back. Resync on the way in.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  return now;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface LiveData {
  /** The most recent state, from SSE or a poll. Undefined until the first one. */
  live: LiveState | undefined;
  /** The active child, once `/api/children` has answered. */
  child: Child | undefined;
  /** Best known child id: the picked child, else whatever `/api/state` says. */
  childId: number | undefined;
  /** Tonight's `night_of`, from the server when possible. */
  nightOf: NightOf;
  timezone: string | null;
  config: EffectiveConfig | undefined;

  /** True only before the very first state has ever arrived. */
  isFirstLoad: boolean;
  /** Set when the last attempt failed. Stale data may still be present. */
  error: unknown;
  /** When the state we are showing arrived, epoch ms. Null if never. */
  receivedAt: EpochMs | null;
  refresh: () => void;

  streamStatus: StreamStatus;
  /** Subscribe to any SSE event; stable across renders. */
  subscribe: StreamSubscribe;
  reconnect: () => void;

  /** The rolling sound history, oldest first. */
  soundHistory: SoundPoint[];
}

export function useLiveState(): LiveData {
  const queryClient = useQueryClient();

  // -- Which child ---------------------------------------------------------

  const childrenQuery = useQuery({
    queryKey: ['children'],
    queryFn: ({ signal }) => childrenApi.list({}, signal),
    staleTime: 5 * 60_000,
  });

  const child = useMemo(() => {
    const items = childrenQuery.data?.items ?? [];
    return items.find((candidate) => candidate.active) ?? items[0];
  }, [childrenQuery.data]);

  // Every wall-clock formatter on this page reads the child's zone, not the
  // phone's — a parent checking in from another timezone still wants the
  // nursery's idea of what "tonight" is.
  useEffect(() => {
    setDefaultTimezone(child?.timezone ?? null);
  }, [child?.timezone]);

  // -- Config (the comfort band, mostly) -----------------------------------

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => system.config(signal),
    staleTime: 10 * 60_000,
  });

  // -- The push channel ----------------------------------------------------

  const { status: streamStatus, subscribe, reconnect } = useEventStream({
    childId: child?.id,
    types: LIVE_STREAM_TYPES,
  });

  // -- Live state ----------------------------------------------------------

  const stateKey = useMemo(() => ['state', child?.id ?? null] as const, [child?.id]);

  const stateQuery = useQuery({
    queryKey: stateKey,
    queryFn: ({ signal }) => stateApi.get(child?.id, signal),
    // The stream is the primary transport; this is the safety net.
    refetchInterval: streamStatus === 'open' ? false : 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });

  const { data: live, dataUpdatedAt } = stateQuery;

  // SSE pushes are written into the same cache entry the query owns, which
  // keeps `dataUpdatedAt` meaningful and means no component has to know which
  // transport a value came from.
  useEffect(() => {
    return subscribe('state', (payload) => {
      queryClient.setQueryData(stateKey, payload);
    });
  }, [subscribe, queryClient, stateKey]);

  // -- Sound history -------------------------------------------------------

  const key = historyKey(child?.id);
  const [history, setHistory] = useState<SoundPoint[]>(() => soundHistory.get(key) ?? []);
  const lastTickRef = useRef<EpochMs | null>(null);

  // Switching child switches history.
  useEffect(() => {
    lastTickRef.current = null;
    setHistory(soundHistory.get(key) ?? []);
  }, [key]);

  useEffect(() => {
    if (!live) return;
    if (lastTickRef.current === live.ts_ms) return;
    lastTickRef.current = live.ts_ms;
    setHistory(
      appendPoint(key, {
        ts: live.ts_ms,
        dbfs: live.sound_dbfs,
        floor: live.noise_floor_dbfs,
      }),
    );
    // `dataUpdatedAt` is in the deps so a re-delivery of an identical object
    // (setQueryData with the same reference) still runs the guard above.
  }, [live, dataUpdatedAt, key]);

  // -- Derived -------------------------------------------------------------

  const timezone = child?.timezone ?? configQuery.data?.site?.timezone ?? null;

  const nightOfValue =
    live?.night_of ??
    computeNightOf(Date.now(), { tz: timezone, boundaryHour: child?.day_boundary_hour });

  const refresh = useCallback(() => {
    reconnect();
    void queryClient.invalidateQueries({ queryKey: stateKey });
  }, [reconnect, queryClient, stateKey]);

  return {
    live,
    child,
    childId: child?.id ?? live?.child_id,
    nightOf: nightOfValue,
    timezone,
    config: configQuery.data,
    isFirstLoad: live === undefined && stateQuery.isPending,
    error: live === undefined ? (stateQuery.error ?? childrenQuery.error) : stateQuery.error,
    receivedAt: dataUpdatedAt > 0 ? dataUpdatedAt : null,
    refresh,
    streamStatus,
    subscribe,
    reconnect,
    soundHistory: history,
  };
}
