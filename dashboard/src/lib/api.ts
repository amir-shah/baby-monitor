/**
 * Typed client for the babymon HTTP API (docs/API.md).
 *
 * Everything is same-origin in the real deployment: the Python service serves
 * this bundle out of `paths.static_dir` and the API lives under `/api` on the
 * same port. In dev, Vite proxies `/api` to `http://127.0.0.1:8080`. So the
 * default base URL is the empty string and `credentials: 'include'` is set on
 * every request so the HttpOnly `babymon_session` cookie rides along (it also
 * matters when `VITE_API_BASE` points somewhere else).
 *
 * Endpoints marked "not in docs/API.md" are the small number the contract
 * implies but does not spell out (session teardown, session probe, minting the
 * signed media token). They are collected here rather than scattered through
 * the UI so there is one place to fix when the contract catches up.
 */

import type {
  AnalyticsSummary,
  BabyEvent,
  Child,
  ChildCreate,
  ChildPatch,
  ConfigResponse,
  EffectiveConfig,
  EpochMs,
  ErrorEnvelope,
  EventCreate,
  EventKind,
  EventPatch,
  FactorsResponse,
  Health,
  HomeKitPairing,
  HomeKitState,
  ListResponse,
  LiveState,
  Media,
  MediaKind,
  MediaToken,
  Night,
  NightDetail,
  NightMetric,
  NightOf,
  NightPatch,
  NightSeries,
  Note,
  NoteCreate,
  NotePatch,
  PatternsResponse,
  RecomputeRequest,
  RecomputeResult,
  RegularityResponse,
  Session,
  Severity,
  StreamEventMap,
  StreamEventName,
  StreamTypeFilter,
  SystemInfo,
  SystemLogRow,
  Tag,
  TagCreate,
  TagPatch,
  TagWithStats,
  TrendsResponse,
} from './types';
import { STREAM_EVENT_NAMES } from './types';

// ---------------------------------------------------------------------------
// Base URL and error handling
// ---------------------------------------------------------------------------

/** Trailing slash stripped so `${API_BASE}/api/x` is always well formed. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/**
 * A non-2xx response, carrying the decoded `{"error": {...}}` envelope.
 *
 * `code` falls back to a synthetic `http_<status>` when the body was not a
 * well-formed envelope (a proxy 502, say), so callers can always switch on it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | null;
  readonly url: string;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    detail?: Record<string, unknown> | null;
    url: string;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.detail = args.detail ?? null;
    this.url = args.url;
  }

  /** The session cookie is missing or expired: send the user to /login. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Worth retrying: transient server or gateway trouble. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Thrown when fetch itself fails — the Pi is off, Wi-Fi dropped, etc. */
export class NetworkError extends Error {
  readonly url: string;
  override readonly cause: unknown;

  constructor(url: string, cause: unknown) {
    super('Could not reach the monitor.');
    this.name = 'NetworkError';
    this.url = url;
    this.cause = cause;
  }
}

type UnauthorizedHandler = (error: ApiError) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Register a single global 401 handler (the router uses it to bounce to
 * /login). Returns a disposer.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = (value as { error?: unknown }).error;
  return typeof envelope === 'object' && envelope !== null && 'message' in envelope;
}

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type QueryParams = Record<string, QueryValue>;

/**
 * Serialise query parameters the way the API expects: `undefined` and `null`
 * are dropped entirely, booleans become `1`/`0`, and arrays are joined with
 * commas (`?types=state,motion,sound`).
 */
export function toQueryString(params: QueryParams | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      search.set(key, value ? '1' : '0');
    } else {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** Absolute (or root-relative) URL for an API path. */
export function apiUrl(path: string, params?: QueryParams): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${suffix}${toQueryString(params)}`;
}

// ---------------------------------------------------------------------------
// The request core
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  query?: QueryParams;
  /** JSON-encoded when present. Use `undefined` for no body. */
  body?: unknown;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`; every mutating endpoint accepts one. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal, idempotencyKey, headers } = options;
  const url = apiUrl(path, query);

  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (cause) {
    // An aborted request is a caller decision, not a network fault.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError(url, cause);
  }

  if (!response.ok) {
    const payload = await readBodySafely(response);
    const error = isErrorEnvelope(payload)
      ? new ApiError({
          status: response.status,
          code: payload.error.code || `http_${response.status}`,
          message: payload.error.message || response.statusText,
          detail: payload.error.detail ?? null,
          url,
        })
      : new ApiError({
          status: response.status,
          code: `http_${response.status}`,
          message:
            typeof payload === 'string' && payload.trim()
              ? payload.slice(0, 500)
              : response.statusText || `Request failed (${response.status})`,
          url,
        });
    if (error.isUnauthorized) unauthorizedHandler?.(error);
    throw error;
  }

  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as T;
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('json')) {
    return (await response.text()) as unknown as T;
  }

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function readBodySafely(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared query-parameter shapes
// ---------------------------------------------------------------------------

export interface Paging {
  limit?: number;
  offset?: number;
}

export interface EventsQuery extends Paging {
  child_id?: number;
  night_of?: NightOf;
  /** Inclusive night-key range. Resolved server-side in the child's timezone. */
  night_from?: NightOf;
  night_to?: NightOf;
  from_ms?: EpochMs;
  to_ms?: EpochMs;
  kind?: EventKind | readonly EventKind[];
  label?: string | readonly string[];
  min_confidence?: number;
  acknowledged?: boolean;
  order?: 'asc' | 'desc';
}

export interface NotesQuery extends Paging {
  child_id?: number;
  night_of?: NightOf;
  /** Inclusive `night_of` bounds. */
  from?: NightOf;
  to?: NightOf;
  tag?: string | readonly string[];
  /** Full-text search over the note body. */
  q?: string;
}

export interface NightsQuery {
  child_id?: number;
  from?: NightOf;
  to?: NightOf;
  limit?: number;
  include_excluded?: boolean;
}

export interface MediaQuery extends Paging {
  night_of?: NightOf;
  kind?: MediaKind;
  event_id?: number;
  child_id?: number;
}

export interface AnalyticsWindow {
  child_id?: number;
  days?: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const auth = {
  /** `POST /api/auth/login` — sets the HttpOnly `babymon_session` cookie. */
  login(password: string, signal?: AbortSignal): Promise<Session> {
    return request<Session>('/api/auth/login', {
      method: 'POST',
      body: { password },
      signal,
    });
  },

  /** Not in docs/API.md: clears the session cookie. */
  logout(signal?: AbortSignal): Promise<void> {
    return request<void>('/api/auth/logout', { method: 'POST', signal });
  },

  /** Not in docs/API.md: is the current cookie still good, and is auth even on? */
  session(signal?: AbortSignal): Promise<Session> {
    return request<Session>('/api/auth/session', { signal });
  },

  /**
   * Not in docs/API.md: mints the short-lived `?t=` token that the snapshot
   * and MJPEG endpoints accept, for `<img>` tags that cannot set headers.
   * TTL is `api.auth.media_token_ttl_s` (default 3600 s).
   */
  mediaToken(signal?: AbortSignal): Promise<MediaToken> {
    return request<MediaToken>('/api/auth/media-token', { method: 'POST', signal });
  },
} as const;

export const system = {
  /** `GET /api/health` — never authenticated. */
  health(signal?: AbortSignal): Promise<Health> {
    return request<Health>('/api/health', { signal });
  },

  /** `GET /api/system/info` */
  info(signal?: AbortSignal): Promise<SystemInfo> {
    return request<SystemInfo>('/api/system/info', { signal });
  },

  /** `GET /api/system/log` */
  log(
    params: Paging & { level?: string; component?: string; since_ms?: EpochMs } = {},
    signal?: AbortSignal,
  ): Promise<ListResponse<SystemLogRow>> {
    return request<ListResponse<SystemLogRow>>('/api/system/log', { query: { ...params }, signal });
  },

  /** `GET /api/metrics` — Prometheus text exposition, returned verbatim. */
  metrics(signal?: AbortSignal): Promise<string> {
    return request<string>('/api/metrics', { headers: { Accept: 'text/plain' }, signal });
  },

  /**
   * `GET /api/config` — effective config, secrets redacted.
   *
   * The service wraps the config in `{"config": …, "warnings": […]}` while
   * docs/API.md describes the bare object. Both are unwrapped here, at the one
   * boundary that touches the wire, so no page has to guess: every caller gets
   * `{ config, warnings }` and reads `data.config.site?.timezone`.
   */
  async config(signal?: AbortSignal): Promise<ConfigResponse> {
    const raw = await request<unknown>('/api/config', { signal });
    const root: Record<string, unknown> =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const inner = root.config;
    const config = (
      typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? inner : root
    ) as EffectiveConfig;
    const warnings = Array.isArray(root.warnings)
      ? root.warnings.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { config, warnings };
  },

  /** `POST /api/system/recompute` — rebuild night rollups. */
  recompute(body: RecomputeRequest, idempotencyKey?: string): Promise<RecomputeResult> {
    return request<RecomputeResult>('/api/system/recompute', {
      method: 'POST',
      body,
      idempotencyKey,
    });
  },
} as const;

export const children = {
  /** `GET /api/children` */
  list(
    params: { include_inactive?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<ListResponse<Child>> {
    return request<ListResponse<Child>>('/api/children', { query: { ...params }, signal });
  },

  /** `POST /api/children` */
  create(body: ChildCreate, idempotencyKey?: string): Promise<Child> {
    return request<Child>('/api/children', { method: 'POST', body, idempotencyKey });
  },

  /** `PATCH /api/children/{id}` */
  update(id: number, body: ChildPatch, idempotencyKey?: string): Promise<Child> {
    return request<Child>(`/api/children/${id}`, { method: 'PATCH', body, idempotencyKey });
  },

  /** `DELETE /api/children/{id}` — soft delete (`active=0`). */
  remove(id: number, idempotencyKey?: string): Promise<void> {
    return request<void>(`/api/children/${id}`, { method: 'DELETE', idempotencyKey });
  },
} as const;

export const state = {
  /** `GET /api/state?child_id=1` */
  get(childId?: number, signal?: AbortSignal): Promise<LiveState> {
    return request<LiveState>('/api/state', { query: { child_id: childId }, signal });
  },
} as const;

export const events = {
  /** `GET /api/events` */
  list(query: EventsQuery = {}, signal?: AbortSignal): Promise<ListResponse<BabyEvent>> {
    return request<ListResponse<BabyEvent>>('/api/events', { query: { ...query }, signal });
  },

  /** `POST /api/events` — a manual event. */
  create(body: EventCreate, idempotencyKey?: string): Promise<BabyEvent> {
    return request<BabyEvent>('/api/events', { method: 'POST', body, idempotencyKey });
  },

  /** `PATCH /api/events/{id}` */
  update(id: number, body: EventPatch, idempotencyKey?: string): Promise<BabyEvent> {
    return request<BabyEvent>(`/api/events/${id}`, { method: 'PATCH', body, idempotencyKey });
  },

  /** Acknowledge an event. Convenience over {@link events.update}. */
  acknowledge(id: number, acknowledged = true): Promise<BabyEvent> {
    return events.update(id, { acknowledged });
  },

  /**
   * Relabel an event. Pass `''` to mark it a false positive — the
   * detector-tuning report reads those.
   */
  correctLabel(id: number, correctedLabel: string): Promise<BabyEvent> {
    return events.update(id, { corrected_label: correctedLabel });
  },

  /** Undo a correction, returning the event to the detector's own label. */
  clearCorrection(id: number): Promise<BabyEvent> {
    return events.update(id, { corrected_label: null });
  },

  setSeverity(id: number, severity: Severity): Promise<BabyEvent> {
    return events.update(id, { severity });
  },

  /** `DELETE /api/events/{id}` — manual events only. */
  remove(id: number, idempotencyKey?: string): Promise<void> {
    return request<void>(`/api/events/${id}`, { method: 'DELETE', idempotencyKey });
  },
} as const;

export const notes = {
  /** `GET /api/notes` */
  list(query: NotesQuery = {}, signal?: AbortSignal): Promise<ListResponse<Note>> {
    return request<ListResponse<Note>>('/api/notes', { query: { ...query }, signal });
  },

  /**
   * `POST /api/notes`. `night_of` is derived from `ts_ms` (or now) when
   * omitted, and unknown tag slugs are created on the fly while
   * `api.notes.autocreate_tags` is on.
   */
  create(body: NoteCreate, idempotencyKey?: string): Promise<Note> {
    return request<Note>('/api/notes', { method: 'POST', body, idempotencyKey });
  },

  /** `PATCH /api/notes/{id}` — `tags` replaces the whole set. */
  update(id: number, body: NotePatch, idempotencyKey?: string): Promise<Note> {
    return request<Note>(`/api/notes/${id}`, { method: 'PATCH', body, idempotencyKey });
  },

  /** `DELETE /api/notes/{id}` — soft delete. */
  remove(id: number, idempotencyKey?: string): Promise<void> {
    return request<void>(`/api/notes/${id}`, { method: 'DELETE', idempotencyKey });
  },
} as const;

export const tags = {
  /** `GET /api/tags` */
  list(
    params: { include_archived?: boolean; with_stats?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<ListResponse<TagWithStats>> {
    return request<ListResponse<TagWithStats>>('/api/tags', { query: { ...params }, signal });
  },

  /** `POST /api/tags` */
  create(body: TagCreate, idempotencyKey?: string): Promise<Tag> {
    return request<Tag>('/api/tags', { method: 'POST', body, idempotencyKey });
  },

  /** `PATCH /api/tags/{id}` */
  update(id: number, body: TagPatch, idempotencyKey?: string): Promise<Tag> {
    return request<Tag>(`/api/tags/${id}`, { method: 'PATCH', body, idempotencyKey });
  },

  /** `DELETE /api/tags/{id}` — archives; never destroys history. */
  remove(id: number, idempotencyKey?: string): Promise<void> {
    return request<void>(`/api/tags/${id}`, { method: 'DELETE', idempotencyKey });
  },
} as const;

export const nights = {
  /** `GET /api/nights` — the rollup rows. */
  list(query: NightsQuery = {}, signal?: AbortSignal): Promise<ListResponse<Night>> {
    return request<ListResponse<Night>>('/api/nights', { query: { ...query }, signal });
  },

  /** `GET /api/nights/{night_of}` — rollup plus segments, events, notes, series. */
  get(
    nightOf: NightOf,
    params: { child_id?: number; series_bucket_s?: number } = {},
    signal?: AbortSignal,
  ): Promise<NightDetail> {
    return request<NightDetail>(`/api/nights/${encodeURIComponent(nightOf)}`, {
      query: { ...params },
      signal,
    });
  },

  /** `GET /api/nights/{night_of}/series` — just the time series, for charting. */
  series(
    nightOf: NightOf,
    params: { child_id?: number; series_bucket_s?: number } = {},
    signal?: AbortSignal,
  ): Promise<NightSeries> {
    return request<NightSeries>(`/api/nights/${encodeURIComponent(nightOf)}/series`, {
      query: { ...params },
      signal,
    });
  },

  /**
   * `PATCH /api/nights/{night_of}` — manual correction of the anchors.
   * Triggers a recompute that respects the overrides.
   */
  update(
    nightOf: NightOf,
    body: NightPatch,
    params: { child_id?: number } = {},
    idempotencyKey?: string,
  ): Promise<Night> {
    return request<Night>(`/api/nights/${encodeURIComponent(nightOf)}`, {
      method: 'PATCH',
      query: { ...params },
      body,
      idempotencyKey,
    });
  },

  /** `POST /api/nights/{night_of}/recompute` */
  recompute(
    nightOf: NightOf,
    params: { child_id?: number } = {},
    idempotencyKey?: string,
  ): Promise<Night> {
    return request<Night>(`/api/nights/${encodeURIComponent(nightOf)}/recompute`, {
      method: 'POST',
      query: { ...params },
      idempotencyKey,
    });
  },
} as const;

export const analytics = {
  /** `GET /api/analytics/summary` */
  summary(params: AnalyticsWindow = {}, signal?: AbortSignal): Promise<AnalyticsSummary> {
    return request<AnalyticsSummary>('/api/analytics/summary', { query: { ...params }, signal });
  },

  /** `GET /api/analytics/trends` */
  trends(
    params: AnalyticsWindow & { metric?: NightMetric | string; bucket?: 'night' | 'week' } = {},
    signal?: AbortSignal,
  ): Promise<TrendsResponse> {
    return request<TrendsResponse>('/api/analytics/trends', { query: { ...params }, signal });
  },

  /** `GET /api/analytics/factors` — the correlation engine. */
  factors(
    params: AnalyticsWindow & { metric?: NightMetric | string; min_n?: number } = {},
    signal?: AbortSignal,
  ): Promise<FactorsResponse> {
    return request<FactorsResponse>('/api/analytics/factors', { query: { ...params }, signal });
  },

  /** `GET /api/analytics/regularity` */
  regularity(params: AnalyticsWindow = {}, signal?: AbortSignal): Promise<RegularityResponse> {
    return request<RegularityResponse>('/api/analytics/regularity', {
      query: { ...params },
      signal,
    });
  },

  /** `GET /api/analytics/patterns` */
  patterns(
    params: AnalyticsWindow & { metric?: NightMetric | string } = {},
    signal?: AbortSignal,
  ): Promise<PatternsResponse> {
    return request<PatternsResponse>('/api/analytics/patterns', { query: { ...params }, signal });
  },

  /** `GET /api/analytics/export?format=json` — the per-night factor matrix. */
  exportJson(
    params: AnalyticsWindow = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    return request<Record<string, unknown>[]>('/api/analytics/export', {
      query: { ...params, format: 'json' },
      signal,
    });
  },

  /** `GET /api/analytics/export?format=csv` — as text. */
  exportCsv(params: AnalyticsWindow = {}, signal?: AbortSignal): Promise<string> {
    return request<string>('/api/analytics/export', {
      query: { ...params, format: 'csv' },
      headers: { Accept: 'text/csv' },
      signal,
    });
  },

  /** A URL suitable for a download link rather than a fetch. */
  exportUrl(params: AnalyticsWindow & { format?: 'csv' | 'json' } = {}): string {
    return apiUrl('/api/analytics/export', { format: 'csv', ...params });
  },
} as const;

export const media = {
  /** `GET /api/media?night_of=&kind=&event_id=` */
  list(query: MediaQuery = {}, signal?: AbortSignal): Promise<ListResponse<Media>> {
    return request<ListResponse<Media>>('/api/media', { query: { ...query }, signal });
  },

  /** `GET /api/media/{id}/meta` */
  meta(id: number, signal?: AbortSignal): Promise<Media> {
    return request<Media>(`/api/media/${id}/meta`, { signal });
  },

  /**
   * `GET /api/media/{id}` — the stored file. Returned as a URL rather than a
   * fetch: this belongs in an `<img>`, `<audio>` or `<video>` src, and the
   * endpoint supports `Range`. Pass a token from {@link auth.mediaToken} when
   * the element cannot send the cookie (cross-origin dev, mostly).
   */
  fileUrl(id: number, token?: string): string {
    return apiUrl(`/api/media/${id}`, { t: token });
  },

  /** `GET /api/snapshot.jpg` — current frame. */
  snapshotUrl(
    params: {
      width?: number;
      height?: number;
      max_age_s?: number;
      token?: string;
      /** Cache-buster; bump to force a fresh fetch of the same URL. */
      cacheKey?: string | number;
    } = {},
  ): string {
    const { token, cacheKey, ...rest } = params;
    return apiUrl('/api/snapshot.jpg', { ...rest, t: token, _: cacheKey });
  },

  /** `GET /api/stream/mjpeg` — `multipart/x-mixed-replace` preview. */
  mjpegUrl(params: { fps?: number; width?: number; token?: string } = {}): string {
    const { token, ...rest } = params;
    return apiUrl('/api/stream/mjpeg', { ...rest, t: token });
  },
} as const;

export const homekit = {
  /** `GET /api/homekit/state` */
  state(params: { child_id?: number } = {}, signal?: AbortSignal): Promise<HomeKitState> {
    return request<HomeKitState>('/api/homekit/state', { query: { ...params }, signal });
  },

  /** `POST /api/homekit/tag` — a HomeKit switch was flipped. Idempotent. */
  tag(
    body: { slug: string; on: boolean; child_id?: number },
    idempotencyKey?: string,
  ): Promise<Note | null> {
    return request<Note | null>('/api/homekit/tag', { method: 'POST', body, idempotencyKey });
  },

  /** `POST /api/homekit/recording` — logs an `hksv_recording` system event. */
  recording(
    body: { state: 'started' | 'stopped'; reason?: string; stream_id?: number },
    idempotencyKey?: string,
  ): Promise<void> {
    return request<void>('/api/homekit/recording', { method: 'POST', body, idempotencyKey });
  },

  /** `GET /api/homekit/pairing` — for the dashboard's pairing card. */
  pairing(signal?: AbortSignal): Promise<HomeKitPairing> {
    return request<HomeKitPairing>('/api/homekit/pairing', { signal });
  },
} as const;

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface EventStreamOptions {
  childId?: number;
  /** `?types=` — subscribe selectively. Omit for everything. */
  types?: readonly StreamTypeFilter[];
  /** Reconnect backoff floor, ms. */
  minBackoffMs?: number;
  /** Reconnect backoff ceiling, ms. */
  maxBackoffMs?: number;
  /**
   * Force a reconnect if nothing at all arrives for this long. The server
   * heartbeats every `api.sse_heartbeat_s` (default 20 s), so silence well
   * past that means the link is dead even though the socket still looks open —
   * which is exactly what happens when a phone wakes from sleep on a new
   * network.
   */
  heartbeatTimeoutMs?: number;
  /** Connect straight away. Default true. */
  autoStart?: boolean;
}

type AnyListener = (payload: never) => void;
type StatusListener = (status: StreamStatus) => void;
type ErrorListener = (error: unknown) => void;

/**
 * A reconnecting, typed wrapper around `GET /api/stream/events`.
 *
 * The browser's own `EventSource` reconnects, but on a fixed interval it does
 * not expose and with no way to tell "the Pi rebooted" from "the phone is in a
 * tunnel". This wrapper drives reconnection itself with exponential backoff
 * and jitter, reports status transitions so the UI can show a stale badge, and
 * reconnects immediately when the browser comes back online or the tab is
 * brought to the foreground.
 *
 * ```ts
 * const stream = new EventStream({ childId: 1 });
 * const off = stream.on('state', (s) => setLive(s));
 * // ... later
 * off();
 * stream.close();
 * ```
 */
export class EventStream {
  private readonly url: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly heartbeatTimeoutMs: number;

  private source: EventSource | null = null;
  private attempt = 0;
  private closed = false;
  private currentStatus: StreamStatus = 'closed';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageMs: EpochMs | null = null;

  private readonly listeners = new Map<StreamEventName, Set<AnyListener>>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(options: EventStreamOptions = {}) {
    const {
      childId,
      types,
      minBackoffMs = 1_000,
      maxBackoffMs = 30_000,
      heartbeatTimeoutMs = 60_000,
      autoStart = true,
    } = options;

    this.url = apiUrl('/api/stream/events', { child_id: childId, types });
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      document.addEventListener('visibilitychange', this.handleVisibility);
    }

    if (autoStart) this.connect();
  }

  // -- public surface -------------------------------------------------------

  get status(): StreamStatus {
    return this.currentStatus;
  }

  /** When the last message of any kind arrived, or null if none yet. */
  get lastMessageAt(): EpochMs | null {
    return this.lastMessageMs;
  }

  /** Subscribe to a named event. Returns an unsubscribe function. */
  on<K extends StreamEventName>(
    name: K,
    listener: (payload: StreamEventMap[K]) => void,
  ): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    const entry = listener as AnyListener;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Subscribe to connection status transitions. Fires immediately. */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Transport and parse errors. Purely informational; the stream retries. */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Reconnect now, resetting the backoff. Safe to call at any time. */
  reconnect(): void {
    if (this.closed) return;
    this.attempt = 0;
    this.teardownSource();
    this.connect();
  }

  /** Close for good. The instance cannot be reopened. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.teardownSource();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    this.setStatus('closed');
    this.listeners.clear();
    this.statusListeners.clear();
    this.errorListeners.clear();
  }

  // -- internals ------------------------------------------------------------

  private connect(): void {
    if (this.closed || this.source) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let source: EventSource;
    try {
      source = new EventSource(this.url, { withCredentials: true });
    } catch (error) {
      this.emitError(error);
      this.scheduleReconnect();
      return;
    }
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      this.touch();
      this.setStatus('open');
    };

    source.onerror = (event) => {
      // EventSource fires `error` for both a failed connect and a dropped
      // connection, and does not tell us which. Either way: back off and
      // rebuild the socket ourselves rather than let it retry blindly.
      this.emitError(event);
      this.teardownSource();
      this.scheduleReconnect();
    };

    for (const name of STREAM_EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        this.touch();
        this.dispatch(name, (event as MessageEvent<string>).data);
      });
    }

    // Unnamed `message` frames are not part of the contract, but counting them
    // keeps the watchdog honest if the server ever sends a bare comment ping.
    source.onmessage = () => this.touch();
  }

  private dispatch(name: StreamEventName, raw: string): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      this.emitError(error);
      return;
    }
    for (const listener of set) {
      try {
        (listener as (value: unknown) => void)(payload);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const exponential = this.minBackoffMs * Math.pow(1.8, this.attempt);
    const capped = Math.min(exponential, this.maxBackoffMs);
    // +/-25% jitter so several tabs do not stampede the Pi in lockstep.
    const jittered = capped * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, Math.round(jittered));
  }

  /** Record traffic and re-arm the silence watchdog. */
  private touch(): void {
    this.lastMessageMs = Date.now();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.closed) return;
      // Socket looks open but nothing is coming through. Rebuild it.
      this.teardownSource();
      this.scheduleReconnect();
    }, this.heartbeatTimeoutMs);
  }

  private teardownSource(): void {
    if (!this.source) return;
    this.source.onopen = null;
    this.source.onerror = null;
    this.source.onmessage = null;
    this.source.close();
    this.source = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private setStatus(status: StreamStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        /* a status listener must never break the stream */
      }
    }
  }

  private emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        /* ignore */
      }
    }
  }

  private readonly handleOnline = (): void => {
    if (this.currentStatus !== 'open') this.reconnect();
  };

  private readonly handleVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    // A backgrounded tab on a phone gets its socket killed silently.
    const stale =
      this.lastMessageMs === null || Date.now() - this.lastMessageMs > this.heartbeatTimeoutMs / 2;
    if (this.currentStatus !== 'open' || stale) this.reconnect();
  };
}

/** Convenience factory, so callers need not import the class. */
export function openEventStream(options: EventStreamOptions = {}): EventStream {
  return new EventStream(options);
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

/** Every endpoint group under one object, for `import { api } from './api'`. */
export const api = {
  analytics,
  auth,
  children,
  events,
  homekit,
  media,
  nights,
  notes,
  state,
  system,
  tags,
  url: apiUrl,
  openEventStream,
} as const;

export default api;
