/**
 * The one place `GET /api/children` is fetched, and the one definition of
 * "which child is this dashboard about".
 *
 * Five call sites had independently written the same query and the same
 * `items.find(c => c.active) ?? items[0]` fallback. They agreed, but only by
 * coincidence — and "which child" is exactly the decision that must not be
 * allowed to differ between the header and the page under it.
 *
 * The fallback to `items[0]` matters: a single-child install may never set the
 * active flag, and a dashboard that renders nothing because a boolean is
 * missing is worse than one that picks the only child there is.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { children as childrenApi } from '../lib/api';
import type { Child, ListResponse } from '../lib/types';

export const CHILDREN_QUERY_KEY = ['children'] as const;

/** Children are added roughly never; five minutes is already generous. */
export const CHILDREN_STALE_TIME = 5 * 60_000;

export function useChildren(): UseQueryResult<ListResponse<Child>> {
  return useQuery({
    queryKey: CHILDREN_QUERY_KEY,
    queryFn: ({ signal }) => childrenApi.list({}, signal),
    staleTime: CHILDREN_STALE_TIME,
  });
}

/** The active child, falling back to the first one the install has. */
export function pickActiveChild(items: readonly Child[] | undefined): Child | undefined {
  if (!items || items.length === 0) return undefined;
  return items.find((candidate) => candidate.active) ?? items[0];
}

/** `useChildren` plus the selection, which is what every caller actually wants. */
export function useActiveChild(): {
  child: Child | undefined;
  query: UseQueryResult<ListResponse<Child>>;
} {
  const query = useChildren();
  const items = query.data?.items;
  const child = useMemo(() => pickActiveChild(items), [items]);
  return { child, query };
}
