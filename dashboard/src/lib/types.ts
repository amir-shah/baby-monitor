/**
 * TypeScript mirror of the babymon HTTP contract.
 *
 * Sources of truth, in order:
 *   1. docs/API.md                    — wire shapes and query parameters
 *   2. pi/babymon/models.py           — enum vocabularies and record fields
 *   3. pi/babymon/storage/schema.sql  — nullability
 *
 * Conventions carried over verbatim:
 *   - `*_ms` is an integer Unix epoch **millisecond** count, UTC.
 *   - `*_iso` is RFC 3339 with the child's local offset.
 *   - `night_of` is `"YYYY-MM-DD"`, the local date a night began.
 *   - `*_min` is minutes, `*_s` is seconds, both as JSON numbers.
 *   - Anything the sensors may not have observed is `| null`, not optional.
 *     Fields the server may legitimately omit are `?`.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Epoch milliseconds, UTC. */
export type EpochMs = number;

/** Local calendar date, `"YYYY-MM-DD"`. */
export type NightOf = string;

/** Local wall-clock time, `"HH:MM"`. */
export type LocalTime = string;

/** IANA timezone name, e.g. `"America/Los_Angeles"`. */
export type Timezone = string;

// ---------------------------------------------------------------------------
// Enumerations (models.py StrEnum -> string unions)
// ---------------------------------------------------------------------------

/** `models.SleepState`. Ordered "not here" -> "deeply asleep". */
export type SleepState = 'unknown' | 'absent' | 'awake' | 'settling' | 'restless' | 'asleep';

export const SLEEP_STATES = [
  'unknown',
  'absent',
  'awake',
  'settling',
  'restless',
  'asleep',
] as const satisfies readonly SleepState[];

/** `SleepState.counts_as_sleep` */
export function countsAsSleep(state: SleepState): boolean {
  return state === 'asleep' || state === 'restless';
}

/** `SleepState.counts_as_in_bed` */
export function countsAsInBed(state: SleepState): boolean {
  return state === 'asleep' || state === 'restless' || state === 'settling' || state === 'awake';
}

/** `models.EventKind` */
export type EventKind = 'audio' | 'motion' | 'sleep' | 'environment' | 'system' | 'manual';

export const EVENT_KINDS = [
  'audio',
  'motion',
  'sleep',
  'environment',
  'system',
  'manual',
] as const satisfies readonly EventKind[];

/**
 * `models.EventLabel` — the stable, persisted event vocabulary.
 *
 * The schema comment for `events.label` also lists a motion label `still`
 * that has no `EventLabel` member; it is included here so a row written by an
 * older build still narrows. New labels may appear without a dashboard
 * release, so consumers should treat unknown strings as `EventLabel` via
 * {@link AnyEventLabel} rather than crashing.
 */
export type EventLabel =
  // audio
  | 'cry'
  | 'fuss'
  | 'whimper'
  | 'scream'
  | 'talk'
  | 'cough'
  | 'sneeze'
  | 'snore'
  | 'laugh'
  | 'door'
  | 'noise'
  | 'unknown'
  // motion
  | 'motion'
  | 'restless'
  | 'still'
  // sleep structure
  | 'bedtime'
  | 'sleep_onset'
  | 'awakening'
  | 'back_to_sleep'
  | 'final_wake'
  | 'out_of_bed'
  | 'returned_to_bed'
  // environment
  | 'temp_high'
  | 'temp_low'
  | 'humidity_high'
  | 'humidity_low'
  // system
  | 'started'
  | 'stopped'
  | 'camera_error'
  | 'mic_error'
  | 'sensor_error'
  | 'hksv_recording'
  // manual
  | 'checked_in'
  | 'fed'
  | 'diaper'
  | 'medicine'
  | 'note';

/**
 * A label that is probably an {@link EventLabel} but might be something a
 * newer service emits. `(string & {})` keeps editor autocomplete on the known
 * members while still accepting anything.
 */
export type AnyEventLabel = EventLabel | (string & {});

/** `models.WAKE_LABELS` — sounds that suggest the child may be waking. */
export const WAKE_LABELS = ['cry', 'fuss', 'whimper', 'scream', 'talk'] as const;

/** `models.CRY_LABELS` — the distress subset. */
export const CRY_LABELS = ['cry', 'scream', 'whimper', 'fuss'] as const;

/** `models.Severity`. Drives notification behaviour, never statistics. */
export type Severity = 'info' | 'notice' | 'alert';

export const SEVERITIES = ['info', 'notice', 'alert'] as const satisfies readonly Severity[];

/** `Severity.rank` */
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, notice: 1, alert: 2 };

/** `models.MediaKind` */
export type MediaKind = 'snapshot' | 'audio_clip' | 'video_clip';

/** `models.TagCategory` */
export type TagCategory =
  | 'food'
  | 'screen'
  | 'activity'
  | 'environment'
  | 'routine'
  | 'health'
  | 'care'
  | 'other';

export const TAG_CATEGORIES = [
  'food',
  'screen',
  'activity',
  'environment',
  'routine',
  'health',
  'care',
  'other',
] as const satisfies readonly TagCategory[];

/** `models.TagValueType` */
export type TagValueType = 'bool' | 'number' | 'time' | 'duration' | 'text';

export const TAG_VALUE_TYPES = [
  'bool',
  'number',
  'time',
  'duration',
  'text',
] as const satisfies readonly TagValueType[];

/** `TagValueType.is_analysable` — text tags are display-only. */
export function isAnalysable(valueType: TagValueType): boolean {
  return valueType !== 'text';
}

/** `TagValueType.is_continuous` */
export function isContinuous(valueType: TagValueType): boolean {
  return valueType === 'number' || valueType === 'time' || valueType === 'duration';
}

/** `models.NightStatus` */
export type NightStatus = 'in_progress' | 'complete' | 'partial' | 'excluded';

/** `notes.source` */
export type NoteSource = 'dashboard' | 'homekit' | 'api' | 'import' | 'auto';

/** `events.source` / `sleep_segments.source` */
export type RecordSource = 'detector' | 'manual' | 'homekit' | 'api' | 'import';

/** `system_log.level` */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/** `tags.expected_direction` — cosmetic ordering hint only. */
export type ExpectedDirection = 'worse' | 'better';

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** `{"items": [...], "total": N, "limit": L, "offset": O}` */
export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** `{"error": {"code": "...", "message": "...", "detail": {...}}}` */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown> | null;
  };
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

export interface Child {
  id: number;
  name: string;
  birthdate: string | null;
  room: string | null;
  timezone: Timezone | null;
  /** Local hour (0-23) separating one `night_of` from the next. Default 12. */
  day_boundary_hour: number;
  target_bedtime: LocalTime | null;
  target_waketime: LocalTime | null;
  active: boolean;
  avatar_color: string | null;
  created_ms: EpochMs;
  updated_ms: EpochMs;
  /** Present when the server can compute it (child has a birthdate). */
  age_days?: number | null;
}

export interface ChildCreate {
  name: string;
  birthdate?: string | null;
  room?: string | null;
  timezone?: Timezone | null;
  target_bedtime?: LocalTime | null;
  target_waketime?: LocalTime | null;
  day_boundary_hour?: number;
  avatar_color?: string | null;
}

export type ChildPatch = Partial<ChildCreate> & { active?: boolean };

// ---------------------------------------------------------------------------
// Tags and notes
// ---------------------------------------------------------------------------

export interface Tag {
  id: number;
  slug: string;
  label: string;
  category: TagCategory;
  value_type: TagValueType;
  unit: string | null;
  color: string | null;
  icon: string | null;
  expected_direction: ExpectedDirection | null;
  builtin: boolean;
  archived: boolean;
  created_ms: EpochMs;
}

/** `GET /api/tags?with_stats=1` adds these. */
export interface TagStats {
  nights_applied: number;
  first_ms: EpochMs | null;
  last_ms: EpochMs | null;
}

export type TagWithStats = Tag & Partial<TagStats>;

export interface TagCreate {
  slug: string;
  label: string;
  category?: TagCategory;
  value_type?: TagValueType;
  unit?: string | null;
  color?: string | null;
  icon?: string | null;
  expected_direction?: ExpectedDirection | null;
}

export type TagPatch = Partial<Omit<TagCreate, 'slug'>> & { slug?: string; archived?: boolean };

/**
 * A tag as it appears attached to a note. Which value field is populated
 * depends on `value_type`:
 *   bool      -> none (presence is the signal)
 *   number    -> value_num
 *   duration  -> value_num, in minutes
 *   time      -> value_min_local, minutes after local midnight
 *                (may exceed 1440 or go negative)
 *   text      -> value_text
 */
export interface NoteTag {
  slug: string;
  label: string;
  category: TagCategory;
  value_type: TagValueType;
  value_num?: number | null;
  value_min_local?: number | null;
  value_text?: string | null;
  /** Server-rendered display form, e.g. `"19:30"` for a time tag. */
  value_display?: string | null;
}

/** The tag half of a note write. Only `slug` is required. */
export interface NoteTagInput {
  slug: string;
  value_num?: number | null;
  value_min_local?: number | null;
  value_text?: string | null;
}

export interface Note {
  id: number;
  child_id: number;
  night_of: NightOf;
  /** Null for a note about the night as a whole rather than a moment in it. */
  ts_ms: EpochMs | null;
  ts_iso?: string | null;
  body: string;
  source: NoteSource;
  tags: NoteTag[];
  created_ms: EpochMs;
  updated_ms: EpochMs;
  deleted_ms?: EpochMs | null;
}

export interface NoteCreate {
  child_id: number;
  /** Derived from `ts_ms` (or now) when omitted. */
  night_of?: NightOf;
  ts_ms?: EpochMs | null;
  body: string;
  tags?: NoteTagInput[];
}

/** `tags` replaces the whole set when present. */
export type NotePatch = Partial<Omit<NoteCreate, 'child_id'>>;

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * One telemetry tick (`samples` row / `models.Sample`). The night timeline is
 * drawn from these.
 */
export interface Sample {
  ts_ms: EpochMs;
  child_id: number;
  night_of: NightOf;
  sound_dbfs: number | null;
  sound_peak_dbfs: number | null;
  noise_floor_dbfs: number | null;
  cry_score: number | null;
  motion: number | null;
  temp_c: number | null;
  humidity_pct: number | null;
  lux: number | null;
  state: SleepState;
}

/**
 * A downsampled point from `/api/nights/{night_of}/series`. Same shape as a
 * `Sample` minus the identity columns, with the bucket's dominant state.
 * Every measure is nullable: a bucket may contain no reading at all.
 */
export interface SeriesPoint {
  ts_ms: EpochMs;
  sound_dbfs: number | null;
  sound_peak_dbfs: number | null;
  noise_floor_dbfs: number | null;
  cry_score: number | null;
  motion: number | null;
  temp_c: number | null;
  humidity_pct: number | null;
  lux: number | null;
  state: SleepState | null;
}

export interface NightSeries {
  child_id: number;
  night_of: NightOf;
  /** Bucket width actually used, which may differ from what was requested. */
  bucket_s: number;
  from_ms: EpochMs;
  to_ms: EpochMs;
  points: SeriesPoint[];
}

// ---------------------------------------------------------------------------
// Events and media
// ---------------------------------------------------------------------------

/** The media summary embedded in an `Event`. */
export interface MediaRef {
  id: number;
  kind: MediaKind;
  duration_s?: number | null;
}

export interface Media {
  id: number;
  child_id: number;
  night_of: NightOf;
  event_id: number | null;
  kind: MediaKind;
  rel_path: string;
  mime: string;
  bytes: number | null;
  duration_s: number | null;
  ts_ms: EpochMs;
  expires_ms: EpochMs | null;
  created_ms: EpochMs;
}

/**
 * A discrete thing worth a line in the log. Named `BabyEvent` because `Event`
 * is a DOM global and shadowing it in a browser app is a footgun.
 */
export interface BabyEvent {
  id: number;
  child_id: number;
  night_of: NightOf;
  start_ms: EpochMs;
  /** Null while the event is still open. */
  end_ms: EpochMs | null;
  duration_s: number | null;
  kind: EventKind;
  label: AnyEventLabel;
  confidence: number | null;
  severity: Severity;
  peak_dbfs: number | null;
  mean_dbfs: number | null;
  motion_peak: number | null;
  source: RecordSource;
  /** Null = untouched. `""` = the user says this was not a real event. */
  corrected_label: string | null;
  acknowledged_ms: EpochMs | null;
  meta: EventMeta;
  media?: MediaRef[];
  created_ms?: EpochMs;
}

/** Detector-specific extras. `classes` is the classifier's score map. */
export interface EventMeta {
  classes?: Record<string, number>;
  [key: string]: unknown;
}

/** `Event.effective_label` — the label after any user correction. */
export function effectiveLabel(event: BabyEvent): string {
  return event.corrected_label === null ? event.label : event.corrected_label;
}

/** `Event.is_false_positive` */
export function isFalsePositive(event: BabyEvent): boolean {
  return event.corrected_label === '';
}

/** `Event.is_open` */
export function isOpen(event: BabyEvent): boolean {
  return event.end_ms === null;
}

export interface EventCreate {
  child_id: number;
  start_ms: EpochMs;
  end_ms?: EpochMs | null;
  kind: EventKind;
  label: AnyEventLabel;
  severity?: Severity;
  meta?: EventMeta;
}

export interface EventPatch {
  /** `""` marks a false positive; the detector-tuning report reads these. */
  corrected_label?: string | null;
  acknowledged?: boolean;
  severity?: Severity;
}

// ---------------------------------------------------------------------------
// Sleep structure
// ---------------------------------------------------------------------------

/** One span of the hypnogram. Contiguous and non-overlapping per child. */
export interface SleepSegment {
  id: number;
  child_id: number;
  night_of: NightOf;
  start_ms: EpochMs;
  end_ms: EpochMs;
  state: SleepState;
  confidence: number | null;
  /** A manual segment always wins over a detected one. */
  source: RecordSource;
  created_ms?: EpochMs;
}

/** The per-night rollup. Entirely derived; safe to delete and rebuild. */
export interface Night {
  child_id: number;
  night_of: NightOf;
  timezone: Timezone;

  // Anchors
  bedtime_ms: EpochMs | null;
  sleep_onset_ms: EpochMs | null;
  final_wake_ms: EpochMs | null;
  out_of_bed_ms: EpochMs | null;

  // Core metrics
  /** Time in bed. */
  tib_min: number | null;
  /** Total sleep time. */
  tst_min: number | null;
  /** Sleep onset latency. */
  sol_min: number | null;
  /** Wake after sleep onset. */
  waso_min: number | null;
  awakenings: number | null;
  longest_bout_min: number | null;
  /** TST / TIB, 0..1. */
  sleep_efficiency: number | null;
  midpoint_ms: EpochMs | null;
  restless_min: number | null;

  // Noise / activity
  cry_events: number;
  cry_min: number | null;
  noise_events: number;
  peak_dbfs: number | null;
  mean_dbfs: number | null;
  /** Mean motion during the sleep period. */
  motion_index: number | null;

  // Environment
  temp_c_mean: number | null;
  temp_c_min: number | null;
  temp_c_max: number | null;
  humidity_mean: number | null;

  // Scoring
  /** 0..100. */
  quality_score: number | null;
  score_components: ScoreComponents;
  /** 0..1 fraction of the night the sensors were reporting. */
  coverage: number | null;
  status: NightStatus;
  excluded: boolean;
  exclude_reason: string | null;

  age_days: number | null;
  computed_ms: EpochMs | null;
  schema_version: number;

  /** RFC 3339 convenience fields the API adds for anchors. */
  bedtime_iso?: string | null;
  sleep_onset_iso?: string | null;
  final_wake_iso?: string | null;
  out_of_bed_iso?: string | null;
}

/** Per-component subscores and weights behind `quality_score`. */
export interface ScoreComponent {
  score: number | null;
  weight: number;
  /** Human-readable reason a component was dropped. */
  reason?: string | null;
  [key: string]: unknown;
}

export type ScoreComponents = Partial<
  Record<'duration' | 'efficiency' | 'continuity' | 'timing' | 'environment', ScoreComponent>
> & { [key: string]: unknown };

/** `Night.analysable` — whether this night may enter the statistics. */
export function isAnalysableNight(night: Night): boolean {
  return !night.excluded && night.status === 'complete' && night.quality_score !== null;
}

/** `GET /api/nights/{night_of}` — the rollup plus everything to draw it. */
export interface NightDetail extends Night {
  segments: SleepSegment[];
  events: BabyEvent[];
  notes: Note[];
  series: SeriesPoint[];
  /** Bucket width of `series`, seconds. */
  series_bucket_s?: number;
}

export interface NightPatch {
  excluded?: boolean;
  exclude_reason?: string | null;
  bedtime_ms?: EpochMs | null;
  sleep_onset_ms?: EpochMs | null;
  final_wake_ms?: EpochMs | null;
  out_of_bed_ms?: EpochMs | null;
}

// ---------------------------------------------------------------------------
// Live state and the SSE channel
// ---------------------------------------------------------------------------

/** Tallies for the night in progress, embedded in {@link LiveState}. */
export interface NightSoFar {
  tst_min: number | null;
  awakenings: number | null;
  cry_events: number | null;
  [key: string]: number | null | undefined;
}

/** `GET /api/state` and the SSE `state` event. */
export interface LiveState {
  ts_ms: EpochMs;
  child_id: number;
  night_of: NightOf;
  state: SleepState;
  state_since_ms: EpochMs | null;
  /** Null unless the current state counts as sleep. */
  asleep_for_min: number | null;
  sound_dbfs: number | null;
  noise_floor_dbfs: number | null;
  sound_above_floor_db: number | null;
  cry_score: number | null;
  motion: number | null;
  temp_c: number | null;
  humidity_pct: number | null;
  camera_online: boolean;
  audio_online: boolean;
  env_online?: boolean;
  night_so_far: NightSoFar;
}

/** SSE `motion` — debounced motion, what drives the HomeKit motion sensor. */
export interface MotionSignal {
  active: boolean;
  score: number;
  ts_ms: EpochMs;
}

/** SSE `sound` — what drives the HomeKit "sound detected" sensor. */
export interface SoundSignal {
  active: boolean;
  label: AnyEventLabel;
  confidence: number;
  peak_dbfs: number;
  ts_ms: EpochMs;
}

/** SSE `heartbeat`, every `api.sse_heartbeat_s` (default 20 s). */
export interface Heartbeat {
  ts_ms: EpochMs;
}

/** The named events `GET /api/stream/events` emits, and their payloads. */
export interface StreamEventMap {
  state: LiveState;
  'event.open': BabyEvent;
  'event.close': BabyEvent;
  note: Note;
  night: Night;
  motion: MotionSignal;
  sound: SoundSignal;
  heartbeat: Heartbeat;
}

export type StreamEventName = keyof StreamEventMap;

export const STREAM_EVENT_NAMES = [
  'state',
  'event.open',
  'event.close',
  'note',
  'night',
  'motion',
  'sound',
  'heartbeat',
] as const satisfies readonly StreamEventName[];

/** Coarse subscription filter for `?types=`. */
export type StreamTypeFilter = 'state' | 'event' | 'note' | 'night' | 'motion' | 'sound';

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** Any numeric column of {@link Night} usable as an outcome metric. */
export type NightMetric =
  | 'quality_score'
  | 'tst_min'
  | 'tib_min'
  | 'sol_min'
  | 'waso_min'
  | 'awakenings'
  | 'longest_bout_min'
  | 'sleep_efficiency'
  | 'restless_min'
  | 'cry_events'
  | 'cry_min'
  | 'noise_events'
  | 'motion_index'
  | 'temp_c_mean'
  | 'humidity_mean';

export interface MetricDelta {
  /** Value over the current window. */
  value: number | null;
  /** Value over the immediately preceding window of the same length. */
  previous: number | null;
  /** `value - previous`. */
  delta: number | null;
  /** Fractional change, or null when `previous` is null or zero. */
  delta_pct: number | null;
  /** Direction that counts as an improvement for this metric. */
  better?: 'higher' | 'lower' | null;
}

/** The age-appropriate 24 h sleep-duration band, minutes. */
export interface TargetBand {
  metric: NightMetric | string;
  low: number | null;
  high: number | null;
  age_days: number | null;
  /** Where the band came from, e.g. an AASM/NSF recommendation table. */
  source?: string | null;
}

/** `GET /api/analytics/summary` */
export interface AnalyticsSummary {
  child_id: number;
  window_days: number;
  from: NightOf;
  to: NightOf;
  nights_total: number;
  nights_analysable: number;
  metrics: Partial<Record<NightMetric, MetricDelta>> & Record<string, MetricDelta | undefined>;
  target_band: TargetBand | null;
}

export interface TrendPoint {
  /** Present for `bucket=night`. */
  night_of?: NightOf;
  /** Bucket start; present for `bucket=week`. */
  from?: NightOf;
  to?: NightOf;
  ts_ms: EpochMs;
  value: number | null;
  /** Rolling median over the configured window. */
  rolling_median: number | null;
  /** Nights contributing to this bucket. */
  n?: number;
}

/** Ordinary-least-squares fit over the window, per day. */
export interface TrendFit {
  slope_per_day: number | null;
  slope_ci95: [number, number] | null;
  intercept: number | null;
  p_value: number | null;
  r2: number | null;
  /** 'improving' | 'worsening' | 'flat' once the CI excludes zero. */
  direction?: 'improving' | 'worsening' | 'flat' | null;
}

/** `GET /api/analytics/trends` */
export interface TrendsResponse {
  child_id: number;
  metric: NightMetric | string;
  window_days: number;
  bucket: 'night' | 'week';
  points: TrendPoint[];
  fit: TrendFit | null;
  rolling_window: number;
}

export interface EffectSize {
  name: 'hedges_g' | 'cohens_d' | string;
  value: number | null;
  ci95: [number, number] | null;
  magnitude: 'negligible' | 'small' | 'medium' | 'large' | string;
}

export interface Confounder {
  slug: string;
  label?: string;
  /** Phi coefficient with the factor under test. */
  phi: number;
}

export type FactorVerdict = 'worse' | 'better' | 'inconclusive' | 'insufficient_data';

/**
 * One row of the correlation engine.
 *
 * Bool tags carry the two-group comparison fields (`n_with`/`mean_with`/…);
 * `number`/`duration`/`time` tags carry the correlation fields
 * (`spearman_rho`/`slope_per_unit`/`n`) instead. `p_value` and `q_value` are
 * present either way.
 */
export interface FactorResult {
  slug: string;
  label: string;
  value_type: TagValueType;
  category?: TagCategory;

  // Two-group comparison (value_type === 'bool')
  n_with?: number;
  n_without?: number;
  mean_with?: number | null;
  mean_without?: number | null;
  diff?: number | null;
  diff_ci95?: [number, number] | null;
  effect_size?: EffectSize;
  cliffs_delta?: number | null;

  // Correlation (continuous value types)
  n?: number;
  spearman_rho?: number | null;
  rho_ci95?: [number, number] | null;
  /** Change in the outcome metric per one unit of the tag's value. */
  slope_per_unit?: number | null;
  unit?: string | null;

  p_value: number | null;
  /** The null the p-value came from — not always the one requested. */
  test_method?: string | null;
  /**
   * The smallest p-value that null could have produced. A tag on a fixed
   * weekly cycle has only seven distinct rotations, so its p-value cannot go
   * below about 0.14 however large the real effect.
   */
  p_floor?: number | null;
  /** Decimals this metric needs to stay legible; 0.04 of a ratio is not 0. */
  decimals?: number;
  /** Benjamini-Hochberg adjusted p-value. */
  q_value: number | null;
  significant: boolean;
  confounders: Confounder[];
  caveats: string[];
  verdict: FactorVerdict;
}

export interface InsufficientFactor {
  slug: string;
  label?: string;
  n_with?: number;
  n?: number;
  reason: string;
}

export interface FactorMethod {
  test: string;
  iterations: number;
  correction: string;
  alpha: number;
  /** `analytics.permutation_mode` — what was *requested*. */
  permutation_mode?: 'circular_shift' | 'shuffle';
  /**
   * Present when some tags fell back to a weaker null than the one requested,
   * explaining which guarantee those p-values do not carry. `test` above
   * always names the null that actually ran.
   */
  downgraded?: string;
  shrinkage?: boolean;
  seed?: number;
}

/** `GET /api/analytics/factors` — the correlation engine. */
export interface FactorsResponse {
  child_id?: number;
  metric: NightMetric | string;
  window_days: number;
  nights_total: number;
  nights_analysable: number;
  method: FactorMethod;
  factors: FactorResult[];
  insufficient: InsufficientFactor[];
  disclaimer: string;
}

/** One row of the actogram raster: a night, and the spans drawn on it. */
export interface ActogramRow {
  night_of: NightOf;
  /** Minutes after local midnight of the row's left edge (usually noon=720). */
  offset_min: number;
  spans: ActogramSpan[];
}

export interface ActogramSpan {
  /** Minutes after the row's `offset_min`. */
  start_min: number;
  end_min: number;
  state: SleepState;
}

/** `GET /api/analytics/regularity` */
export interface RegularityResponse {
  child_id: number;
  window_days: number;
  /** Sleep Regularity Index, 0..100. */
  sri: number | null;
  /** Standard deviation of bedtime / waketime, minutes. */
  bedtime_sd_min: number | null;
  waketime_sd_min: number | null;
  midpoint_sd_min: number | null;
  /** Mean local clock time, minutes after local midnight. */
  bedtime_mean_min: number | null;
  waketime_mean_min: number | null;
  midpoint_mean_min: number | null;
  nights_analysable: number;
  actogram: ActogramRow[];
}

export interface HistogramBin {
  /** Bin lower edge, in the unit named by the enclosing histogram. */
  from: number;
  to: number;
  count: number;
  label?: string;
}

export interface DayOfWeekEffect {
  /** 0 = Monday, matching ISO-8601. */
  dow: number;
  label: string;
  n: number;
  mean: number | null;
  diff_from_overall: number | null;
}

export interface EnvironmentBin {
  from: number | null;
  to: number | null;
  label: string;
  n: number;
  mean_metric: number | null;
  ci95?: [number, number] | null;
}

/** `GET /api/analytics/patterns` */
export interface PatternsResponse {
  child_id: number;
  window_days: number;
  metric: NightMetric | string;
  /** Awakenings by local clock time; bins are minutes after local midnight. */
  awakening_clock_histogram: HistogramBin[];
  day_of_week: DayOfWeekEffect[];
  temperature_bins: EnvironmentBin[];
  noise_bins: EnvironmentBin[];
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * `GET /api/health`.
 *
 * Each component is a `ComponentHealth` object, not a status string, and it
 * carries subsystem-specific extras alongside the common fields — the camera
 * entry has its resolution and motion stats, the audio entry has its noise
 * floor and detector counters. The index signature is what lets those through
 * without every consumer having to know about them.
 */
export interface Health {
  status: 'ok' | 'degraded';
  uptime_s: number;
  version: string;
  components: Record<string, ComponentHealth | undefined>;
}

/** Free space where the database and the recordings live. */
export interface DiskUsage {
  path: string;
  available: boolean;
  total_bytes?: number;
  used_bytes?: number;
  free_bytes?: number;
  used_fraction?: number | null;
}

/** One subsystem's health, as `babymon.bus.ComponentHealth.to_dict()` emits it. */
export interface ComponentHealth {
  name?: string;
  ok: boolean;
  detail?: string;
  last_ok_ms?: number | null;
  /** Subsystem-specific extras, spread in by the producer. */
  [key: string]: unknown;
}

/**
 * `GET /api/system/info`.
 *
 * Host facts are nested under `host` and temperatures are `temperatures_c`;
 * this mirrors `babymon/api/routers/system.py` exactly rather than flattening,
 * because a shared type that disagrees with the wire is worse than no type —
 * it makes the wrong read compile.
 */
export interface SystemInfo {
  host: {
    hostname: string | null;
    system: string | null;
    release: string | null;
    machine: string | null;
    model: string | null;
    cpu_count: number | null;
    load_avg: [number, number, number] | number[] | null;
    uptime_s: number | null;
  };
  /** Celsius, keyed by sensor name. Empty where the platform exposes none. */
  temperatures_c: Record<string, number | null>;
  disk: DiskUsage;
  media: { dir: string; tracked_bytes: number };
  database: {
    path: string;
    schema_version: number;
    size_bytes: number;
    free_bytes: number;
    wal_bytes: number;
    rows: Record<string, number>;
    disk_total_bytes: number | null;
    disk_free_bytes: number | null;
  };
  versions: Record<string, string | null>;
  config_source: string | null;
  warnings: string[];
}

export interface SystemLogRow {
  id: number;
  ts_ms: EpochMs;
  level: LogLevel;
  component: string;
  message: string;
  meta: Record<string, unknown> | null;
}

/**
 * `GET /api/config` — the effective config with secrets redacted. Mirrors
 * config/babymon.example.yaml; typed loosely on purpose so a config addition
 * does not break the build. Only the handful of keys the dashboard actually
 * reads are named.
 */
export interface EffectiveConfig {
  site?: { name?: string; timezone?: Timezone | null };
  camera?: { enabled?: boolean; rtsp_url?: string | null; fps?: number };
  audio?: { enabled?: boolean };
  environment?: {
    enabled?: boolean;
    comfort?: {
      temp_c_min?: number;
      temp_c_max?: number;
      humidity_min?: number;
      humidity_max?: number;
    };
  };
  sleep?: { sample_interval_s?: number };
  analytics?: {
    default_metric?: string;
    default_window_days?: number;
    min_nights_per_group?: number;
    min_nights_total?: number;
    fdr_q?: number;
  };
  api?: { auth?: { enabled?: boolean }; sse_heartbeat_s?: number };
  homekit?: { enabled?: boolean };
  [key: string]: unknown;
}

/**
 * The actual body of `GET /api/config`.
 *
 * `docs/API.md` describes the endpoint as returning the effective config, but
 * the service wraps it: `pi/babymon/api/routers/system.py:116` returns
 * `{"config": …, "warnings": […]}`. `system.config()` normalises both shapes
 * to this one, so callers always read `data.config.<section>` and never have
 * to know which shape came back.
 */
export interface ConfigResponse {
  config: EffectiveConfig;
  warnings: string[];
}

export interface RecomputeRequest {
  from?: NightOf;
  to?: NightOf;
  child_id?: number;
}

export interface RecomputeResult {
  nights: number;
  from?: NightOf;
  to?: NightOf;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Session {
  authenticated: boolean;
  /** Whether `api.auth.enabled` is on at all. When false, everything is open. */
  auth_enabled: boolean;
  expires_ms?: EpochMs | null;
}

/** Short-lived signed token for `<img src>` / `<video src>` query strings. */
export interface MediaToken {
  token: string;
  expires_ms: EpochMs;
}

// ---------------------------------------------------------------------------
// HomeKit bridge support
// ---------------------------------------------------------------------------

export interface HomeKitTagSwitch {
  slug: string;
  label: string;
  on: boolean;
}

/** `GET /api/homekit/state` */
export interface HomeKitState {
  ts_ms: EpochMs;
  child_id: number;
  temp_c: number | null;
  humidity_pct: number | null;
  motion_detected: boolean;
  sound_detected: boolean;
  occupancy_detected: boolean;
  sleep_state: SleepState;
  awake: boolean;
  tag_switches: HomeKitTagSwitch[];
}

export interface HomeKitPairing {
  paired: boolean;
  /** Formatted `"031-45-154"`. */
  setup_code: string | null;
  setup_id: string | null;
  /** `X-HM://…` URI encoded in the QR code. */
  setup_uri: string | null;
  /** Payload the dashboard renders as a QR code. */
  qr_payload: string | null;
  accessory_name?: string | null;
  paired_controllers?: number;
}
