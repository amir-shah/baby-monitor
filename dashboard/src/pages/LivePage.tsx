/**
 * The Live page — the front door, and the 3am screen.
 *
 * Everything here is driven by one `/api/state` cache entry that the SSE
 * channel writes into (see `live/useLiveState`). That means the camera's
 * freshness badge, the sleep-state clock and the sound meter can never
 * disagree with each other about how old the data is, and there is exactly one
 * place that knows whether the link is up.
 *
 * The failure story matters as much as the happy one. Losing the Pi must not
 * produce a blank screen: the last known values stay on screen, greyed by
 * nothing but an honest "updated 4 minutes ago", and a banner says the link is
 * being re-established. Only a page that has *never* had data falls back to an
 * error state.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  ErrorState,
  Skeleton,
  Spinner,
  Stat,
  StatGrid,
} from '../components';
import { HumidityIcon, RefreshIcon, TemperatureIcon } from '../components/Icons';
import {
  formatCount,
  formatDuration,
  formatHumidity,
  formatTemperature,
  nightLabel,
} from '../lib/format';
import { CameraPanel } from './live/CameraPanel';
import { ComfortGauge } from './live/ComfortGauge';
import type { ComfortBand } from './live/ComfortGauge';
import { QuickActions } from './live/QuickActions';
import { RecentEvents } from './live/RecentEvents';
import { SleepStateHero } from './live/SleepStateHero';
import { SoundMeter } from './live/SoundMeter';
import { SOUND_WINDOW_MS, useLiveState, useNow } from './live/useLiveState';
import './LivePage.css';

/** A reading older than this means the monitor has gone quiet on us. */
const STALE_AFTER_MS = 60_000;

/**
 * How long the data has to have stopped arriving before the reconnecting
 * banner appears.
 *
 * Deliberately longer than a sample tick (15 s) *and* a heartbeat (20 s). A
 * dropped SSE socket on its own is not worth telling anyone about — the
 * fallback poll takes over and the numbers keep moving. The banner is for the
 * case where neither transport is getting through, which is the only one where
 * what is on screen might be lying.
 */
const QUIET_BEFORE_BANNER_MS = 25_000;

/** Fast enough that the "for 1h 12m" clock and the sparkline stay honest. */
const TICK_MS = 5_000;

/** Comfortable defaults for the gauge axes, widened if the data needs it. */
const TEMP_DOMAIN: readonly [number, number] = [14, 30];
const HUMIDITY_DOMAIN: readonly [number, number] = [20, 80];

/**
 * Keep the axis wide enough that the band and the marker are both on it. A
 * comfort band set to 24–27 °C in a warm climate must not push the marker off
 * the end of a hard-coded scale.
 */
function widen(
  base: readonly [number, number],
  values: readonly (number | null | undefined)[],
): [number, number] {
  let [low, high] = base;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < low) low = Math.floor(value - 1);
    if (value > high) high = Math.ceil(value + 1);
  }
  return [low, high];
}

export function LivePage() {
  const now = useNow(TICK_MS);
  const {
    live,
    child,
    childId,
    nightOf,
    config,
    isFirstLoad,
    error,
    receivedAt,
    refresh,
    streamStatus,
    subscribe,
    soundHistory,
  } = useLiveState(now);

  const linkDown = streamStatus !== 'open';
  const quietForMs = receivedAt === null ? null : now - receivedAt;
  const stale = quietForMs === null || quietForMs > STALE_AFTER_MS;

  // Derived rather than timed: no state to get stuck on, and it says what it
  // means — the push channel is down *and* nothing is arriving any other way.
  const showBanner =
    linkDown && !isFirstLoad && (quietForMs === null || quietForMs > QUIET_BEFORE_BANNER_MS);

  const comfort = config?.environment?.comfort;
  const tempBand: ComfortBand = {
    min: comfort?.temp_c_min ?? null,
    max: comfort?.temp_c_max ?? null,
  };
  const humidityBand: ComfortBand = {
    min: comfort?.humidity_min ?? null,
    max: comfort?.humidity_max ?? null,
  };

  const tempDomain = useMemo(
    () => widen(TEMP_DOMAIN, [tempBand.min, tempBand.max, live?.temp_c]),
    [tempBand.min, tempBand.max, live?.temp_c],
  );
  const humidityDomain = useMemo(
    () => widen(HUMIDITY_DOMAIN, [humidityBand.min, humidityBand.max, live?.humidity_pct]),
    [humidityBand.min, humidityBand.max, live?.humidity_pct],
  );

  const tonight = live?.night_so_far;
  const envEnabled = config?.environment?.enabled !== false;
  const hasEnvReading = live?.temp_c !== null || live?.humidity_pct !== null;

  // Nothing has ever loaded and the request failed: this is the only case
  // where there is genuinely nothing to show.
  if (live === undefined && error) {
    return (
      <div className="live">
        <Card>
          <ErrorState
            error={error}
            onRetry={refresh}
            retryLabel="Reconnect"
            description="The dashboard cannot reach the monitor. It will keep trying."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="live">
      {showBanner ? (
        <div className="live__banner" role="status">
          <Spinner size={16} />
          <span className="live__banner-text">
            <strong>Reconnecting to the monitor.</strong>{' '}
            {receivedAt === null
              ? 'Nothing has come through yet.'
              : 'Showing the last reading until the link is back.'}
          </span>
          <Button variant="ghost" size="sm" onClick={refresh} iconStart={<RefreshIcon size={15} />}>
            Retry
          </Button>
        </div>
      ) : null}

      <div className="live__col">
        <Card flush className="live__camera-card">
          <CameraPanel
            cameraOnline={live?.camera_online}
            streamOpen={!linkDown}
            now={now}
            childName={child?.name}
          />
        </Card>

        <Card
          title={child?.name ?? 'Right now'}
          subtitle={nightLabel(nightOf, { now })}
          actions={
            <Link className="live__link" to={`/night/${nightOf}`}>
              Full night
            </Link>
          }
        >
          {isFirstLoad ? (
            <div aria-busy="true">
              <span className="visually-hidden">Loading the current state</span>
              <Skeleton height="4.5rem" shape="block" />
            </div>
          ) : (
            <SleepStateHero
              state={live?.state}
              sinceMs={live?.state_since_ms ?? null}
              asleepForMin={live?.asleep_for_min ?? null}
              now={now}
              receivedAt={receivedAt}
              stale={stale}
            />
          )}
        </Card>

        <Card title="Sound">
          {isFirstLoad ? (
            <Skeleton height="6rem" shape="block" />
          ) : (
            <SoundMeter
              dbfs={live?.sound_dbfs ?? null}
              floor={live?.noise_floor_dbfs ?? null}
              aboveFloor={live?.sound_above_floor_db ?? null}
              cryScore={live?.cry_score ?? null}
              audioOnline={live?.audio_online}
              history={soundHistory}
              windowMs={SOUND_WINDOW_MS}
              now={now}
            />
          )}
        </Card>
      </div>

      <div className="live__col">
        <Card title="Room">
          {isFirstLoad ? (
            <Skeleton height="5rem" shape="block" />
          ) : !envEnabled ? (
            <p className="live__muted">The environment sensor is switched off in the config.</p>
          ) : !hasEnvReading ? (
            <p className="live__muted">No temperature or humidity readings are coming through.</p>
          ) : (
            <div className="comfort-grid">
              <ComfortGauge
                label="Temperature"
                value={live?.temp_c ?? null}
                display={formatTemperature(live?.temp_c ?? null)}
                band={tempBand}
                domain={tempDomain}
                icon={<TemperatureIcon size={16} />}
                lowWord="Cool"
                highWord="Warm"
                unitName="degrees Celsius"
              />
              <ComfortGauge
                label="Humidity"
                value={live?.humidity_pct ?? null}
                display={formatHumidity(live?.humidity_pct ?? null)}
                band={humidityBand}
                domain={humidityDomain}
                icon={<HumidityIcon size={16} />}
                lowWord="Dry"
                highWord="Humid"
                unitName="percent"
              />
            </div>
          )}
        </Card>

        <Card title="Tonight so far">
          <StatGrid min="6.5rem">
            <Stat
              label="Asleep"
              value={formatDuration(tonight?.tst_min ?? null)}
              size="lg"
              hint={live?.state === 'asleep' ? 'still counting' : undefined}
            />
            <Stat
              label="Awakenings"
              value={formatCount(tonight?.awakenings ?? null)}
              size="lg"
            />
            <Stat
              label="Cries"
              value={formatCount(tonight?.cry_events ?? null)}
              size="lg"
              tone={(tonight?.cry_events ?? 0) > 0 ? 'warn' : 'neutral'}
            />
          </StatGrid>
        </Card>

        <Card
          title="Recent"
          actions={
            <Link className="live__link" to="/events">
              All events
            </Link>
          }
        >
          <RecentEvents childId={childId} nightOf={nightOf} subscribe={subscribe} />
        </Card>

        <Card title="Quick actions">
          <QuickActions childId={childId} nightOf={nightOf} subscribe={subscribe} />
        </Card>
      </div>
    </div>
  );
}

export default LivePage;
