"""Aggregations behind ``/api/analytics/{summary,trends,regularity,patterns}``.

:mod:`babymon.analytics.correlate` answers "did this tag matter?". This module
answers the four questions that do not involve tags at all: how is this month
compared with last, which way is the trend going, how regular is the schedule,
and when in the night do things go wrong.

Three decisions are worth spelling out, because the obvious implementations of
each are wrong for this data:

* **Trends use Theil-Sen, not least squares.** One illness drags an OLS line
  around for weeks either side of itself. The confidence interval is Sen's
  distribution-free interval over the pairwise slopes, for the same reason.
* **Regularity is the Sleep Regularity Index, not the standard deviation of
  bedtime.** SRI compares every minute of each day with the same minute of the
  next, so it sees naps, split nights and a 5am start that gets patched with a
  lie-in — none of which a bedtime SD notices. The grid is one-minute epochs
  built from ``sleep_segments``, aligned on each night's own local boundary so
  "the same clock position" survives DST.
* **Clock times go through circular statistics.** The arithmetic mean of 23:50
  and 00:10 is midday, which would make the most consistent bedtime in the
  record look like the least.

Nights with no data are carried through the grid as unknown rather than
dropped, so a sensor outage lowers confidence instead of quietly inventing
regularity that was never observed.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any

from ..models import Child, Night, SleepState
from ..storage.repo import Repos
from ..timeutil import (
    format_hhmm,
    minutes_after_local_midnight,
    night_bounds,
    night_dates,
    now_ms,
    parse_date,
    shift_night,
)
from ..timeutil import night_of as night_of_for
from . import stats

__all__ = [
    "ANALYSABLE_METRICS",
    "METRIC_UNITS",
    "Window",
    "export_matrix",
    "factor_table",
    "patterns",
    "regularity",
    "resolve_window",
    "summary",
    "trends",
]

#: The outcome metrics a client may ask for. A whitelist rather than a getattr
#: on the ``Night`` dataclass, so a query string cannot reach ``timezone`` or
#: ``child_id`` and get a nonsense series back.
ANALYSABLE_METRICS: tuple[str, ...] = (
    "quality_score",
    "tst_min",
    "tib_min",
    "sol_min",
    "waso_min",
    "awakenings",
    "longest_bout_min",
    "sleep_efficiency",
    "restless_min",
    "cry_events",
    "cry_min",
    "noise_events",
    "motion_index",
    "temp_c_mean",
    "humidity_mean",
)

METRIC_UNITS: dict[str, str] = {
    "quality_score": "points",
    "tst_min": "min",
    "tib_min": "min",
    "sol_min": "min",
    "waso_min": "min",
    "longest_bout_min": "min",
    "restless_min": "min",
    "cry_min": "min",
    "sleep_efficiency": "",
    "awakenings": "",
    "cry_events": "",
    "noise_events": "",
    "motion_index": "",
    "temp_c_mean": "°C",
    "humidity_mean": "%",
}

#: Metrics where a smaller number is the better night, so a downward trend gets
#: called "improving" rather than "worsening".
LOWER_IS_BETTER = frozenset(
    {"sol_min", "waso_min", "awakenings", "cry_events", "cry_min", "noise_events",
     "restless_min", "motion_index"}
)

#: Metrics with a comfortable band rather than a good end. Room temperature has
#: no direction that is an improvement: 15 °C and 27 °C are both wrong, and a
#: metric that is in neither set defaults to "higher is better", which reported
#: a nursery getting steadily hotter as a night getting steadily better. These
#: are shown as rising or falling, and left for the reader to judge against
#: ``environment.comfort``.
BANDED = frozenset({"temp_c_mean", "humidity_mean"})

EPOCHS_PER_DAY = 1440
MINUTE_MS = 60_000
#: Below this the Sleep Regularity Index is dominated by whichever two nights
#: happen to be adjacent (Phillips et al. use a week as the working minimum).
MIN_SRI_NIGHTS = 7
_ROLLING_WINDOW = 7

_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


@dataclass(slots=True)
class Window:
    """A closed range of night keys, plus the equally long window before it."""

    days: int
    start: str
    end: str
    previous_start: str
    previous_end: str

    def keys(self) -> list[str]:
        return list(night_dates(self.start, self.end))


def resolve_window(child: Child, days: int, *, end: str | None = None) -> Window:
    """The last ``days`` nights ending at ``end`` (default: tonight)."""
    days = max(1, days)
    last = end or night_of_for(now_ms(), child.timezone, child.day_boundary_hour)
    start = shift_night(last, -(days - 1))
    return Window(
        days=days,
        start=start,
        end=last,
        previous_start=shift_night(start, -days),
        previous_end=shift_night(start, -1),
    )


def _load(repos: Repos, child: Child, start: str, end: str) -> list[Night]:
    nights = repos.nights.list(child.id, night_from=start, night_to=end, limit=1000)
    nights.sort(key=lambda n: n.night_of)
    return nights


def _values(nights: list[Night], metric: str) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    for night in nights:
        if not night.analysable:
            continue
        value = night.metric(metric)
        if value is not None:
            out.append((night.night_of, value))
    return out


def _describe(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0, "mean": None, "median": None, "sd": None, "min": None, "max": None}
    return {
        "n": len(values),
        "mean": _round(stats.mean(values)),
        "median": _round(stats.median(values)),
        "sd": _round(stats.stdev(values)) if len(values) > 1 else None,
        "min": _round(min(values)),
        "max": _round(max(values)),
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def summary(repos: Repos, child: Child, *, days: int = 30) -> dict[str, Any]:
    """Headline metrics, the change against the previous window, and the target band."""
    from ..sleep.metrics import age_band, score_band_label

    window = resolve_window(child, days)
    nights = _load(repos, child, window.start, window.end)
    previous = _load(repos, child, window.previous_start, window.previous_end)
    analysable = [n for n in nights if n.analysable]

    metrics: dict[str, Any] = {}
    for metric in ANALYSABLE_METRICS:
        current = [v for _, v in _values(nights, metric)]
        prior = [v for _, v in _values(previous, metric)]
        entry = _describe(current)
        entry["unit"] = METRIC_UNITS.get(metric, "")
        entry["previous_mean"] = _round(stats.mean(prior)) if prior else None
        entry["delta"] = (
            _round(stats.mean(current) - stats.mean(prior)) if current and prior else None
        )
        # "Better" is not "bigger" for half of these, and a dashboard that
        # colours a rising WASO green is worse than one with no colour at all.
        entry["direction"] = _direction(entry["delta"], metric)
        metrics[metric] = entry

    latest = analysable[-1] if analysable else (nights[-1] if nights else None)
    band = age_band(latest.age_days if latest else None)

    return {
        "child_id": child.id,
        "days": window.days,
        "from": window.start,
        "to": window.end,
        "nights_total": len(nights),
        "nights_analysable": len(analysable),
        "metrics": metrics,
        "timing": _timing(analysable, child),
        "score_band": score_band_label(metrics["quality_score"]["mean"]),
        "target_band": (
            None
            if band is None
            else {
                "label": band.label,
                "low_h": band.low_h,
                "high_h": band.high_h,
                "scoreable": band.scoreable,
                "age_days": latest.age_days if latest else None,
            }
        ),
        "previous": {"from": window.previous_start, "to": window.previous_end,
                     "nights_total": len(previous)},
    }


def _timing(nights: list[Night], child: Child) -> dict[str, Any]:
    """Circular means and spreads of the three clock anchors."""
    out: dict[str, Any] = {}
    for name, attr in (
        ("bedtime", "bedtime_ms"),
        ("sleep_onset", "sleep_onset_ms"),
        ("waketime", "final_wake_ms"),
        ("midpoint", "midpoint_ms"),
    ):
        minutes = [
            minutes_after_local_midnight(value, night.timezone or child.timezone)
            for night in nights
            if (value := getattr(night, attr)) is not None
        ]
        mean = stats.circular_mean(minutes) if minutes else None
        out[name] = {
            "n": len(minutes),
            "mean_min": _round(mean),
            "mean_hhmm": _hhmm(mean),
            "sd_min": _round(stats.circular_sd(minutes)) if len(minutes) > 1 else None,
        }
    return out


def _direction(delta: float | None, metric: str) -> str | None:
    if delta is None or abs(delta) < 1e-9:
        return "flat" if delta is not None else None
    if metric in BANDED:
        return "rising" if delta > 0 else "falling"
    improved = (delta < 0) if metric in LOWER_IS_BETTER else (delta > 0)
    return "improving" if improved else "worsening"


# ---------------------------------------------------------------------------
# Trends
# ---------------------------------------------------------------------------


def trends(
    repos: Repos,
    child: Child,
    *,
    metric: str = "tst_min",
    days: int = 90,
    bucket: str = "night",
) -> dict[str, Any]:
    """A metric's series, a robust fitted trend, and a rolling median."""
    window = resolve_window(child, days)
    nights = _load(repos, child, window.start, window.end)
    series = _values(nights, metric)

    if bucket == "week":
        points = _weekly(series)
        key_field = "week_of"
    else:
        points = [{"night_of": key, "value": _round(value)} for key, value in series]
        key_field = "night_of"

    values = [p["value"] for p in points]
    for index, point in enumerate(points):
        lo = max(0, index - _ROLLING_WINDOW + 1)
        point["rolling_median"] = _round(stats.median(values[lo : index + 1]))

    xs = [float(_day_index(window.start, p[key_field])) for p in points]
    ys = [float(p["value"]) for p in points]
    return {
        "child_id": child.id,
        "metric": metric,
        "metric_unit": METRIC_UNITS.get(metric, ""),
        "bucket": bucket,
        "days": window.days,
        "from": window.start,
        "to": window.end,
        "points": points,
        # xs is a day index either way — for weekly buckets it is the day index
        # of the week's Monday — so the slope is per day whatever the bucket,
        # and the conversion to a week is the same seven. Scaling weekly
        # buckets by one reported a figure seven times too small, under a name
        # that says otherwise.
        "trend": _fit_trend(xs, ys, metric),
    }


def _weekly(series: list[tuple[str, float]]) -> list[dict[str, Any]]:
    """Collapse nights into ISO weeks, keyed by the Monday they start on.

    Each week carries its spread as well as its centre. A weekly mean drawn as
    a bare line implies a precision a handful of nights does not have — one bad
    night in a seven-night week moves it visibly — so the quartiles travel with
    it and the chart draws them as a band. The median is reported alongside the
    mean for the same reason: they diverge exactly when a week had an outlier,
    which is when the reader most needs to know.
    """
    buckets: dict[str, list[float]] = {}
    for key, value in series:
        date = parse_date(key)
        monday = (date - dt.timedelta(days=date.weekday())).isoformat()
        buckets.setdefault(monday, []).append(value)
    out: list[dict[str, Any]] = []
    for week, values in sorted(buckets.items()):
        entry = {
            "week_of": week,
            "value": _round(stats.mean(values)),
            "median": _round(stats.median(values)),
            "n": len(values),
            "min": _round(min(values)),
            "max": _round(max(values)),
        }
        # Quartiles need enough points to mean something; with three nights the
        # interpolated p25 sits between two of them and the band is noise.
        if len(values) >= 4:
            entry["p25"] = _round(stats.percentile(values, 25))
            entry["p75"] = _round(stats.percentile(values, 75))
        else:
            entry["p25"] = None
            entry["p75"] = None
        out.append(entry)
    return out


def _fit_trend(xs: list[float], ys: list[float], metric: str) -> dict[str, Any]:
    """Theil-Sen fit. ``xs`` is in days, so the weekly figure is the slope times seven."""
    if len(xs) < 3:
        return {"n": len(xs), "slope": None, "slope_per_week": None, "intercept": None,
                "ci95": [None, None], "direction": None,
                "note": "At least three points are needed before a trend means anything."}
    slope, intercept = stats.theil_sen(xs, ys)
    low, high = _sen_slope_ci(xs, ys)
    # A trend whose interval spans zero is not a trend, however pretty the line.
    if low is not None and high is not None and low <= 0.0 <= high:
        direction = "flat"
    elif metric in BANDED:
        direction = "rising" if slope > 0 else "falling"
    else:
        improved = (slope < 0) if metric in LOWER_IS_BETTER else (slope > 0)
        direction = "improving" if improved else "worsening"
    return {
        "n": len(xs),
        "slope": _round(slope, 4),
        "slope_per_week": _round(slope * 7.0, 3),
        "intercept": _round(intercept, 3),
        "ci95": [_round(low, 4), _round(high, 4)],
        "direction": direction,
    }


def _sen_slope_ci(xs: list[float], ys: list[float]) -> tuple[float | None, float | None]:
    """Sen's distribution-free interval for the Theil-Sen slope.

    The interval is a pair of order statistics of the pairwise slopes, offset
    from the median by a normal quantile scaled by the Kendall-tau variance.
    No distributional assumption about the residuals, which is the whole point
    of having used Theil-Sen in the first place.
    """
    slopes = sorted(
        (ys[j] - ys[i]) / (xs[j] - xs[i])
        for i in range(len(xs))
        for j in range(i + 1, len(xs))
        if xs[j] != xs[i]
    )
    n = len(xs)
    total = len(slopes)
    if total < 2:
        return None, None
    spread = stats.Z_95 * math.sqrt(n * (n - 1) * (2 * n + 5) / 18.0)
    # Sen's limits are the M1-th and the (M2+1)-th largest pairwise slopes,
    # counting from one. In zero-based indices that is M1-1 and M2 — taking
    # M2-1 for the upper limit, as this did, drops one order statistic off the
    # top of every interval and reports a trend as certain when it is not.
    low_index = round((total - spread) / 2.0) - 1
    high_index = round((total + spread) / 2.0)
    low_index = min(max(low_index, 0), total - 1)
    high_index = min(max(high_index, 0), total - 1)
    return slopes[low_index], slopes[high_index]


def _day_index(origin: str, key: str) -> int:
    return (parse_date(key) - parse_date(origin)).days


# ---------------------------------------------------------------------------
# Regularity
# ---------------------------------------------------------------------------


def regularity(repos: Repos, child: Child, *, days: int = 30) -> dict[str, Any]:
    """Sleep Regularity Index, clock-time variability and the actogram raster."""
    window = resolve_window(child, days)
    keys = window.keys()
    nights = {n.night_of: n for n in _load(repos, child, window.start, window.end)}
    tz = child.timezone

    grid: list[list[bool | None]] = []
    actogram: list[dict[str, Any]] = []
    for key in keys:
        start_ms, _ = night_bounds(key, tz, child.day_boundary_hour)
        epochs = _epoch_row(repos, child, key, start_ms)
        grid.append(epochs)
        known = sum(1 for e in epochs if e is not None)
        actogram.append(
            {
                "night_of": key,
                "start_ms": start_ms,
                "runs": _asleep_runs(epochs),
                "coverage": round(known / EPOCHS_PER_DAY, 3),
                "quality_score": (nights[key].quality_score if key in nights else None),
            }
        )

    measured = [row for row in grid if any(e is not None for e in row)]
    sri = stats.sleep_regularity_index(grid) if len(measured) >= MIN_SRI_NIGHTS else None

    analysable = [n for n in nights.values() if n.analysable]
    analysable.sort(key=lambda n: n.night_of)
    return {
        "child_id": child.id,
        "days": window.days,
        "from": window.start,
        "to": window.end,
        "epoch_min": 1,
        "sri": _round(sri),
        "sri_nights": len(measured),
        "sri_note": (
            None
            if sri is not None
            else f"The regularity index needs at least {MIN_SRI_NIGHTS} nights with a "
            f"hypnogram; there are {len(measured)}."
        ),
        "timing": _timing(analysable, child),
        "actogram": actogram,
    }


def _epoch_row(repos: Repos, child: Child, key: str, start_ms: int) -> list[bool | None]:
    """One night as 1440 one-minute epochs: True asleep, False awake, None unknown.

    Built from ``sleep_segments`` rather than samples because the segments are
    the state machine's considered opinion, already smoothed; sample states
    flicker and would make every night look irregular.
    """
    epochs: list[bool | None] = [None] * EPOCHS_PER_DAY
    for segment in repos.segments.for_night(child.id, key):
        if segment.state is SleepState.UNKNOWN:
            continue
        asleep = segment.state.counts_as_sleep
        first = max(0, (segment.start_ms - start_ms) // MINUTE_MS)
        # Round the end up so a segment shorter than a minute still marks one.
        last = min(EPOCHS_PER_DAY, -(-(segment.end_ms - start_ms) // MINUTE_MS))
        for index in range(first, last):
            epochs[index] = asleep
    return epochs


def _asleep_runs(epochs: list[bool | None]) -> list[list[int]]:
    """Compress the epoch row into ``[start_min, end_min)`` asleep runs."""
    runs: list[list[int]] = []
    start: int | None = None
    for index, value in enumerate(epochs):
        if value:
            if start is None:
                start = index
        elif start is not None:
            runs.append([start, index])
            start = None
    if start is not None:
        runs.append([start, len(epochs)])
    return runs


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------


def patterns(
    repos: Repos, child: Child, *, days: int = 90, metric: str = "quality_score"
) -> dict[str, Any]:
    """When awakenings happen, which days are worse, and what the room was like."""
    window = resolve_window(child, days)
    nights = _load(repos, child, window.start, window.end)
    analysable = [n for n in nights if n.analysable]

    return {
        "child_id": child.id,
        "days": window.days,
        "from": window.start,
        "to": window.end,
        "metric": metric,
        "metric_unit": METRIC_UNITS.get(metric, ""),
        "awakenings_by_hour": _awakenings_by_hour(repos, child, window),
        "day_of_week": _day_of_week(analysable, metric),
        "environment": {
            "temp_c": _binned(analysable, "temp_c_mean", metric, width=1.0, unit="°C"),
            "noise_dbfs": _binned(analysable, "mean_dbfs", metric, width=5.0, unit="dBFS"),
            "humidity_pct": _binned(analysable, "humidity_mean", metric, width=5.0, unit="%"),
        },
    }


def _awakenings_by_hour(repos: Repos, child: Child, window: Window) -> list[dict[str, Any]]:
    start_ms, _ = night_bounds(window.start, child.timezone, child.day_boundary_hour)
    _, end_ms = night_bounds(window.end, child.timezone, child.day_boundary_hour)
    events, _ = repos.events.list(
        child_id=child.id,
        from_ms=start_ms,
        to_ms=end_ms,
        kinds=["sleep"],
        labels=["awakening"],
        exclude_false_positives=True,
        limit=10_000,
        order="asc",
    )
    counts = [0] * 24
    for event in events:
        hour = int(minutes_after_local_midnight(event.start_ms, child.timezone) // 60) % 24
        counts[hour] += 1
    return [{"hour": hour, "count": count} for hour, count in enumerate(counts)]


def _day_of_week(nights: list[Night], metric: str) -> list[dict[str, Any]]:
    buckets: dict[int, list[float]] = {}
    for night in nights:
        value = night.metric(metric)
        if value is None:
            continue
        buckets.setdefault(parse_date(night.night_of).weekday(), []).append(value)
    return [
        {
            "dow": dow,
            "label": _WEEKDAYS[dow],
            "n": len(buckets.get(dow, [])),
            "mean": _round(stats.mean(buckets[dow])) if buckets.get(dow) else None,
            "median": _round(stats.median(buckets[dow])) if buckets.get(dow) else None,
        }
        for dow in range(7)
    ]


def _binned(
    nights: list[Night], driver: str, metric: str, *, width: float, unit: str
) -> list[dict[str, Any]]:
    """Group nights by a continuous driver and report the outcome in each bin."""
    pairs = [
        (x, y)
        for night in nights
        if (x := night.metric(driver)) is not None and (y := night.metric(metric)) is not None
    ]
    if len(pairs) < 3:
        return []
    buckets: dict[float, list[float]] = {}
    for x, y in pairs:
        buckets.setdefault(math.floor(x / width) * width, []).append(y)
    return [
        {
            "bin_low": _round(low, 2),
            "bin_high": _round(low + width, 2),
            "unit": unit,
            "n": len(values),
            "mean": _round(stats.mean(values)),
        }
        for low, values in sorted(buckets.items())
    ]


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def factor_table(
    repos: Repos, child: Child, *, days: int = 180
) -> tuple[list[str], list[dict[str, Any]]]:
    """The per-night matrix behind every statistic here, for the export endpoint.

    One row per night, every outcome metric as a column, every tag the child has
    ever been given as a further column. Someone who wants to do their own
    analysis should not have to reverse-engineer it out of the JSON endpoints.
    """
    window = resolve_window(child, days)
    nights = _load(repos, child, window.start, window.end)
    keys = [n.night_of for n in nights]
    matrix = repos.notes.night_factor_matrix(child.id, keys)
    slugs = sorted({slug for row in matrix.values() for slug in row})

    columns = [
        "night_of", "status", "excluded", "analysable", "coverage", "age_days",
        *ANALYSABLE_METRICS,
        "bedtime_min_local", "waketime_min_local", "midpoint_min_local",
        *slugs,
    ]
    rows: list[dict[str, Any]] = []
    for night in nights:
        row: dict[str, Any] = {
            "night_of": night.night_of,
            "status": str(night.status),
            "excluded": int(night.excluded),
            "analysable": int(night.analysable),
            "coverage": _round(night.coverage, 3),
            "age_days": night.age_days,
            "bedtime_min_local": _local_minutes(night.bedtime_ms, night.timezone),
            "waketime_min_local": _local_minutes(night.final_wake_ms, night.timezone),
            "midpoint_min_local": _local_minutes(night.midpoint_ms, night.timezone),
        }
        for metric in ANALYSABLE_METRICS:
            row[metric] = _round(night.metric(metric), 3)
        applied = matrix.get(night.night_of, {})
        for slug in slugs:
            row[slug] = applied.get(slug)
        rows.append(row)
    return columns, rows


def _local_minutes(ms: int | None, tz: str | None) -> float | None:
    return None if ms is None else _round(minutes_after_local_midnight(ms, tz))


def _hhmm(minutes: float | None) -> str | None:
    return None if minutes is None else format_hhmm(minutes)


def _round(value: float | None, digits: int = 2) -> float | None:
    if value is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def export_matrix(
    repos: Repos, child: Child, *, days: int = 365, fmt: str = "csv"
) -> str:
    """Serialise the per-night factor matrix, so anyone can check the arithmetic.

    Shared by ``GET /api/analytics/export`` and ``babymon export``: the file a
    user downloads from the dashboard and the one they get from the command
    line must be the same file, or the two will disagree the first time someone
    compares them.
    """
    import csv
    import io
    import json

    columns, rows = factor_table(repos, child, days=days)
    if fmt == "json":
        from .correlate import DISCLAIMER

        return json.dumps(
            {
                "child_id": child.id,
                "child": child.name,
                "days": days,
                "columns": columns,
                "rows": rows,
                "disclaimer": DISCLAIMER,
            },
            indent=2,
            default=str,
        )
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()
