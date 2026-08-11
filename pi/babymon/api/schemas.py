"""Pydantic models for the HTTP boundary, and nothing else.

:mod:`babymon.models` holds the domain dataclasses. They are created tens of
times a second by the sensing loop and must be importable without a web server,
so they are not Pydantic models and are not going to become them. What lives
here is the *wire* shape: request bodies that need validating because they come
from outside, and response bodies that need the extra fields the contract in
``docs/API.md`` promises — the ``*_iso`` renderings, the derived
``duration_s``/``sound_above_floor_db``, the tag ``value_display``.

Every response model therefore has a ``from_model`` classmethod that converts
one way, and every request model has a plain ``dict``-producing accessor that
the repositories consume. Conversion happens exactly once, at the edge.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..models import (
    Child,
    Event,
    Media,
    Night,
    Note,
    NoteTag,
    SleepSegment,
    TagCategory,
    TagValueType,
)
from ..models import Tag as TagModel
from ..timeutil import iso

__all__ = [
    "ChildCreate",
    "ChildOut",
    "ChildUpdate",
    "EventCreate",
    "EventOut",
    "EventUpdate",
    "HomeKitRecordingRequest",
    "HomeKitTagRequest",
    "LiveStateOut",
    "MediaOut",
    "NightOut",
    "NightUpdate",
    "NoteCreate",
    "NoteOut",
    "NoteTagIn",
    "NoteTagOut",
    "NoteUpdate",
    "Page",
    "RecomputeRequest",
    "SegmentOut",
    "TagCreate",
    "TagOut",
    "TagUpdate",
]


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ---------------------------------------------------------------------------
# Children
# ---------------------------------------------------------------------------


class ChildOut(BaseModel):
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
    age_days: int | None = None
    created_ms: int = 0
    updated_ms: int = 0

    @classmethod
    def from_model(cls, child: Child, *, now_ms: int | None = None) -> ChildOut:
        return cls(
            id=child.id,
            name=child.name,
            birthdate=child.birthdate,
            room=child.room,
            timezone=child.timezone,
            day_boundary_hour=child.day_boundary_hour,
            target_bedtime=child.target_bedtime,
            target_waketime=child.target_waketime,
            active=child.active,
            avatar_color=child.avatar_color,
            age_days=child.age_days(now_ms) if now_ms is not None else None,
            created_ms=child.created_ms,
            updated_ms=child.updated_ms,
        )


class ChildCreate(_Base):
    name: str = Field(min_length=1, max_length=64)
    birthdate: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    room: str | None = Field(default=None, max_length=64)
    timezone: str | None = None
    day_boundary_hour: int = Field(default=12, ge=0, le=23)
    target_bedtime: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    target_waketime: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    avatar_color: str | None = Field(default=None, max_length=32)


class ChildUpdate(_Base):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    birthdate: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    room: str | None = Field(default=None, max_length=64)
    timezone: str | None = None
    day_boundary_hour: int | None = Field(default=None, ge=0, le=23)
    target_bedtime: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    target_waketime: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    active: bool | None = None
    avatar_color: str | None = Field(default=None, max_length=32)


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]*$"


class TagOut(BaseModel):
    id: int
    slug: str
    label: str
    category: str
    value_type: str
    unit: str | None = None
    color: str | None = None
    icon: str | None = None
    expected_direction: str | None = None
    builtin: bool = False
    archived: bool = False
    created_ms: int = 0
    #: Only present on ``?with_stats=true``.
    nights_applied: int | None = None
    first_ms: int | None = None
    last_ms: int | None = None

    @classmethod
    def from_model(cls, tag: TagModel, stats: dict[str, Any] | None = None) -> TagOut:
        stats = stats or {}
        return cls(
            id=tag.id,
            slug=tag.slug,
            label=tag.label,
            category=str(tag.category),
            value_type=str(tag.value_type),
            unit=tag.unit,
            color=tag.color,
            icon=tag.icon,
            expected_direction=tag.expected_direction,
            builtin=tag.builtin,
            archived=tag.archived,
            created_ms=tag.created_ms,
            nights_applied=stats.get("nights_applied"),
            first_ms=stats.get("first_ms"),
            last_ms=stats.get("last_ms"),
        )


class TagCreate(_Base):
    slug: str | None = Field(default=None, pattern=SLUG_PATTERN, max_length=64)
    label: str = Field(min_length=1, max_length=96)
    category: TagCategory = TagCategory.OTHER
    value_type: TagValueType = TagValueType.BOOL
    unit: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=32)
    icon: str | None = Field(default=None, max_length=32)
    expected_direction: Literal["worse", "better"] | None = None


class TagUpdate(_Base):
    label: str | None = Field(default=None, min_length=1, max_length=96)
    category: TagCategory | None = None
    value_type: TagValueType | None = None
    unit: str | None = Field(default=None, max_length=16)
    color: str | None = Field(default=None, max_length=32)
    icon: str | None = Field(default=None, max_length=32)
    expected_direction: Literal["worse", "better"] | None = None
    archived: bool | None = None


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------


class NoteTagIn(_Base):
    """A tag applied to a note.

    Only ``slug`` is required. The other fields exist so a client that is
    creating a tag on the fly — the HomeKit bridge, a Shortcut — can say what
    kind of tag it is in the same request instead of needing a setup step.
    """

    slug: str = Field(pattern=SLUG_PATTERN, max_length=64)
    label: str | None = Field(default=None, max_length=96)
    category: TagCategory | None = None
    value_type: TagValueType | None = None
    value_num: float | None = None
    value_min_local: float | None = None
    value_text: str | None = Field(default=None, max_length=512)

    def to_spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {"slug": self.slug}
        for key in ("label", "category", "value_type", "value_num", "value_min_local",
                    "value_text"):
            value = getattr(self, key)
            if value is not None:
                spec[key] = str(value) if key in ("category", "value_type") else value
        return spec


class NoteTagOut(BaseModel):
    slug: str
    label: str
    category: str
    value_type: str
    value_num: float | None = None
    value_min_local: float | None = None
    value_text: str | None = None
    value_display: str | None = None

    @classmethod
    def from_model(cls, tag: NoteTag) -> NoteTagOut:
        return cls(
            slug=tag.slug,
            label=tag.label,
            category=str(tag.category),
            value_type=str(tag.value_type),
            value_num=tag.value_num,
            value_min_local=tag.value_min_local,
            value_text=tag.value_text,
            value_display=tag.display_value,
        )


class NoteOut(BaseModel):
    id: int
    child_id: int
    night_of: str
    ts_ms: int | None = None
    ts_iso: str | None = None
    body: str = ""
    source: str = "dashboard"
    tags: list[NoteTagOut] = Field(default_factory=list)
    created_ms: int = 0
    updated_ms: int = 0
    deleted_ms: int | None = None

    @classmethod
    def from_model(cls, note: Note, tz: str | None = None) -> NoteOut:
        return cls(
            id=note.id,
            child_id=note.child_id,
            night_of=note.night_of,
            ts_ms=note.ts_ms,
            ts_iso=iso(note.ts_ms, tz),
            body=note.body,
            source=note.source,
            tags=[NoteTagOut.from_model(t) for t in note.tags],
            created_ms=note.created_ms,
            updated_ms=note.updated_ms,
            deleted_ms=note.deleted_ms,
        )


class NoteCreate(_Base):
    child_id: int | None = None
    night_of: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    ts_ms: int | None = None
    body: str = Field(default="", max_length=4000)
    source: str = Field(default="dashboard", max_length=32)
    tags: list[NoteTagIn] = Field(default_factory=list)

    @field_validator("tags")
    @classmethod
    def _unique_slugs(cls, tags: list[NoteTagIn]) -> list[NoteTagIn]:
        seen: set[str] = set()
        for tag in tags:
            if tag.slug in seen:
                raise ValueError(f"tag {tag.slug!r} appears more than once")
            seen.add(tag.slug)
        return tags


class NoteUpdate(_Base):
    night_of: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    ts_ms: int | None = None
    body: str | None = Field(default=None, max_length=4000)
    #: Present means "replace the whole set"; absent means "leave the tags be".
    tags: list[NoteTagIn] | None = None


# ---------------------------------------------------------------------------
# Events and media
# ---------------------------------------------------------------------------


class MediaOut(BaseModel):
    id: int
    child_id: int
    night_of: str
    kind: str
    mime: str
    ts_ms: int
    ts_iso: str | None = None
    event_id: int | None = None
    bytes: int | None = None
    duration_s: float | None = None
    expires_ms: int | None = None
    url: str = ""

    @classmethod
    def from_model(cls, media: Media, tz: str | None = None) -> MediaOut:
        # rel_path is deliberately not exposed: it is a filesystem detail, and
        # a client that knows it is a client that will try to construct paths.
        return cls(
            id=media.id,
            child_id=media.child_id,
            night_of=media.night_of,
            kind=str(media.kind),
            mime=media.mime,
            ts_ms=media.ts_ms,
            ts_iso=iso(media.ts_ms, tz),
            event_id=media.event_id,
            bytes=media.bytes,
            duration_s=media.duration_s,
            expires_ms=media.expires_ms,
            url=f"/api/media/{media.id}",
        )


class EventOut(BaseModel):
    id: int
    child_id: int
    night_of: str
    start_ms: int
    start_iso: str | None = None
    end_ms: int | None = None
    duration_s: float | None = None
    kind: str
    label: str
    effective_label: str = ""
    confidence: float | None = None
    severity: str = "info"
    peak_dbfs: float | None = None
    mean_dbfs: float | None = None
    motion_peak: float | None = None
    source: str = "detector"
    corrected_label: str | None = None
    acknowledged_ms: int | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    media: list[MediaOut] = Field(default_factory=list)
    created_ms: int = 0

    @classmethod
    def from_model(cls, event: Event, tz: str | None = None) -> EventOut:
        return cls(
            id=event.id,
            child_id=event.child_id,
            night_of=event.night_of,
            start_ms=event.start_ms,
            start_iso=iso(event.start_ms, tz),
            end_ms=event.end_ms,
            duration_s=event.duration_s,
            kind=str(event.kind),
            label=str(event.label),
            effective_label=event.effective_label,
            confidence=event.confidence,
            severity=str(event.severity),
            peak_dbfs=event.peak_dbfs,
            mean_dbfs=event.mean_dbfs,
            motion_peak=event.motion_peak,
            source=event.source,
            corrected_label=event.corrected_label,
            acknowledged_ms=event.acknowledged_ms,
            meta=event.meta,
            media=[MediaOut.from_model(m, tz) for m in event.media],
            created_ms=event.created_ms,
        )


class EventCreate(_Base):
    child_id: int | None = None
    start_ms: int
    end_ms: int | None = None
    kind: str = Field(default="manual", max_length=32)
    label: str = Field(min_length=1, max_length=48)
    severity: Literal["info", "notice", "alert"] = "info"
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    meta: dict[str, Any] = Field(default_factory=dict)


class EventUpdate(_Base):
    #: An empty string is meaningful here — it marks a false positive — so this
    #: field distinguishes "sent as empty" from "not sent" via ``exclude_unset``.
    corrected_label: str | None = Field(default=None, max_length=48)
    acknowledged: bool | None = None
    severity: Literal["info", "notice", "alert"] | None = None


# ---------------------------------------------------------------------------
# Sleep
# ---------------------------------------------------------------------------


class SegmentOut(BaseModel):
    id: int
    start_ms: int
    end_ms: int
    duration_min: float
    state: str
    confidence: float | None = None
    source: str = "detector"

    @classmethod
    def from_model(cls, segment: SleepSegment) -> SegmentOut:
        return cls(
            id=segment.id,
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
            duration_min=segment.duration_min,
            state=str(segment.state),
            confidence=segment.confidence,
            source=segment.source,
        )


class NightOut(BaseModel):
    child_id: int
    night_of: str
    timezone: str
    bedtime_ms: int | None = None
    bedtime_iso: str | None = None
    sleep_onset_ms: int | None = None
    final_wake_ms: int | None = None
    final_wake_iso: str | None = None
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
    score_components: dict[str, Any] = Field(default_factory=dict)
    coverage: float | None = None
    status: str = "in_progress"
    excluded: bool = False
    exclude_reason: str | None = None
    analysable: bool = False
    age_days: int | None = None
    computed_ms: int | None = None

    @classmethod
    def from_model(cls, night: Night) -> NightOut:
        tz = night.timezone
        return cls(
            child_id=night.child_id,
            night_of=night.night_of,
            timezone=tz,
            bedtime_ms=night.bedtime_ms,
            bedtime_iso=iso(night.bedtime_ms, tz),
            sleep_onset_ms=night.sleep_onset_ms,
            final_wake_ms=night.final_wake_ms,
            final_wake_iso=iso(night.final_wake_ms, tz),
            out_of_bed_ms=night.out_of_bed_ms,
            tib_min=night.tib_min,
            tst_min=night.tst_min,
            sol_min=night.sol_min,
            waso_min=night.waso_min,
            awakenings=night.awakenings,
            longest_bout_min=night.longest_bout_min,
            sleep_efficiency=night.sleep_efficiency,
            midpoint_ms=night.midpoint_ms,
            restless_min=night.restless_min,
            cry_events=night.cry_events,
            cry_min=night.cry_min,
            noise_events=night.noise_events,
            peak_dbfs=night.peak_dbfs,
            mean_dbfs=night.mean_dbfs,
            motion_index=night.motion_index,
            temp_c_mean=night.temp_c_mean,
            temp_c_min=night.temp_c_min,
            temp_c_max=night.temp_c_max,
            humidity_mean=night.humidity_mean,
            quality_score=night.quality_score,
            score_components=night.score_components,
            coverage=night.coverage,
            status=str(night.status),
            excluded=night.excluded,
            exclude_reason=night.exclude_reason,
            analysable=night.analysable,
            age_days=night.age_days,
            computed_ms=night.computed_ms,
        )


class NightUpdate(_Base):
    excluded: bool | None = None
    exclude_reason: str | None = Field(default=None, max_length=256)
    bedtime_ms: int | None = None
    sleep_onset_ms: int | None = None
    final_wake_ms: int | None = None
    out_of_bed_ms: int | None = None


class LiveStateOut(BaseModel):
    """The ``/api/state`` body. Also the payload of the SSE ``state`` event."""

    ts_ms: int
    ts_iso: str | None = None
    child_id: int
    night_of: str
    state: str = "unknown"
    state_since_ms: int | None = None
    asleep_for_min: float | None = None
    sound_dbfs: float | None = None
    noise_floor_dbfs: float | None = None
    sound_above_floor_db: float | None = None
    cry_score: float | None = None
    motion: float | None = None
    temp_c: float | None = None
    humidity_pct: float | None = None
    camera_online: bool = False
    audio_online: bool = False
    env_online: bool = False
    night_so_far: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# HomeKit and system
# ---------------------------------------------------------------------------


class HomeKitTagRequest(_Base):
    slug: str = Field(pattern=SLUG_PATTERN, max_length=64)
    on: bool
    child_id: int | None = None
    label: str | None = Field(default=None, max_length=96)
    night_of: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class HomeKitRecordingRequest(_Base):
    state: Literal["started", "stopped"]
    reason: str = Field(default="motion", max_length=32)
    stream_id: int | None = None
    child_id: int | None = None


class RecomputeRequest(_Base):
    from_: Annotated[str | None, Field(alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None
    to: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    child_id: int | None = None


class Page(BaseModel):
    """The list envelope every collection endpoint returns."""

    items: list[Any]
    total: int
    limit: int
    offset: int
