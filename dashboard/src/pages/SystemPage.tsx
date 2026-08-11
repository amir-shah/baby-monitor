/**
 * System: is the monitor healthy, what is it running on, and how do I pair it.
 *
 * This is the page you open *because* something looks wrong, which sets two
 * rules. First, it must degrade one card at a time: `/api/health` is the only
 * unauthenticated endpoint, so it can answer while everything else 401s or
 * times out, and a failure in the log or the HomeKit bridge must not take the
 * status card down with it. Every section therefore owns its own query and its
 * own error state. Second, it must never *hide* trouble behind a spinner — a
 * component that is down says so in words, not only in colour.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  IconButton,
  LogoutIcon,
  RefreshIcon,
  Skeleton,
  Stat,
  StatGrid,
  describeError,
  useToast,
} from '../components';
import { ApiError, auth, children as childrenApi, system } from '../lib/api';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatTemperature,
  formatUptime,
  setDefaultTimezone,
  titleCase,
} from '../lib/format';
import { ConfigCard } from './system/ConfigCard';
import { HomeKitCard } from './system/HomeKitCard';
import { SystemLogCard } from './system/SystemLogCard';
import {
  componentLabel,
  normalizeConfig,
  normalizeHealth,
  normalizeSystemInfo,
} from './system/normalize';
import type { ComponentStatus, DatabaseView, DiskView, SystemInfoView } from './system/normalize';
import './SystemPage.css';

/** A Pi throttles at 80 °C; 70 is where it is worth mentioning. */
const TEMP_WARN_C = 70;
const TEMP_HOT_C = 78;

/** Free space below this fraction is worth a warning, not just a number. */
const DISK_WARN_FRACTION = 0.9;

export function SystemPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => system.health(signal),
    // The one endpoint that always answers; poll it so a page left open on the
    // kitchen counter stays honest.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const infoQuery = useQuery({
    queryKey: ['system', 'info'],
    queryFn: ({ signal }) => system.info(signal),
    staleTime: 30_000,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => system.config(signal),
    staleTime: 10 * 60_000,
  });

  const childrenQuery = useQuery({
    queryKey: ['children'],
    queryFn: ({ signal }) => childrenApi.list({}, signal),
    staleTime: 5 * 60_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => auth.session(signal),
    staleTime: 60_000,
    // `/api/auth/session` is implied by the contract rather than documented, so
    // a 404 is a plausible answer. One attempt, then fall back to what the
    // effective config says about whether auth is on at all.
    retry: false,
  });

  const health = useMemo(() => normalizeHealth(healthQuery.data), [healthQuery.data]);
  const info = useMemo(() => normalizeSystemInfo(infoQuery.data), [infoQuery.data]);
  const config = useMemo(() => normalizeConfig(configQuery.data), [configQuery.data]);

  const child = useMemo(() => {
    const items = childrenQuery.data?.items ?? [];
    return items.find((candidate) => candidate.active) ?? items[0];
  }, [childrenQuery.data]);

  const timezone = child?.timezone ?? configQuery.data?.site?.timezone ?? null;

  useEffect(() => {
    setDefaultTimezone(timezone);
  }, [timezone]);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await auth.logout();
      queryClient.clear();
      navigate('/login', { replace: true });
    } catch (error) {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="system-page">
      <StatusCard
        health={health}
        pending={healthQuery.isPending}
        error={healthQuery.error}
        updatedAt={healthQuery.dataUpdatedAt}
        onRefresh={() => void healthQuery.refetch()}
        timezone={timezone}
      />

      <SessionCard
        session={sessionQuery.data}
        error={sessionQuery.error}
        authConfigured={configEnabled(configQuery.data)}
        busy={signingOut}
        onSignOut={() => void signOut()}
        onSignIn={() => navigate('/login')}
      />

      <HostCard info={info} pending={infoQuery.isPending} error={infoQuery.error} onRetry={() => void infoQuery.refetch()} />

      <StorageCard info={info} pending={infoQuery.isPending} />

      <HomeKitCard />

      {configQuery.isPending ? (
        <Card title="Configuration">
          <Skeleton height="8rem" shape="block" />
        </Card>
      ) : configQuery.error ? (
        <Card title="Configuration">
          <ErrorState error={configQuery.error} size="sm" onRetry={() => void configQuery.refetch()} />
        </Card>
      ) : (
        <ConfigCard config={config} source={info.configSource} />
      )}

      <SystemLogCard timezone={timezone} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function StatusCard({
  health,
  pending,
  error,
  updatedAt,
  onRefresh,
  timezone,
}: {
  health: ReturnType<typeof normalizeHealth>;
  pending: boolean;
  error: unknown;
  updatedAt: number;
  onRefresh: () => void;
  timezone: string | null;
}) {
  const anyDown = health.components.some((component) => component.ok === false);
  const tone = health.status === 'ok' && !anyDown ? 'success' : health.status === 'unknown' ? 'neutral' : 'warning';

  return (
    <Card
      title="Status"
      subtitle={
        updatedAt > 0
          ? `Checked ${formatDateTime(updatedAt, { tz: timezone, seconds: true })}`
          : 'Checking…'
      }
      actions={
        <div className="system-page__actions">
          <Badge tone={tone} dot>
            {health.status === 'ok' && !anyDown
              ? 'All good'
              : health.status === 'unknown'
                ? 'Unknown'
                : 'Degraded'}
          </Badge>
          <IconButton label="Check again" icon={<RefreshIcon size={18} />} onClick={onRefresh} />
        </div>
      }
    >
      {error ? (
        <ErrorState
          error={error}
          title="Could not reach the monitor"
          description="Health is the one thing that answers without a session, so this usually means the service is stopped or the Pi is off."
          onRetry={onRefresh}
          size="sm"
        />
      ) : pending ? (
        <div aria-busy="true" className="system-page__loading">
          <span className="visually-hidden">Checking the monitor</span>
          <Skeleton height="4rem" shape="block" />
        </div>
      ) : (
        <>
          <StatGrid min="7rem">
            <Stat label="Version" value={health.version ?? '—'} size="sm" />
            <Stat label="Service uptime" value={formatUptime(health.uptimeS)} size="sm" />
            <Stat
              label="Subsystems"
              value={`${health.components.filter((c) => c.ok !== false).length}/${health.components.length}`}
              hint="reporting"
              size="sm"
            />
          </StatGrid>

          <ul className="components">
            {health.components.map((component) => (
              <ComponentRow key={component.name} component={component} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** State is a word and a glyph as well as a tint — never the tint alone. */
function ComponentRow({ component }: { component: ComponentStatus }) {
  const state =
    component.ok === true
      ? { word: 'Working', glyph: '✓', className: 'is-ok' }
      : component.ok === false
        ? { word: 'Not working', glyph: '▲', className: 'is-down' }
        : { word: component.state ? titleCase(component.state) : 'No answer', glyph: '–', className: 'is-unknown' };

  return (
    <li className={`components__row ${state.className}`}>
      <span className="components__glyph" aria-hidden="true">
        {state.glyph}
      </span>
      <span className="components__name">{componentLabel(component.name)}</span>
      <span className="components__state">{state.word}</span>
      {component.detail ? <span className="components__detail">{component.detail}</span> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function SessionCard({
  session,
  error,
  authConfigured,
  busy,
  onSignOut,
  onSignIn,
}: {
  session: { authenticated: boolean; auth_enabled: boolean; expires_ms?: number | null } | undefined;
  error: unknown;
  authConfigured: boolean | null;
  busy: boolean;
  onSignOut: () => void;
  onSignIn: () => void;
}) {
  // Three ways to be here: the probe answered, the probe is not implemented
  // (404 — the endpoint is inferred, not documented), or the session expired
  // under us (401, which the router will already be acting on).
  const notImplemented = error instanceof ApiError && error.isNotFound;
  const unauthorized = error instanceof ApiError && error.isUnauthorized;

  const authEnabled = session?.auth_enabled ?? authConfigured ?? true;
  const signedIn = session?.authenticated ?? (unauthorized ? false : !authEnabled ? true : null);

  return (
    <Card title="This device">
      <div className="session">
        <div className="session__text">
          <p className="session__state">
            {!authEnabled
              ? 'This monitor is open on the local network — no password is set.'
              : signedIn === true
                ? 'Signed in on this device.'
                : signedIn === false
                  ? 'Not signed in.'
                  : 'Signed in, as far as this page can tell.'}
          </p>
          {notImplemented ? (
            <p className="session__hint">
              The service did not answer a session check, so this is inferred from whether the rest of
              the page loaded.
            </p>
          ) : session?.expires_ms ? (
            <p className="session__hint">Session expires {formatDateTime(session.expires_ms)}.</p>
          ) : null}
        </div>

        {authEnabled && signedIn !== false ? (
          <Button variant="secondary" iconStart={<LogoutIcon size={17} />} onClick={onSignOut} loading={busy}>
            Sign out
          </Button>
        ) : authEnabled ? (
          <Button variant="primary" onClick={onSignIn}>
            Sign in
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function configEnabled(config: unknown): boolean | null {
  if (typeof config !== 'object' || config === null) return null;
  const root = config as Record<string, unknown>;
  const inner = (root.config as Record<string, unknown> | undefined) ?? root;
  const api = inner.api as Record<string, unknown> | undefined;
  const authSection = api?.auth as Record<string, unknown> | undefined;
  return typeof authSection?.enabled === 'boolean' ? authSection.enabled : null;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

function HostCard({
  info,
  pending,
  error,
  onRetry,
}: {
  info: SystemInfoView;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <Card title="The Pi">
        <ErrorState error={error} size="sm" onRetry={onRetry} />
      </Card>
    );
  }
  if (pending) {
    return (
      <Card title="The Pi">
        <div aria-busy="true">
          <span className="visually-hidden">Loading host information</span>
          <Skeleton height="6rem" shape="block" />
        </div>
      </Card>
    );
  }

  const hottest = info.temperatures.reduce<number | null>(
    (max, entry) => (max === null || entry.celsius > max ? entry.celsius : max),
    null,
  );
  const tempTone = hottest === null ? 'neutral' : hottest >= TEMP_HOT_C ? 'bad' : hottest >= TEMP_WARN_C ? 'warn' : 'good';

  return (
    <Card
      title="The Pi"
      subtitle={[info.model, info.hostname].filter(Boolean).join(' · ') || 'Host'}
    >
      <StatGrid min="7.5rem">
        <Stat
          label="Temperature"
          value={formatTemperature(hottest)}
          tone={tempTone}
          size="sm"
          hint={
            hottest === null
              ? 'no sensor'
              : hottest >= TEMP_HOT_C
                ? 'throttling soon'
                : hottest >= TEMP_WARN_C
                  ? 'warm'
                  : 'comfortable'
          }
        />
        <Stat label="Host uptime" value={formatUptime(info.uptimeS)} size="sm" />
        <Stat
          label="Load"
          value={info.loadAvg ? formatNumber(info.loadAvg[0], { digits: 2 }) : '—'}
          size="sm"
          hint={
            info.loadAvg && info.cpuCount
              ? `${info.cpuCount} ${info.cpuCount === 1 ? 'core' : 'cores'}`
              : undefined
          }
        />
        {info.memory ? (
          <Stat
            label="Memory free"
            value={formatBytes(info.memory.availableBytes)}
            size="sm"
            hint={`of ${formatBytes(info.memory.totalBytes)}`}
          />
        ) : null}
      </StatGrid>

      {info.temperatures.length > 1 ? (
        <ul className="host__temps">
          {info.temperatures.map((entry) => (
            <li key={entry.name}>
              <span className="host__temp-name">{entry.name}</span>
              <span data-numeric>{formatTemperature(entry.celsius)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="host__facts">
        {info.system || info.release ? (
          <>
            <dt>Operating system</dt>
            <dd>{[info.system, info.release].filter(Boolean).join(' ')}</dd>
          </>
        ) : null}
        {info.machine ? (
          <>
            <dt>Architecture</dt>
            <dd>{info.machine}</dd>
          </>
        ) : null}
        {info.versions.map((version) => (
          <div className="host__version" key={version.name}>
            <dt>{titleCase(version.name)}</dt>
            <dd>{version.value}</dd>
          </div>
        ))}
      </dl>

      {info.warnings.length > 0 ? (
        <ul className="host__warnings">
          {info.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function StorageCard({ info, pending }: { info: SystemInfoView; pending: boolean }) {
  if (pending) {
    return (
      <Card title="Storage">
        <div aria-busy="true">
          <span className="visually-hidden">Loading storage information</span>
          <Skeleton height="6rem" shape="block" />
        </div>
      </Card>
    );
  }

  const database = info.database;
  if (info.disks.length === 0 && !database) {
    return (
      <Card title="Storage">
        <p className="system-page__muted">The service did not report any storage figures.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Storage"
      subtitle="The database is written to every sample tick, so free space matters more here than on a normal machine."
    >
      {info.disks.map((disk) => (
        <DiskBar key={disk.path} disk={disk} />
      ))}

      {database ? <DatabaseFacts database={database} media={info.media} /> : null}
    </Card>
  );
}

function DiskBar({ disk }: { disk: DiskView }) {
  if (!disk.available) {
    return (
      <p className="system-page__muted">
        <code>{disk.path}</code> could not be read.
      </p>
    );
  }
  const fraction = disk.usedFraction ?? 0;
  const tight = fraction >= DISK_WARN_FRACTION;

  return (
    <div className="disk">
      <div className="disk__head">
        <code className="disk__path">{disk.path}</code>
        <span className="disk__figures" data-numeric>
          {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
        </span>
        {tight ? (
          <Badge tone="warning" size="sm">
            Nearly full
          </Badge>
        ) : null}
      </div>
      <div
        className="disk__meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-label={`${disk.path} is ${formatPercent(fraction)} full`}
      >
        <span
          className={tight ? 'disk__fill is-tight' : 'disk__fill'}
          style={{ inlineSize: `${Math.min(100, fraction * 100)}%` }}
        />
      </div>
      <p className="disk__used">{formatPercent(fraction)} used</p>
    </div>
  );
}

function DatabaseFacts({
  database,
  media,
}: {
  database: DatabaseView;
  media: SystemInfoView['media'];
}) {
  const topRows = database.rows.slice(0, 6);

  return (
    <div className="db">
      <StatGrid min="7rem">
        <Stat label="Database" value={formatBytes(database.sizeBytes)} size="sm" />
        <Stat
          label="Write-ahead log"
          value={formatBytes(database.walBytes)}
          size="sm"
          hint="checkpointed automatically"
        />
        <Stat
          label="Reclaimable"
          value={formatBytes(database.freeBytes)}
          size="sm"
          hint="freed by a vacuum"
        />
        {media ? <Stat label="Media on disk" value={formatBytes(media.trackedBytes)} size="sm" /> : null}
        {database.schemaVersion !== null ? (
          <Stat label="Schema" value={`v${database.schemaVersion}`} size="sm" />
        ) : null}
      </StatGrid>

      {topRows.length > 0 ? (
        <div className="db__rows">
          <h3 className="db__title">Rows</h3>
          <ul>
            {topRows.map((row) => (
              <li key={row.table}>
                <span className="db__table">{row.table}</span>
                <span className="db__count" data-numeric>
                  {formatCount(row.count)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {database.path ? <p className="system-page__muted db__path">{database.path}</p> : null}
    </div>
  );
}

export default SystemPage;
