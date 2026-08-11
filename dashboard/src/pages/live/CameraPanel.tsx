/**
 * The camera.
 *
 * Three display modes, degrading in order:
 *
 *   mjpeg     `<img src="/api/stream/mjpeg">`, the cheap option — the browser
 *             holds one connection and the Pi pushes frames into it.
 *   snapshot  a `/api/snapshot.jpg` re-fetched on a timer. Used when the MJPEG
 *             stream errors, which on a Pi usually means the encoder is busy
 *             serving HKSV or the connection was reaped by a proxy.
 *   offline   nothing is coming. Says so in words, and offers a retry.
 *
 * No `?t=` media token is minted: the deployment is same-origin, so the
 * HttpOnly session cookie rides along on a subresource request the same as it
 * would on a fetch. (The token exists for the cross-origin dev case; adding a
 * hard dependency on an endpoint that is not in docs/API.md would mean the
 * camera goes dark the moment the contract disagrees with us.)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, CollapseIcon, ExpandIcon } from '../../components';
import { CameraIcon, OfflineIcon, RefreshIcon } from '../../components/Icons';
import { IconButton } from '../../components/IconButton';
import { media } from '../../lib/api';
import { formatDurationSeconds } from '../../lib/format';
import './CameraPanel.css';

type Mode = 'mjpeg' | 'snapshot' | 'offline';

/** Snapshot refresh cadence while the tab is in front of someone. */
const SNAPSHOT_INTERVAL_MS = 2_000;
/** …and while it is not. A backgrounded phone should not poll a Pi at 0.5 Hz. */
const SNAPSHOT_BACKGROUND_MS = 30_000;
/** Consecutive snapshot failures before we call it offline. */
const SNAPSHOT_FAILURE_LIMIT = 3;
/** How often an offline camera quietly tries again. */
const OFFLINE_RETRY_MS = 30_000;
/** A frame older than this is stale even if nothing has errored. */
const STALE_AFTER_MS = 20_000;

export interface CameraPanelProps {
  /** `live.camera_online`. Undefined before the first state arrives. */
  cameraOnline: boolean | undefined;
  /** True while the SSE channel is delivering. */
  streamOpen: boolean;
  /** Ticking clock from `useNow`, so the age readout advances. */
  now: number;
  /** For the accessible name: "Ada's cot". */
  childName?: string | undefined;
}

export function CameraPanel({ cameraOnline, streamOpen, now, childName }: CameraPanelProps) {
  const [mode, setMode] = useState<Mode>('mjpeg');
  /** Bumped to force a brand new `<img>`, discarding a wedged connection. */
  const [attempt, setAttempt] = useState(0);
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const failures = useRef(0);
  const frameRef = useRef<HTMLDivElement>(null);

  // The service says the camera is down: believe it, and stop asking. An
  // `<img>` pointed at a dead endpoint retries on its own schedule and there
  // is no way to tell it not to.
  const serviceDown = cameraOnline === false;
  const showOffline = mode === 'offline' || serviceDown;

  const retry = useCallback(() => {
    failures.current = 0;
    setLastFrameAt(null);
    setMode('mjpeg');
    setAttempt((value) => value + 1);
  }, []);

  // Come back automatically when the service says the camera is up again.
  const wasDown = useRef(serviceDown);
  useEffect(() => {
    if (wasDown.current && !serviceDown) retry();
    wasDown.current = serviceDown;
  }, [serviceDown, retry]);

  // …and try periodically even if nothing tells us anything, because a
  // "camera offline" card that never clears is worse than a failed request.
  useEffect(() => {
    if (mode !== 'offline' || serviceDown) return;
    const timer = setInterval(retry, OFFLINE_RETRY_MS);
    return () => clearInterval(timer);
  }, [mode, serviceDown, retry]);

  // Snapshot refresh loop.
  useEffect(() => {
    if (mode !== 'snapshot' || serviceDown) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const arm = () => {
      if (timer) clearInterval(timer);
      const period =
        document.visibilityState === 'visible' ? SNAPSHOT_INTERVAL_MS : SNAPSHOT_BACKGROUND_MS;
      timer = setInterval(() => setSnapshotTick((value) => value + 1), period);
    };

    const onVisibility = () => {
      arm();
      if (document.visibilityState === 'visible') setSnapshotTick((value) => value + 1);
    };

    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode, serviceDown]);

  // -- Fullscreen ----------------------------------------------------------

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === frameRef.current;
      setIsFullscreen(active);
      // Native fullscreen and the CSS fallback must never both be on.
      if (active) setExpanded(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Escape leaves the CSS fallback; the native API handles its own.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const enlarged = isFullscreen || expanded;

  const toggleFullscreen = useCallback(() => {
    const element = frameRef.current;
    if (!element) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => setIsFullscreen(false));
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    // iOS Safari has no element fullscreen at all, and a denied request
    // rejects rather than throwing synchronously — hence the catch.
    if (typeof element.requestFullscreen === 'function') {
      element.requestFullscreen({ navigationUI: 'hide' }).catch(() => setExpanded(true));
      return;
    }
    setExpanded(true);
  }, [expanded]);

  // -- Freshness -----------------------------------------------------------

  const ageMs = lastFrameAt === null ? null : Math.max(0, now - lastFrameAt);
  const freshness = describeFreshness({ mode, showOffline, streamOpen, ageMs });

  const label = childName ? `${childName}'s camera` : 'Nursery camera';

  return (
    <div
      className={['camera', enlarged ? 'is-enlarged' : ''].filter(Boolean).join(' ')}
      ref={frameRef}
    >
      {showOffline ? (
        <div className="camera__offline">
          <span className="camera__offline-icon" aria-hidden="true">
            {serviceDown ? <OfflineIcon size={32} /> : <CameraIcon size={32} />}
          </span>
          <p className="camera__offline-title">Camera offline</p>
          <p className="camera__offline-body">
            {serviceDown
              ? 'The monitor reports the camera is not running.'
              : 'No frames are getting through from the monitor.'}
          </p>
          <Button
            variant="secondary"
            onClick={retry}
            iconStart={<RefreshIcon size={16} />}
            disabled={serviceDown}
          >
            Try again
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="camera__hit"
          onClick={toggleFullscreen}
          aria-pressed={enlarged}
          aria-label={enlarged ? `Exit full screen for ${label}` : `${label}, tap for full screen`}
        >
          {mode === 'mjpeg' ? (
            <img
              key={`mjpeg-${attempt}`}
              className="camera__image"
              src={media.mjpegUrl({ fps: 10, width: 960 })}
              alt=""
              decoding="async"
              onLoad={() => setLastFrameAt(Date.now())}
              onError={() => {
                failures.current = 0;
                setMode('snapshot');
                setSnapshotTick((value) => value + 1);
              }}
            />
          ) : (
            <img
              key={`snap-${attempt}-${snapshotTick}`}
              className="camera__image"
              src={media.snapshotUrl({ width: 960, max_age_s: 2, cacheKey: snapshotTick })}
              alt=""
              decoding="async"
              onLoad={() => {
                failures.current = 0;
                setLastFrameAt(Date.now());
              }}
              onError={() => {
                failures.current += 1;
                if (failures.current >= SNAPSHOT_FAILURE_LIMIT) setMode('offline');
              }}
            />
          )}
        </button>
      )}

      <div className="camera__overlay">
        <p className={`camera__freshness camera__freshness--${freshness.tone}`}>
          <span
            className={`camera__pip camera__pip--${freshness.tone}`}
            aria-hidden="true"
            data-live={freshness.tone === 'live' ? '' : undefined}
          />
          {freshness.text}
          {ageMs !== null && freshness.showAge ? (
            <span className="camera__age" data-numeric>
              {formatDurationSeconds(ageMs / 1000, { style: 'hm' })} ago
            </span>
          ) : null}
        </p>

        {enlarged ? (
          <IconButton
            className="camera__exit"
            label="Exit full screen"
            icon={<CollapseIcon size={20} />}
            variant="solid"
            onClick={toggleFullscreen}
          />
        ) : showOffline ? null : (
          <span className="camera__expand-hint" aria-hidden="true">
            <ExpandIcon size={18} />
          </span>
        )}
      </div>
    </div>
  );
}

interface Freshness {
  text: string;
  tone: 'live' | 'ok' | 'warn' | 'off';
  showAge: boolean;
}

/**
 * MJPEG gives no per-frame signal — browsers fire `load` once, at the end of
 * a multipart response that never ends — so a live stream cannot be aged
 * directly. What it *can* be checked against is the SSE channel: if state
 * ticks are arriving and the camera reports itself up, frames are flowing.
 * Snapshot mode, by contrast, has a real timestamp per frame.
 */
function describeFreshness(args: {
  mode: Mode;
  showOffline: boolean;
  streamOpen: boolean;
  ageMs: number | null;
}): Freshness {
  const { mode, showOffline, streamOpen, ageMs } = args;

  if (showOffline) return { text: 'Offline', tone: 'off', showAge: false };

  if (mode === 'snapshot') {
    if (ageMs === null) return { text: 'Stills — waiting', tone: 'warn', showAge: false };
    if (ageMs > STALE_AFTER_MS) return { text: 'Stills — stale,', tone: 'warn', showAge: true };
    return { text: 'Stills', tone: 'ok', showAge: true };
  }

  if (!streamOpen) return { text: 'Live — link unconfirmed', tone: 'warn', showAge: false };
  return { text: 'Live', tone: 'live', showAge: false };
}
