"""Domain types shared by the storage, sensing, analysis and API layers.

These are plain dataclasses rather than Pydantic models on purpose: they are
created tens of times a second by the sensing loop, and they must be importable
by code that runs before (or entirely without) the web server. The API layer
defines its own Pydantic schemas and converts at the boundary.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

__all__ = [
    "CRY_LABELS",
    "WAKE_LABELS",
    "Child",
    "Event",
    "EventKind",
    "EventLabel",
    "LiveState",
    "Media",
    "MediaKind",
    "Night",
    "NightStatus",
    "Note",
    "NoteTag",
    "Sample",
    "Severity",
    "SleepSegment",
    "SleepState",
    "Tag",
    "TagCategory",
    "TagValueType",
]


class SleepState(StrEnum):
    """What the state machine believes is happening in the room.

    Ordered loosely from "not here" to "deeply asleep"; ``ABSENT`` and
    ``UNKNOWN`` are both excluded from time-in-bed.
    """

    UNKNOWN = "unknown"
    ABSENT = "absent"        # nobody in the room
    AWAKE = "awake"          # in the room, clearly active
    SETTLING = "settling"    # in bed, still winding down (pre sleep onset)
    RESTLESS = "restless"    # asleep but moving/vocalising
    ASLEEP = "asleep"

    @property
    def counts_as_sleep(self) -> bool:
        return self in (SleepState.ASLEEP, SleepState.RESTLESS)

    @property
    def counts_as_in_bed(self) -> bool:
        return self in (
            SleepState.ASLEEP,
            SleepState.RESTLESS,
            SleepState.SETTLING,
            SleepState.AWAKE,
        )


class EventKind(StrEnum):
    AUDIO = "audio"
    MOTION = "motion"
    SLEEP = "sleep"
    ENVIRONMENT = "environment"
    SYSTEM = "system"
    MANUAL = "manual"


class EventLabel(StrEnum):
    """The stable event vocabulary. Persisted, so do not rename members."""

    # audio
    CRY = "cry"
    FUSS = "fuss"
    WHIMPER = "whimper"
    SCREAM = "scream"
    TALK = "talk"
    COUGH = "cough"
    SNEEZE = "sneeze"
    SNORE = "snore"
    LAUGH = "laugh"
    DOOR = "door"
    NOISE = "noise"
    UNKNOWN = "unknown"
    # motion
    MOTION = "motion"
    RESTLESS = "restless"
    # sleep structure
    BEDTIME = "bedtime"
    SLEEP_ONSET = "sleep_onset"
    AWAKENING = "awakening"
    BACK_TO_SLEEP = "back_to_sleep"
    FINAL_WAKE = "final_wake"
    OUT_OF_BED = "out_of_bed"
    RETURNED_TO_BED = "returned_to_bed"
    # environment
    TEMP_HIGH = "temp_high"
    TEMP_LOW = "temp_low"
    HUMIDITY_HIGH = "humidity_high"
    HUMIDITY_LOW = "humidity_low"
    # system
    STARTED = "started"
    STOPPED = "stopped"
    CAMERA_ERROR = "camera_error"
    MIC_ERROR = "mic_error"
    SENSOR_ERROR = "sensor_error"
    HKSV_RECORDING = "hksv_recording"
    # manual
    CHECKED_IN = "checked_in"
    FED = "fed"
    DIAPER = "diaper"
    MEDICINE = "medicine"
    NOTE = "note"


#: Sounds that suggest the child may be waking. Drives the awakening logic,
#: the HomeKit sound sensor and notifications. Overridable in config.
WAKE_LABELS: frozenset[str] = frozenset(
    {EventLabel.CRY, EventLabel.FUSS, EventLabel.WHIMPER, EventLabel.SCREAM, EventLabel.TALK}
)

#: The distress subset, used for the "crying" tallies on the night rollup.
CRY_LABELS: frozenset[str] = frozenset(
    {EventLabel.CRY, EventLabel.SCREAM, EventLabel.WHIMPER, EventLabel.FUSS}
)


class Severity(StrEnum):
    INFO = "info"
    NOTICE = "notice"
    ALERT = "alert"

    @property
    def rank(self) -> int:
        return {"info": 0, "notice": 1, "alert": 2}[self.value]

    def at_least(self, other: Severity | str) -> bool:
        other = Severity(other)
        return self.rank >= other.rank


class MediaKind(StrEnum):
    SNAPSHOT = "snapshot"
    AUDIO_CLIP = "audio_clip"
    VIDEO_CLIP = "video_clip"


class TagCategory(StrEnum):
    FOOD = "food"
    SCREEN = "screen"
    ACTIVITY = "activity"
    ENVIRONMENT = "environment"
    ROUTINE = "routine"
    HEALTH = "health"
    CARE = "care"
    OTHER = "other"


class TagValueType(StrEnum):
    BOOL = "bool"
    NUMBER = "number"
    TIME = "time"
    DURATION = "duration"
    TEXT = "text"

    @property
    def is_analysable(self) -> bool:
        """Whether the factor analysis can do anything with this tag."""
        return self is not TagValueType.TEXT

    @property
    def is_continuous(self) -> bool:
        return self in (TagValueType.NUMBER, TagValueType.TIME, TagValueType.DURATION)


class NightStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"
    PARTIAL = "partial"      # too little sensor coverage to trust
    EXCLUDED = "excluded"    # user asked for it to be left out


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Child:
    id: int
    name: str
    birthdate: str | None = None
    room: str | None = None
    timezone: str | None = None
    day_boundary_hour: int = 12
    target_bedtime: str | None = None
    target_waketime: str | None = None
    active: bool = True
    avatar_color: str | None = None
    created_ms: int = 0
    updated_ms: int = 0

    def age_days(self, at_ms: int) -> int | None:
        """Age in days at a given instant, or None if no birthdate is set."""
        if not self.birthdate:
            return None
        from .timeutil import from_ms, parse_date

        try:
            born = parse_date(self.birthdate)
        except ValueError:
            return None
        return (from_ms(at_ms, self.timezone).date() - born).days


@dataclass(slots=True)
class Tag:
    id: int
    slug: str
    label: str
    category: TagCategory = TagCategory.OTHER
    value_type: TagValueType = TagValueType.BOOL
    unit: str | None = None
    color: str | None = None
    icon: str | None = None
    expected_direction: str | None = None
    builtin: bool = False
    archived: bool = False
    created_ms: int = 0


@dataclass(slots=True)
class NoteTag:
    """A tag applied to a note, with the value appropriate to its type."""

    slug: str
    label: str = ""
    category: TagCategory = TagCategory.OTHER
    value_type: TagValueType = TagValueType.BOOL
    value_num: float | None = None
    value_min_local: float | None = None
    value_text: str | None = None

    @property
    def analysis_value(self) -> float | None:
        """The number the factor analysis should use, or None if not applicable.

        A bool tag's presence is the signal, so it contributes 1.0.
        """
        match self.value_type:
            case TagValueType.BOOL:
                return 1.0
            case TagValueType.NUMBER | TagValueType.DURATION:
                return self.value_num
            case TagValueType.TIME:
                return self.value_min_local
            case _:
                return None

    @property
    def display_value(self) -> str | None:
        from .timeutil import format_hhmm

        match self.value_type:
            case TagValueType.TIME:
                if self.value_min_local is None:
                    return None
                return format_hhmm(self.value_min_local)
            case TagValueType.DURATION:
                return f"{self.value_num:g} min" if self.value_num is not None else None
            case TagValueType.NUMBER:
                return f"{self.value_num:g}" if self.value_num is not None else None
            case TagValueType.TEXT:
                return self.value_text
            case _:
                return None


@dataclass(slots=True)
class Note:
    id: int
    child_id: int
    night_of: str
    body: str = ""
    ts_ms: int | None = None
    source: str = "dashboard"
    tags: list[NoteTag] = field(default_factory=list)
    created_ms: int = 0
    updated_ms: int = 0
    deleted_ms: int | None = None

    def has_tag(self, slug: str) -> bool:
        return any(t.slug == slug for t in self.tags)


@dataclass(slots=True)
class Sample:
    """One telemetry tick. Written every ``sleep.sample_interval_s`` seconds."""

    ts_ms: int
    child_id: int
    night_of: str
    sound_dbfs: float | None = None
    sound_peak_dbfs: float | None = None
    noise_floor_dbfs: float | None = None
    cry_score: float | None = None
    motion: float | None = None
    temp_c: float | None = None
    humidity_pct: float | None = None
    lux: float | None = None
    state: SleepState = SleepState.UNKNOWN


@dataclass(slots=True)
class Event:
    id: int
    child_id: int
    night_of: str
    start_ms: int
    kind: EventKind
    label: EventLabel | str
    end_ms: int | None = None
    confidence: float | None = None
    severity: Severity = Severity.INFO
    peak_dbfs: float | None = None
    mean_dbfs: float | None = None
    motion_peak: float | None = None
    source: str = "detector"
    corrected_label: str | None = None
    acknowledged_ms: int | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    created_ms: int = 0
    media: list[Media] = field(default_factory=list)

    @property
    def is_open(self) -> bool:
        return self.end_ms is None

    @property
    def duration_s(self) -> float | None:
        return None if self.end_ms is None else (self.end_ms - self.start_ms) / 1000.0

    @property
    def effective_label(self) -> str:
        """The label after any user correction. Empty means "not a real event"."""
        return self.label if self.corrected_label is None else self.corrected_label

    @property
    def is_false_positive(self) -> bool:
        return self.corrected_label == ""


@dataclass(slots=True)
class Media:
    id: int
    child_id: int
    night_of: str
    kind: MediaKind
    rel_path: str
    mime: str
    ts_ms: int
    event_id: int | None = None
    bytes: int | None = None
    duration_s: float | None = None
    expires_ms: int | None = None
    created_ms: int = 0


@dataclass(slots=True)
class SleepSegment:
    id: int
    child_id: int
    night_of: str
    start_ms: int
    end_ms: int
    state: SleepState
    confidence: float | None = None
    source: str = "detector"
    created_ms: int = 0

    @property
    def duration_min(self) -> float:
        return (self.end_ms - self.start_ms) / 60000.0


@dataclass(slots=True)
class Night:
    """The per-night rollup. Entirely derived; safe to delete and rebuild."""

    child_id: int
    night_of: str
    timezone: str

    bedtime_ms: int | None = None
    sleep_onset_ms: int | None = None
    final_wake_ms: int | None = None
    out_of_bed_ms: int | None = None

    tib_min: float | None = None
    tst_min: float | None = None
    sol_min: float | None = None
    waso_min: float | None = None
    awakenings: int | None = None
    longest_bout_min: float | None = None
    sleep_efficiency: float | None = None
    midpoint_ms: int | None = None
    restless_min: float | None = None

    cry_events: int = 0
    cry_min: float | None = None
    noise_events: int = 0
    peak_dbfs: float | None = None
    mean_dbfs: float | None = None
    motion_index: float | None = None

    temp_c_mean: float | None = None
    temp_c_min: float | None = None
    temp_c_max: float | None = None
    humidity_mean: float | None = None

    quality_score: float | None = None
    score_components: dict[str, Any] = field(default_factory=dict)
    coverage: float | None = None
    status: NightStatus = NightStatus.IN_PROGRESS
    excluded: bool = False
    exclude_reason: str | None = None

    age_days: int | None = None
    computed_ms: int | None = None
    schema_version: int = 1

    @property
    def analysable(self) -> bool:
        """Whether this night may enter the statistics."""
        return (
            not self.excluded
            and self.status is NightStatus.COMPLETE
            and self.quality_score is not None
        )

    def metric(self, name: str) -> float | None:
        """Look up an outcome metric by name, for the factor analysis."""
        value = getattr(self, name, None)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)


@dataclass(slots=True)
class LiveState:
    """The current-state snapshot served at ``/api/state`` and over SSE."""

    ts_ms: int
    child_id: int
    night_of: str
    state: SleepState = SleepState.UNKNOWN
    state_since_ms: int | None = None
    sound_dbfs: float | None = None
    noise_floor_dbfs: float | None = None
    cry_score: float | None = None
    motion: float | None = None
    temp_c: float | None = None
    humidity_pct: float | None = None
    camera_online: bool = False
    audio_online: bool = False
    env_online: bool = False
    night_so_far: dict[str, Any] = field(default_factory=dict)

    @property
    def sound_above_floor_db(self) -> float | None:
        if self.sound_dbfs is None or self.noise_floor_dbfs is None:
            return None
        return self.sound_dbfs - self.noise_floor_dbfs

    @property
    def asleep_for_min(self) -> float | None:
        if not self.state.counts_as_sleep or self.state_since_ms is None:
            return None
        return (self.ts_ms - self.state_since_ms) / 60000.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["state"] = str(self.state)
        d["sound_above_floor_db"] = self.sound_above_floor_db
        d["asleep_for_min"] = self.asleep_for_min
        return d


def json_dumps(value: Any) -> str:
    """Compact, deterministic JSON for the TEXT columns that hold objects."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True, default=str)


def json_loads(raw: str | None) -> dict[str, Any]:
    """Tolerant reader for those columns; never raises on bad data."""
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}
