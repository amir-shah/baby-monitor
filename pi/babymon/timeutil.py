"""Time handling for an application whose fundamental unit is "a night".

A night is a local-calendar concept that straddles midnight, and on the two
days a year that a timezone changes offset it is 23 or 25 hours long. Storing
local timestamps, or deriving nights by subtracting a fixed 12 hours from UTC,
both produce wrong answers twice a year and stay wrong for months of analytics
afterwards. So:

* Every instant is stored as an integer of Unix epoch **milliseconds**, UTC.
* Every instant is *additionally* assigned a ``night_of`` key: the local
  calendar date, ``YYYY-MM-DD``, on which its night began.

The assignment rule uses a configurable ``day_boundary_hour`` (default 12,
local): an instant whose local time is at or after the boundary belongs to the
night named after that local date; an instant before the boundary belongs to
the night named after the *previous* local date. With the default, everything
from noon Friday to 11:59:59 Saturday is ``night_of == Friday``.

All the arithmetic here goes through ``zoneinfo``, which knows about DST, so
"the start of the night of 2026-11-01" resolves correctly even though that
local day has 25 hours in US timezones.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

__all__ = [
    "DEFAULT_DAY_BOUNDARY_HOUR",
    "MS",
    "NightKey",
    "format_hhmm",
    "from_ms",
    "get_tz",
    "iso",
    "local_dt",
    "local_window_bounds",
    "minutes_after_local_midnight",
    "night_bounds",
    "night_dates",
    "night_of",
    "now_ms",
    "parse_date",
    "parse_hhmm",
    "to_ms",
]

MS = 1000
DEFAULT_DAY_BOUNDARY_HOUR = 12

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_HHMM_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")

NightKey = str  # 'YYYY-MM-DD'


# ---------------------------------------------------------------------------
# Timezones
# ---------------------------------------------------------------------------


@lru_cache(maxsize=32)
def get_tz(name: str | None) -> dt.tzinfo:
    """Resolve an IANA timezone name, falling back to the system zone.

    Never raises: an unknown zone falls back rather than taking the whole
    service down, because a typo in the config should not stop the camera from
    recording. The caller is expected to have validated the name at startup.
    """
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return system_tz()


def system_tz() -> dt.tzinfo:
    """The host's local timezone, as a real tzinfo with DST rules if possible."""
    # /etc/timezone and /etc/localtime give us a *named* zone, which knows its
    # future DST transitions. astimezone()'s fallback only knows the current
    # offset, which is enough for "now" but wrong for historical nights.
    for path, reader in (
        ("/etc/timezone", _read_timezone_file),
        ("/etc/localtime", _read_localtime_link),
    ):
        name = reader(path)
        if name:
            try:
                return ZoneInfo(name)
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return dt.datetime.now().astimezone().tzinfo or dt.UTC


def _read_timezone_file(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _read_localtime_link(path: str) -> str | None:
    import os

    try:
        target = os.path.realpath(path)
    except OSError:
        return None
    marker = "/zoneinfo/"
    idx = target.find(marker)
    if idx == -1:
        return None
    return target[idx + len(marker) :] or None


# ---------------------------------------------------------------------------
# Instant conversions
# ---------------------------------------------------------------------------


def now_ms() -> int:
    """Current instant, Unix epoch milliseconds UTC."""
    return int(dt.datetime.now(dt.UTC).timestamp() * MS)


def to_ms(value: dt.datetime | dt.date | int | float) -> int:
    """Coerce a datetime/date/epoch value to epoch milliseconds.

    A naive ``datetime`` is rejected rather than guessed at: silently assuming
    UTC or local is exactly the class of bug this module exists to prevent.
    A bare ``date`` is taken to mean UTC midnight, which is only ever used for
    coarse range filtering.
    """
    if isinstance(value, bool):  # bool is an int; never meaningful here
        raise TypeError("bool is not a timestamp")
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            raise ValueError("naive datetime: attach a tzinfo before converting")
        return int(value.timestamp() * MS)
    if isinstance(value, dt.date):
        return int(
            dt.datetime(value.year, value.month, value.day, tzinfo=dt.UTC).timestamp() * MS
        )
    raise TypeError(f"cannot convert {type(value).__name__} to epoch ms")


def from_ms(ms: int, tz: dt.tzinfo | str | None = None) -> dt.datetime:
    """Epoch milliseconds to an aware datetime (UTC unless ``tz`` is given)."""
    zone = get_tz(tz) if isinstance(tz, str) or tz is None else tz
    return dt.datetime.fromtimestamp(ms / MS, tz=dt.UTC).astimezone(zone)


def local_dt(ms: int, tz: dt.tzinfo | str | None) -> dt.datetime:
    """Epoch milliseconds as local wall-clock time in ``tz``."""
    return from_ms(ms, tz)


def iso(ms: int | None, tz: dt.tzinfo | str | None = None) -> str | None:
    """RFC 3339 rendering of an instant, or None passed through."""
    if ms is None:
        return None
    return from_ms(ms, tz).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Nights
# ---------------------------------------------------------------------------


def night_of(
    ms: int,
    tz: dt.tzinfo | str | None = None,
    day_boundary_hour: int = DEFAULT_DAY_BOUNDARY_HOUR,
) -> NightKey:
    """The ``night_of`` key an instant belongs to.

    >>> night_of(to_ms(dt.datetime(2026, 8, 10, 21, 0, tzinfo=ZoneInfo("America/Los_Angeles"))),
    ...          "America/Los_Angeles")
    '2026-08-10'
    >>> night_of(to_ms(dt.datetime(2026, 8, 11, 3, 0, tzinfo=ZoneInfo("America/Los_Angeles"))),
    ...          "America/Los_Angeles")
    '2026-08-10'
    """
    _check_boundary(day_boundary_hour)
    local = from_ms(ms, tz)
    date = local.date()
    if local.hour < day_boundary_hour:
        date -= dt.timedelta(days=1)
    return date.isoformat()


def night_bounds(
    key: NightKey | dt.date,
    tz: dt.tzinfo | str | None = None,
    day_boundary_hour: int = DEFAULT_DAY_BOUNDARY_HOUR,
) -> tuple[int, int]:
    """Half-open ``[start_ms, end_ms)`` covering a night, in UTC milliseconds.

    The span is 24 hours of *local* time, which is 23 or 25 real hours across a
    DST transition. That is the point of computing it this way.
    """
    _check_boundary(day_boundary_hour)
    date = parse_date(key) if not isinstance(key, dt.date) else key
    zone = get_tz(tz) if isinstance(tz, str) or tz is None else tz
    start_local = dt.datetime.combine(date, dt.time(hour=day_boundary_hour), tzinfo=zone)
    end_local = dt.datetime.combine(
        date + dt.timedelta(days=1), dt.time(hour=day_boundary_hour), tzinfo=zone
    )
    return _resolve_local(start_local, zone), _resolve_local(end_local, zone)


def night_dates(start: NightKey | dt.date, end: NightKey | dt.date) -> Iterator[NightKey]:
    """Every night key from ``start`` to ``end`` inclusive."""
    a = parse_date(start) if not isinstance(start, dt.date) else start
    b = parse_date(end) if not isinstance(end, dt.date) else end
    if b < a:
        a, b = b, a
    cur = a
    while cur <= b:
        yield cur.isoformat()
        cur += dt.timedelta(days=1)


def shift_night(key: NightKey, days: int) -> NightKey:
    """``night_of`` arithmetic in whole days."""
    return (parse_date(key) + dt.timedelta(days=days)).isoformat()


def _resolve_local(naive_local: dt.datetime, zone: dt.tzinfo) -> int:
    """Turn a local wall-clock datetime into an instant, handling DST oddities.

    Spring forward creates local times that never happen; fall back creates
    ones that happen twice. ``fold=0`` picks the first (pre-transition)
    occurrence of an ambiguous time. For a non-existent time, Python reports an
    offset that maps it to an instant either side of the gap depending on fold;
    we normalise by round-tripping, which lands on a real instant that is
    stable and monotonic — good enough for a night boundary at noon, which is
    never near a transition in any real timezone anyway.
    """
    stamp = naive_local.timestamp()
    resolved = dt.datetime.fromtimestamp(stamp, tz=dt.UTC).astimezone(zone)
    if resolved.hour == naive_local.hour and resolved.minute == naive_local.minute:
        return int(stamp * MS)

    # A local time that never happened. Adding a fixed hour assumes every gap
    # is an hour wide, which Lord Howe Island's is not — its transition is
    # thirty minutes, so an hour overshoots and lands past the end of the gap,
    # at which point night_of and night_bounds disagree about which night an
    # instant belongs to. Measure the gap instead: the size of the jump either
    # side of it is exactly how far forward the clock went.
    before = dt.datetime.fromtimestamp(
        (naive_local - dt.timedelta(hours=3)).timestamp(), tz=dt.UTC
    ).astimezone(zone)
    after = dt.datetime.fromtimestamp(
        (naive_local + dt.timedelta(hours=3)).timestamp(), tz=dt.UTC
    ).astimezone(zone)
    gap = (after.utcoffset() or dt.timedelta()) - (before.utcoffset() or dt.timedelta())
    if gap <= dt.timedelta():
        gap = dt.timedelta(hours=1)
    return int((naive_local + gap).timestamp() * MS)


def _check_boundary(hour: int) -> None:
    if isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 23:
        raise ValueError(f"day_boundary_hour must be an int in 0..23, got {hour!r}")


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def parse_date(value: str | dt.date) -> dt.date:
    """Parse a strict ``YYYY-MM-DD``."""
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    m = _DATE_RE.match(value.strip())
    if not m:
        raise ValueError(f"expected a YYYY-MM-DD date, got {value!r}")
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_hhmm(value: str) -> dt.time:
    """Parse ``HH:MM`` or ``HH:MM:SS`` into a ``time``."""
    m = _HHMM_RE.match(value.strip())
    if not m:
        raise ValueError(f"expected HH:MM, got {value!r}")
    hour, minute = int(m.group(1)), int(m.group(2))
    second = int(m.group(3) or 0)
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        raise ValueError(f"time out of range: {value!r}")
    return dt.time(hour, minute, second)


def format_hhmm(minutes: float) -> str:
    """Render minutes-after-local-midnight as ``HH:MM``, wrapping across days.

    Bedtimes either side of midnight are stored as minutes after midnight and
    may legitimately be negative (23:30 the previous evening recorded relative
    to the following day) or exceed 1440. Both wrap to a sensible clock face.
    """
    total = round(minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def minutes_after_local_midnight(ms: int, tz: dt.tzinfo | str | None = None) -> float:
    """Local clock position of an instant, in minutes after midnight."""
    local = from_ms(ms, tz)
    return local.hour * 60 + local.minute + local.second / 60 + local.microsecond / 6e7


def signed_minutes_from_reference(minutes: float, reference: float) -> float:
    """Shortest signed distance between two clock positions, in minutes.

    Bedtime consistency has to treat 23:50 and 00:10 as twenty minutes apart,
    not twenty-three hours and forty. Result is in ``(-720, 720]``.
    """
    delta = (minutes - reference) % 1440
    if delta > 720:
        delta -= 1440
    return delta


def circular_mean_minutes(values: Iterable[float]) -> float | None:
    """Mean clock time of a set of positions, respecting the midnight wrap."""
    import math

    xs = [v for v in values if v is not None]
    if not xs:
        return None
    sin_sum = sum(math.sin(2 * math.pi * v / 1440) for v in xs)
    cos_sum = sum(math.cos(2 * math.pi * v / 1440) for v in xs)
    if abs(sin_sum) < 1e-12 and abs(cos_sum) < 1e-12:
        return None  # perfectly opposed; no meaningful mean
    angle = math.atan2(sin_sum / len(xs), cos_sum / len(xs))
    return (angle * 1440 / (2 * math.pi)) % 1440


def circular_sd_minutes(values: Iterable[float]) -> float | None:
    """Circular standard deviation of clock positions, in minutes."""
    import math

    xs = [v for v in values if v is not None]
    if len(xs) < 2:
        return None
    sin_mean = sum(math.sin(2 * math.pi * v / 1440) for v in xs) / len(xs)
    cos_mean = sum(math.cos(2 * math.pi * v / 1440) for v in xs) / len(xs)
    r = math.hypot(sin_mean, cos_mean)
    if r <= 1e-12:
        return None
    if r >= 1.0:
        return 0.0
    return math.sqrt(-2 * math.log(r)) * 1440 / (2 * math.pi)


def local_window_bounds(
    key: NightKey,
    window: tuple[str, str],
    tz: dt.tzinfo | str | None = None,
    day_boundary_hour: int = DEFAULT_DAY_BOUNDARY_HOUR,
) -> tuple[int, int]:
    """Resolve a local ``("HH:MM", "HH:MM")`` window within a given night.

    Used for ``sleep.bedtime_window`` and ``sleep.wake_window``. A window whose
    start hour is at or after the day boundary sits on the night's own date; one
    before the boundary sits on the following morning. So ``["17:00","23:59"]``
    lands on the evening and ``["04:00","11:00"]`` on the morning after, which
    is what a human means by those two windows.
    """
    date = parse_date(key)
    zone = get_tz(tz) if isinstance(tz, str) or tz is None else tz
    start_t, end_t = parse_hhmm(window[0]), parse_hhmm(window[1])

    def anchor(t: dt.time) -> dt.datetime:
        day = date if t.hour >= day_boundary_hour else date + dt.timedelta(days=1)
        return dt.datetime.combine(day, t, tzinfo=zone)

    start, end = anchor(start_t), anchor(end_t)
    if end <= start:
        end += dt.timedelta(days=1)
    return _resolve_local(start, zone), _resolve_local(end, zone)


@dataclass(frozen=True, slots=True)
class NightWindow:
    """A resolved night: its key, its UTC bounds and the zone it was resolved in."""

    key: NightKey
    start_ms: int
    end_ms: int
    timezone: str

    @property
    def duration_h(self) -> float:
        return (self.end_ms - self.start_ms) / (3600 * MS)

    def contains(self, ms: int) -> bool:
        return self.start_ms <= ms < self.end_ms

    @classmethod
    def for_key(
        cls,
        key: NightKey,
        tz_name: str | None,
        day_boundary_hour: int = DEFAULT_DAY_BOUNDARY_HOUR,
    ) -> NightWindow:
        zone = get_tz(tz_name)
        start, end = night_bounds(key, zone, day_boundary_hour)
        return cls(key=key, start_ms=start, end_ms=end, timezone=str(zone))
