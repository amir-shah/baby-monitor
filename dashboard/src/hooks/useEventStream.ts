/**
 * React bindings for {@link EventStream}.
 *
 * The hook owns one stream per `(childId, types)` pair and hands back a
 * *stable* `subscribe` function rather than the stream object itself. That
 * indirection is what lets the stream be torn down and rebuilt — on a child
 * switch, a reconnect, a StrictMode double-mount — without every consumer
 * having to re-run its own effect. Registrations are remembered and
 * re-attached to whatever stream is current.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EventStream } from '../lib/api';
import type { StreamStatus } from '../lib/api';
import type { StreamEventMap, StreamEventName, StreamTypeFilter } from '../lib/types';

export interface UseEventStreamOptions {
  childId?: number;
  types?: readonly StreamTypeFilter[];
  /** Set false to hold the connection closed (e.g. while signed out). */
  enabled?: boolean;
}

export type StreamSubscribe = <K extends StreamEventName>(
  name: K,
  listener: (payload: StreamEventMap[K]) => void,
) => () => void;

export interface UseEventStreamResult {
  status: StreamStatus;
  /** True when the push channel is not currently delivering. */
  stale: boolean;
  subscribe: StreamSubscribe;
  /** Force a reconnect now, resetting the backoff. */
  reconnect: () => void;
}

/**
 * A pending subscription. The generic is closed over inside `attach`, which
 * is what keeps re-attachment type-safe without an `any` in sight.
 */
interface Registration {
  attach: (stream: EventStream) => () => void;
  detach?: () => void;
}

export function useEventStream(options: UseEventStreamOptions = {}): UseEventStreamResult {
  const { childId, types, enabled = true } = options;
  // Serialise the filter so an inline array literal does not re-trigger.
  const typesKey = types ? [...types].join(',') : '';

  const [status, setStatus] = useState<StreamStatus>('closed');
  const streamRef = useRef<EventStream | null>(null);
  const registrationsRef = useRef<Set<Registration>>(new Set());

  useEffect(() => {
    if (!enabled) return;

    // The Set identity never changes, but capturing it keeps the cleanup
    // honest about which collection it is detaching from.
    const registrations = registrationsRef.current;
    const instance = new EventStream({
      childId,
      types: typesKey ? (typesKey.split(',') as StreamTypeFilter[]) : undefined,
    });
    streamRef.current = instance;

    // Anything that subscribed before the stream existed (a child component's
    // effect runs before its parent's) gets attached here.
    for (const registration of registrations) {
      registration.detach = registration.attach(instance);
    }

    const offStatus = instance.onStatus(setStatus);

    return () => {
      offStatus();
      for (const registration of registrations) {
        registration.detach?.();
        registration.detach = undefined;
      }
      instance.close();
      streamRef.current = null;
    };
  }, [childId, typesKey, enabled]);

  const subscribe = useCallback<StreamSubscribe>((name, listener) => {
    const registration: Registration = { attach: (stream) => stream.on(name, listener) };
    registrationsRef.current.add(registration);
    const stream = streamRef.current;
    if (stream) registration.detach = registration.attach(stream);
    return () => {
      registration.detach?.();
      registrationsRef.current.delete(registration);
    };
  }, []);

  const reconnect = useCallback(() => streamRef.current?.reconnect(), []);

  // Derived rather than stored, so disabling the stream cannot leave a stale
  // status behind.
  const effectiveStatus: StreamStatus = enabled ? status : 'closed';

  return useMemo(
    () => ({
      status: effectiveStatus,
      stale: effectiveStatus !== 'open',
      subscribe,
      reconnect,
    }),
    [effectiveStatus, subscribe, reconnect],
  );
}

/**
 * Subscribe to one named SSE event.
 *
 * ```tsx
 * const { subscribe } = useEventStream({ childId });
 * useStreamEvent(subscribe, 'state', setLive);
 * ```
 *
 * The handler is held in a ref, so an inline arrow function does not cause a
 * resubscribe on every render.
 */
export function useStreamEvent<K extends StreamEventName>(
  subscribe: StreamSubscribe,
  name: K,
  handler: (payload: StreamEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    return subscribe(name, (payload) => handlerRef.current(payload));
  }, [subscribe, name]);
}
