/**
 * The one place `GET /api/config` is fetched.
 *
 * Four pages need the effective config — Live for the comfort band, Notes and
 * System for the timezone, Analytics for the gates the analysis ran under —
 * and each had grown its own `useQuery({ queryKey: ['config'] })`. Sharing the
 * key meant they shared a cache entry by luck rather than by design, and the
 * options were free to drift apart. This hook is the single definition.
 *
 * The config changes when someone edits a YAML file and restarts the service,
 * so a long `staleTime` is right: refetching it on every page change is pure
 * noise on a Pi.
 */

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { system } from '../lib/api';
import type { ConfigResponse, EffectiveConfig, Timezone } from '../lib/types';

export const CONFIG_QUERY_KEY = ['config'] as const;

/** Ten minutes: config only changes on a service restart. */
export const CONFIG_STALE_TIME = 10 * 60_000;

export function useConfig(): UseQueryResult<ConfigResponse> {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => system.config(signal),
    staleTime: CONFIG_STALE_TIME,
  });
}

/**
 * The nursery's timezone, preferring the child's own setting over the site
 * default. Every page that prints a clock time resolves it this way, so the
 * precedence lives here rather than being retyped five times.
 */
export function resolveTimezone(
  child: { timezone?: Timezone | null } | undefined,
  config: EffectiveConfig | undefined,
): Timezone | null {
  return child?.timezone ?? config?.site?.timezone ?? null;
}
