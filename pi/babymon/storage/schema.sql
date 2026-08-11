-- babymon database schema
--
-- Conventions (these are contracts; do not deviate):
--   * Every timestamp column is named *_ms and holds INTEGER Unix epoch
--     MILLISECONDS in UTC. Never store local time in a timestamp column.
--   * night_of is TEXT 'YYYY-MM-DD' and names the *local* calendar date on
--     which a night began (see babymon.timeutil.night_of). It is the join key
--     for everything the analytics layer does, because a "night" is a local
--     concept that can be 23 or 25 hours long across a DST boundary.
--   * Durations are stored in seconds (REAL) with a _s suffix, or minutes
--     (REAL, _min) where that is the natural reporting unit.
--   * Booleans are INTEGER 0/1.
--   * JSON blobs are TEXT holding a JSON object, never a bare scalar.
--
-- Migrations live in babymon/storage/migrations.py. This file is the initial
-- (v1) schema and is applied verbatim to a fresh database.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS children (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    -- Birthdate drives the age-appropriate sleep-duration target band.
    -- TEXT 'YYYY-MM-DD', nullable if the user would rather not say.
    birthdate     TEXT,
    room          TEXT,
    -- IANA timezone for this child's room; falls back to the system tz.
    timezone      TEXT,
    -- Local hour (0-23) that separates one "night_of" from the next.
    -- Default 12 means: everything from 12:00 local until 11:59:59 the next
    -- day belongs to the night_of that first date.
    day_boundary_hour INTEGER NOT NULL DEFAULT 12,
    -- Expected bedtime/wake, local 'HH:MM'. Used to bound session detection
    -- and to compute schedule-consistency subscores.
    target_bedtime  TEXT,
    target_waketime TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    avatar_color  TEXT,
    created_ms    INTEGER NOT NULL,
    updated_ms    INTEGER NOT NULL
);

-- Reusable factors the user can attach to a night: "dessert before bedtime",
-- "TV before bedtime", "lights off at 19:30", "teething", "daycare", ...
CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,      -- 'dessert-before-bed'
    label       TEXT NOT NULL,             -- 'Dessert before bedtime'
    -- food | screen | activity | environment | routine | health | care | other
    category    TEXT NOT NULL DEFAULT 'other',
    -- bool | number | time | duration | text
    -- 'bool'     -> presence of the tag on a night is the signal
    -- 'number'   -> value_num is the signal (e.g. screen minutes)
    -- 'time'     -> value_min_local is minutes-after-local-midnight
    --               (may exceed 1440 or go negative for times either side of it)
    -- 'duration' -> value_num in minutes
    -- 'text'     -> not analysable, display only
    value_type  TEXT NOT NULL DEFAULT 'bool',
    unit        TEXT,
    color       TEXT,
    icon        TEXT,
    -- Hint for the analytics layer: 1 if the user expects this to hurt sleep.
    -- Purely cosmetic (used to order the UI); never used in the statistics.
    expected_direction TEXT,               -- 'worse' | 'better' | NULL
    builtin     INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_archived ON tags(archived, category);

-- ---------------------------------------------------------------------------
-- Notes: the human annotation layer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id    INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of    TEXT    NOT NULL,
    -- When the thing being noted actually happened. NULL for a note that is
    -- about the night as a whole rather than a moment in it.
    ts_ms       INTEGER,
    body        TEXT NOT NULL DEFAULT '',
    -- dashboard | homekit | api | import | auto
    source      TEXT NOT NULL DEFAULT 'dashboard',
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL,
    deleted_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_night  ON notes(child_id, night_of, deleted_ms);
CREATE INDEX IF NOT EXISTS idx_notes_ts     ON notes(ts_ms);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    -- Populated according to tags.value_type; all NULL for a plain bool tag.
    value_num       REAL,      -- number / duration
    value_min_local REAL,      -- time-of-day as minutes after local midnight
    value_text      TEXT,      -- text
    PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Telemetry: the continuous, downsampled signal record
-- ---------------------------------------------------------------------------

-- One row per sample interval (default 15 s). This is what the night timeline
-- chart is drawn from, and what the sleep state machine's decisions are
-- reconstructed from after the fact.
CREATE TABLE IF NOT EXISTS samples (
    ts_ms            INTEGER NOT NULL,
    child_id         INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of         TEXT    NOT NULL,
    -- Audio, all dBFS (0 = full scale, so these are negative numbers).
    sound_dbfs       REAL,   -- mean level over the interval
    sound_peak_dbfs  REAL,   -- peak level over the interval
    noise_floor_dbfs REAL,   -- adaptive room floor the detector was using
    -- Highest cry-family classifier score observed in the interval, 0..1.
    cry_score        REAL,
    -- Motion, 0..1, fraction-of-frame-changed style score.
    motion           REAL,
    -- Environment.
    temp_c           REAL,
    humidity_pct     REAL,
    lux              REAL,
    -- The sleep state the machine believed it was in at this instant.
    state            TEXT,
    PRIMARY KEY (child_id, ts_ms)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_samples_night ON samples(child_id, night_of, ts_ms);

-- ---------------------------------------------------------------------------
-- Events: discrete things worth a line in the log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id     INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of     TEXT    NOT NULL,
    start_ms     INTEGER NOT NULL,
    end_ms       INTEGER,                -- NULL while the event is still open
    -- audio | motion | sleep | environment | system | manual
    kind         TEXT NOT NULL,
    -- Fine-grained label. Stable vocabulary, see babymon.models.EventLabel:
    --   audio:  cry, fuss, whimper, scream, talk, cough, sneeze, snore,
    --           laugh, door, noise, unknown
    --   motion: motion, restless, still
    --   sleep:  bedtime, sleep_onset, awakening, back_to_sleep, final_wake,
    --           out_of_bed, returned_to_bed
    --   environment: temp_high, temp_low, humidity_high, humidity_low
    --   system: started, stopped, camera_error, mic_error, hksv_recording
    label        TEXT NOT NULL,
    -- 0..1. For classifier-derived events this is the smoothed model score.
    confidence   REAL,
    -- info | notice | alert  -- drives notification behaviour, not statistics.
    severity     TEXT NOT NULL DEFAULT 'info',
    peak_dbfs    REAL,
    mean_dbfs    REAL,
    motion_peak  REAL,
    -- detector | manual | homekit | api | import
    source       TEXT NOT NULL DEFAULT 'detector',
    -- User feedback loop: NULL = untouched, otherwise the label the user says
    -- it should have been ('' means "this was not a real event").
    corrected_label TEXT,
    acknowledged_ms INTEGER,
    meta         TEXT,   -- JSON object, detector-specific extras
    created_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_night  ON events(child_id, night_of, start_ms);
CREATE INDEX IF NOT EXISTS idx_events_start  ON events(start_ms);
CREATE INDEX IF NOT EXISTS idx_events_kind   ON events(kind, label, start_ms);
CREATE INDEX IF NOT EXISTS idx_events_open   ON events(child_id, end_ms) WHERE end_ms IS NULL;

-- Snapshots and short clips captured around an event.
CREATE TABLE IF NOT EXISTS media (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER REFERENCES events(id) ON DELETE CASCADE,
    child_id    INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of    TEXT    NOT NULL,
    -- snapshot | audio_clip | video_clip
    kind        TEXT NOT NULL,
    -- Path relative to config.paths.media_dir. Never an absolute path, so the
    -- data directory stays relocatable.
    rel_path    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INTEGER,
    duration_s  REAL,
    ts_ms       INTEGER NOT NULL,
    -- Retention: the pruner deletes rows (and files) past this instant.
    expires_ms  INTEGER,
    created_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_event   ON media(event_id);
CREATE INDEX IF NOT EXISTS idx_media_expires ON media(expires_ms);

-- ---------------------------------------------------------------------------
-- Sleep structure
-- ---------------------------------------------------------------------------

-- The hypnogram. Contiguous, non-overlapping segments per child.
CREATE TABLE IF NOT EXISTS sleep_segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id   INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of   TEXT    NOT NULL,
    start_ms   INTEGER NOT NULL,
    end_ms     INTEGER NOT NULL,
    -- absent | awake | settling | restless | asleep | unknown
    state      TEXT NOT NULL,
    confidence REAL,
    -- detector | manual  -- a manual segment always wins over a detected one.
    source     TEXT NOT NULL DEFAULT 'detector',
    created_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_night ON sleep_segments(child_id, night_of, start_ms);

-- One row per child per night: the rollup the analytics layer consumes.
-- Fully derived from samples/events/sleep_segments; safe to delete and rebuild.
CREATE TABLE IF NOT EXISTS nights (
    child_id        INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    night_of        TEXT    NOT NULL,
    timezone        TEXT    NOT NULL,

    -- Anchors
    bedtime_ms      INTEGER,   -- in bed / lights out
    sleep_onset_ms  INTEGER,   -- first sustained asleep segment
    final_wake_ms   INTEGER,   -- last transition out of asleep that stuck
    out_of_bed_ms   INTEGER,   -- got up for the day

    -- Core metrics (see docs/ANALYTICS.md for the exact definitions)
    tib_min         REAL,      -- time in bed
    tst_min         REAL,      -- total sleep time
    sol_min         REAL,      -- sleep onset latency
    waso_min        REAL,      -- wake after sleep onset
    awakenings      INTEGER,   -- count of awakenings >= config threshold
    longest_bout_min REAL,
    sleep_efficiency REAL,     -- TST / TIB, 0..1
    midpoint_ms     INTEGER,   -- midpoint of the sleep period
    restless_min    REAL,

    -- Noise / activity summary
    cry_events      INTEGER NOT NULL DEFAULT 0,
    cry_min         REAL,
    noise_events    INTEGER NOT NULL DEFAULT 0,
    peak_dbfs       REAL,
    mean_dbfs       REAL,
    motion_index    REAL,      -- mean motion during the sleep period

    -- Environment summary
    temp_c_mean     REAL,
    temp_c_min      REAL,
    temp_c_max      REAL,
    humidity_mean   REAL,

    -- Scoring
    quality_score   REAL,      -- 0..100
    score_components TEXT,     -- JSON: per-component subscores + weights
    -- 0..1 fraction of the night the sensors were actually reporting. Low
    -- coverage nights are excluded from analytics by default.
    coverage        REAL,
    -- in_progress | complete | partial | excluded
    status          TEXT NOT NULL DEFAULT 'in_progress',
    -- Set by the user to keep a night out of the statistics (illness, travel).
    excluded        INTEGER NOT NULL DEFAULT 0,
    exclude_reason  TEXT,

    age_days        INTEGER,   -- child's age that night, for the norm band
    computed_ms     INTEGER,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (child_id, night_of)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nights_status ON nights(child_id, status, night_of);

-- ---------------------------------------------------------------------------
-- Misc
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,   -- JSON-encoded
    updated_ms INTEGER NOT NULL
);

-- Append-only operational log, surfaced on the dashboard's System page.
CREATE TABLE IF NOT EXISTS system_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms      INTEGER NOT NULL,
    level      TEXT NOT NULL,   -- debug | info | warning | error
    component  TEXT NOT NULL,
    message    TEXT NOT NULL,
    meta       TEXT
);

CREATE INDEX IF NOT EXISTS idx_syslog_ts ON system_log(ts_ms);
