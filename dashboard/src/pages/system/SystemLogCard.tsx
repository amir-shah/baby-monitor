/**
 * Recent lines from `system_log`.
 *
 * Filtered by level rather than searched: this is the "what just went wrong"
 * view, and the useful question at 3am is "show me the errors", not "find the
 * string". Newest first, because the last thing that happened is the thing
 * being investigated.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  RefreshIcon,
  Skeleton,
} from '../../components';
import { system } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import type { LogLevel, SystemLogRow, Timezone } from '../../lib/types';
import { asRecord } from './normalize';
import './SystemLogCard.css';

const LEVELS: readonly { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
];

/** A glyph as well as a colour, so severity survives a greyscale screen. */
const LEVEL_GLYPH: Record<string, string> = {
  debug: '·',
  info: '•',
  warning: '◆',
  error: '▲',
};

export function SystemLogCard({ timezone }: { timezone?: Timezone | null }) {
  const [level, setLevel] = useState<LogLevel | 'all'>('all');

  const logQuery = useQuery({
    queryKey: ['system', 'log', level],
    queryFn: ({ signal }) =>
      system.log({ limit: 100, ...(level === 'all' ? {} : { level }) }, signal),
    staleTime: 10_000,
  });

  const rows = readRows(logQuery.data);

  return (
    <Card
      title="Recent log"
      subtitle="What the service has been saying to itself."
      actions={
        <IconButton
          label="Reload the log"
          icon={<RefreshIcon size={18} />}
          onClick={() => void logQuery.refetch()}
        />
      }
    >
      <div className="syslog">
        <div className="chip-row" role="group" aria-label="Filter by level">
          {LEVELS.map((entry) => (
            <Chip key={entry.value} selected={level === entry.value} onClick={() => setLevel(entry.value)}>
              {entry.label}
            </Chip>
          ))}
        </div>

        {logQuery.isPending ? (
          <div className="syslog__loading" aria-busy="true">
            <span className="visually-hidden">Loading the log</span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height="2.5rem" shape="block" />
            ))}
          </div>
        ) : logQuery.error ? (
          <ErrorState error={logQuery.error} size="sm" onRetry={() => void logQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            size="sm"
            title={level === 'all' ? 'Nothing logged yet' : `No ${level} lines`}
            description="Quiet is the good outcome here."
          />
        ) : (
          <ol className="syslog__list">
            {rows.map((row) => (
              <li key={row.id} className={`syslog__row syslog__row--${row.level}`}>
                <span className="syslog__glyph" aria-hidden="true">
                  {LEVEL_GLYPH[row.level] ?? '•'}
                </span>
                <span className="syslog__level">{row.level}</span>
                <time className="syslog__time" dateTime={new Date(row.ts_ms).toISOString()} title={formatDateTime(row.ts_ms, { tz: timezone, seconds: true })}>
                  {formatRelative(row.ts_ms)}
                </time>
                <span className="syslog__component">{row.component}</span>
                <span className="syslog__message">{row.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

/**
 * The rows come straight from `SELECT * FROM system_log`, so treat every
 * column as optional rather than trusting the row shape.
 */
function readRows(payload: { items?: unknown } | undefined): SystemLogRow[] {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .map((row, index) => ({
      id: typeof row.id === 'number' ? row.id : index,
      ts_ms: typeof row.ts_ms === 'number' ? row.ts_ms : 0,
      level: (typeof row.level === 'string' ? row.level : 'info') as LogLevel,
      component: typeof row.component === 'string' ? row.component : 'babymon',
      message: typeof row.message === 'string' ? row.message : '',
      meta: asRecord(row.meta) ?? null,
    }));
}
