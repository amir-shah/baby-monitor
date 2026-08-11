"""Sleep metrics and the quality score.

Every definition here follows the actigraphy convention, because a metric that
means something slightly different from what the literature (and every other
tracker) means by the same word is worse than no metric at all. The exact
formulas, with sources, are in ``docs/ANALYTICS.md``.

The vocabulary, all in minutes:

===========  ==========================================================
TIB          Time in bed: ``out_of_bed - bedtime``.
SPT          Sleep period time: ``final_wake - sleep_onset``.
SOL          Sleep onset latency: ``sleep_onset - bedtime``.
TST          Total sleep time: sleep within the sleep period. ``SPT - WASO``.
WASO         Wake after sleep onset: wake *strictly inside* the sleep period.
             Excludes settling time before onset and any time awake after the
             final wake.
N_awak       Awakenings: maximal wake runs inside the sleep period at or above
             ``sleep.awakening_min_min``. Shorter disturbances are counted
             separately as stirrings.
SE           Sleep efficiency. Reported two ways, because the choice of
             denominator changes the number materially and both are defensible:
             ``SE_TIB = TST/TIB`` (what consumer trackers report; penalises a
             long settle) and ``SE_SPT = TST/SPT`` (pure continuity).
LSB          Longest sleep bout — for a small child, the number a parent
             actually cares about.
Midpoint     ``sleep_onset + SPT/2``.
===========  ==========================================================

Nothing here is a medical measurement. A camera and a microphone infer sleep
from stillness and quiet, which is a genuinely useful signal and a poor
substitute for polysomnography. The scoring code refuses to produce a number
where it would be misleading — under four months of age, or when sensor
coverage was too thin — rather than emitting one with a caveat nobody reads.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..models import (
    CRY_LABELS,
    Event,
    EventKind,
    Night,
    NightStatus,
    Sample,
    SleepSegment,
    SleepState,
)
from ..timeutil import minutes_after_local_midnight

__all__ = [
    "AASM_BANDS",
    "SCORE_BANDS",
    "AgeBand",
    "NightMetrics",
    "ScoreBreakdown",
    "age_band",
    "compute_metrics",
    "score_band_label",
    "score_night",
]

MINUTE_MS = 60_000


# ---------------------------------------------------------------------------
# Age norms
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AgeBand:
    """Recommended sleep per 24 hours, naps included."""

    label: str
    min_days: int
    max_days: int | None
    low_h: float
    high_h: float
    #: The AASM declined to recommend a range below four months, on the grounds
    #: that the evidence is insufficient and normal variation is very wide. We
    #: follow that: no band, no target, no score.
    scoreable: bool = True


#: American Academy of Sleep Medicine consensus (Paruthi et al., J Clin Sleep
#: Med 2016;12(6):785-786), endorsed by the AAP. Per 24 hours, naps included.
AASM_BANDS: tuple[AgeBand, ...] = (
    AgeBand("Newborn", 0, 121, 14.0, 17.0, scoreable=False),
    AgeBand("Infant", 122, 364, 12.0, 16.0),
    AgeBand("Toddler", 365, 1094, 11.0, 14.0),
    AgeBand("Preschool", 1095, 2189, 10.0, 13.0),
    AgeBand("School age", 2190, 4744, 9.0, 12.0),
    AgeBand("Teen", 4745, None, 8.0, 10.0),
)


def age_band(age_days: int | None) -> AgeBand | None:
    """The band an age falls in, or None when the birthdate is unknown."""
    if age_days is None or age_days < 0:
        return None
    for band in AASM_BANDS:
        if age_days >= band.min_days and (band.max_days is None or age_days <= band.max_days):
            return band
    return AASM_BANDS[-1]


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class NightMetrics:
    """Everything derivable from one night's segments, samples and events."""

    bedtime_ms: int | None = None
    sleep_onset_ms: int | None = None
    final_wake_ms: int | None = None
    out_of_bed_ms: int | None = None

    tib_min: float | None = None
    spt_min: float | None = None
    tst_min: float | None = None
    sol_min: float | None = None
    waso_min: float | None = None
    tasafa_min: float | None = None
    awakenings: int = 0
    stirrings: int = 0
    longest_bout_min: float | None = None
    restless_min: float = 0.0
    sleep_efficiency: float | None = None       # TST / TIB
    sleep_efficiency_spt: float | None = None   # TST / SPT
    midpoint_ms: int | None = None
    fragmentation_index: float | None = None

    cry_events: int = 0
    cry_min: float = 0.0
    noise_events: int = 0
    peak_dbfs: float | None = None
    mean_dbfs: float | None = None
    motion_index: float | None = None

    temp_c_mean: float | None = None
    temp_c_min: float | None = None
    temp_c_max: float | None = None
    humidity_mean: float | None = None

    coverage: float = 0.0
    awakening_times_ms: list[int] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.awakening_times_ms is None:
            self.awakening_times_ms = []


def compute_metrics(
    segments: list[SleepSegment],
    samples: list[Sample],
    events: list[Event],
    *,
    awakening_min_min: float = 5.0,
    coverage: float = 0.0,
    overrides: dict[str, int | None] | None = None,
) -> NightMetrics:
    """Derive a night's metrics from its hypnogram, telemetry and event log.

    ``overrides`` lets the user correct the four anchors by hand from the
    dashboard; a corrected anchor is honoured and everything downstream is
    recomputed against it.
    """
    metrics = NightMetrics(coverage=coverage)
    overrides = overrides or {}

    ordered = sorted((s for s in segments if s.end_ms > s.start_ms), key=lambda s: s.start_ms)
    _summarise_samples(metrics, samples)
    _summarise_events(metrics, events)

    if not ordered:
        # No hypnogram: the environment and event summaries above are still
        # worth keeping, but there is nothing to say about sleep structure.
        return metrics

    in_bed = [s for s in ordered if s.state.counts_as_in_bed]
    if not in_bed:
        return metrics

    metrics.bedtime_ms = overrides.get("bedtime_ms") or in_bed[0].start_ms
    metrics.out_of_bed_ms = overrides.get("out_of_bed_ms") or in_bed[-1].end_ms

    asleep = [s for s in ordered if s.state.counts_as_sleep]
    if not asleep:
        # In bed all night but never scored asleep. TIB is still meaningful.
        metrics.tib_min = _minutes(metrics.bedtime_ms, metrics.out_of_bed_ms)
        metrics.sleep_efficiency = 0.0 if metrics.tib_min else None
        return metrics

    metrics.sleep_onset_ms = overrides.get("sleep_onset_ms") or asleep[0].start_ms
    metrics.final_wake_ms = overrides.get("final_wake_ms") or asleep[-1].end_ms

    onset = metrics.sleep_onset_ms
    final = metrics.final_wake_ms
    if onset is None or final is None or final <= onset:
        metrics.tib_min = _minutes(metrics.bedtime_ms, metrics.out_of_bed_ms)
        return metrics

    metrics.tib_min = _minutes(metrics.bedtime_ms, metrics.out_of_bed_ms)
    metrics.spt_min = _minutes(onset, final)
    metrics.sol_min = max(0.0, _minutes(metrics.bedtime_ms, onset) or 0.0)
    metrics.tasafa_min = max(0.0, _minutes(final, metrics.out_of_bed_ms) or 0.0)
    metrics.midpoint_ms = onset + (final - onset) // 2

    # Everything below is measured strictly inside the sleep period, which is
    # what makes WASO WASO rather than "all the time they were awake".
    sleep_ms = 0
    restless_ms = 0
    bouts: list[int] = []
    current_bout = 0
    wake_runs: list[tuple[int, int]] = []
    current_wake: list[int] | None = None

    for segment in ordered:
        start = max(segment.start_ms, onset)
        end = min(segment.end_ms, final)
        if end <= start:
            continue
        duration = end - start
        if segment.state.counts_as_sleep:
            sleep_ms += duration
            current_bout += duration
            if segment.state is SleepState.RESTLESS:
                restless_ms += duration
            if current_wake is not None:
                wake_runs.append((current_wake[0], current_wake[1]))
                current_wake = None
        else:
            if current_bout > 0:
                bouts.append(current_bout)
                current_bout = 0
            if current_wake is None:
                current_wake = [start, end]
            else:
                current_wake[1] = end
    if current_bout > 0:
        bouts.append(current_bout)
    if current_wake is not None:
        wake_runs.append((current_wake[0], current_wake[1]))

    metrics.tst_min = sleep_ms / MINUTE_MS
    metrics.restless_min = restless_ms / MINUTE_MS
    metrics.longest_bout_min = max(bouts) / MINUTE_MS if bouts else 0.0
    metrics.waso_min = max(0.0, (metrics.spt_min or 0.0) - metrics.tst_min)

    threshold_ms = awakening_min_min * MINUTE_MS
    long_wakes = [(a, b) for a, b in wake_runs if (b - a) >= threshold_ms]
    metrics.awakenings = len(long_wakes)
    metrics.stirrings = len(wake_runs) - len(long_wakes)
    metrics.awakening_times_ms = [a for a, _ in long_wakes]

    if metrics.tib_min and metrics.tib_min > 0:
        metrics.sleep_efficiency = min(1.0, metrics.tst_min / metrics.tib_min)
    if metrics.spt_min and metrics.spt_min > 0:
        metrics.sleep_efficiency_spt = min(1.0, metrics.tst_min / metrics.spt_min)
        if metrics.tst_min > 0:
            metrics.fragmentation_index = 60.0 * metrics.awakenings / (metrics.tst_min / 60.0)

    if samples:
        during = [
            s for s in samples if onset <= s.ts_ms < final and s.motion is not None
        ]
        if during:
            metrics.motion_index = sum(s.motion or 0.0 for s in during) / len(during)

    return metrics


def _minutes(start: int | None, end: int | None) -> float | None:
    if start is None or end is None or end <= start:
        return None
    return (end - start) / MINUTE_MS


def _summarise_samples(metrics: NightMetrics, samples: list[Sample]) -> None:
    temps = [s.temp_c for s in samples if s.temp_c is not None]
    if temps:
        metrics.temp_c_mean = sum(temps) / len(temps)
        metrics.temp_c_min = min(temps)
        metrics.temp_c_max = max(temps)
    humidity = [s.humidity_pct for s in samples if s.humidity_pct is not None]
    if humidity:
        metrics.humidity_mean = sum(humidity) / len(humidity)
    levels = [s.sound_dbfs for s in samples if s.sound_dbfs is not None]
    if levels:
        metrics.mean_dbfs = sum(levels) / len(levels)
    peaks = [s.sound_peak_dbfs for s in samples if s.sound_peak_dbfs is not None]
    if peaks:
        metrics.peak_dbfs = max(peaks)


def _summarise_events(metrics: NightMetrics, events: list[Event]) -> None:
    for event in events:
        # A label the user corrected to "" means "that was not a real event";
        # counting it would make the tallies reflect the detector's mistakes
        # rather than the night.
        if event.is_false_positive:
            continue
        label = event.effective_label
        if event.kind is not EventKind.AUDIO:
            continue
        metrics.noise_events += 1
        if label in CRY_LABELS:
            metrics.cry_events += 1
            if event.duration_s:
                metrics.cry_min += event.duration_s / 60.0


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ScoreBreakdown:
    """A score plus the parts it was made of, so it can be argued with."""

    score: float | None
    components: dict[str, float]
    weights: dict[str, float]
    notes: list[str]
    suppressed_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": None if self.score is None else round(self.score, 1),
            "band": score_band_label(self.score),
            "components": {k: round(v, 1) for k, v in self.components.items()},
            "weights": {k: round(v, 3) for k, v in self.weights.items()},
            "notes": self.notes,
            "suppressed_reason": self.suppressed_reason,
        }


#: Word bands. A single number invites more trust than it deserves, so the UI
#: shows the word and the four sub-scores, never a decimal.
SCORE_BANDS: tuple[tuple[float, str], ...] = (
    (90.0, "Excellent"),
    (80.0, "Good"),
    (65.0, "Fair"),
    (0.0, "Poor"),
)


def score_band_label(score: float | None) -> str | None:
    if score is None:
        return None
    for threshold, label in SCORE_BANDS:
        if score >= threshold:
            return label
    return "Poor"


def score_night(
    metrics: NightMetrics,
    *,
    age_days: int | None,
    weights: dict[str, float],
    nap_min: float = 0.0,
    sri: float | None = None,
    midpoint_sd_min: float | None = None,
    comfort: Any = None,
    min_coverage: float = 0.6,
) -> ScoreBreakdown:
    """Composite 0-100 sleep quality score.

    Four components, each 0-100, combined as a weighted mean. A component that
    cannot be computed is **dropped and the remaining weights renormalised**,
    rather than being given a neutral value — inventing a 50 for missing data
    would drag every score toward the middle and hide exactly the nights worth
    looking at.

    The weighting follows what consumer trackers converge on (duration
    dominant, then continuity and efficiency) with one substitution: those
    trackers spend roughly a quarter of the score on sleep-stage composition,
    which a camera and a microphone cannot see. That weight goes to timing
    regularity, which they can see and which matters more in early childhood
    anyway.
    """
    notes: list[str] = []
    band = age_band(age_days)

    if band is not None and not band.scoreable:
        return ScoreBreakdown(
            None, {}, {}, notes,
            "Under four months old. Sleep at this age varies too widely for a "
            "score to mean anything, so only the raw measurements are shown.",
        )
    if metrics.coverage < min_coverage:
        return ScoreBreakdown(
            None, {}, {}, notes,
            f"The sensors only covered {metrics.coverage:.0%} of this night "
            f"(at least {min_coverage:.0%} is needed for a score).",
        )
    if metrics.tst_min is None:
        return ScoreBreakdown(None, {}, {}, notes, "No sleep was detected on this night.")

    components: dict[str, float] = {}
    infant = age_days is not None and age_days < 365

    # -- Duration, against the age-appropriate 24-hour band -----------------
    if band is not None:
        total_h = (metrics.tst_min + max(0.0, nap_min)) / 60.0
        components["duration"] = _duration_subscore(total_h, band.low_h, band.high_h)
        if nap_min <= 0 and band.label in ("Infant", "Toddler", "Preschool"):
            notes.append(
                "No naps were recorded, so the duration score reflects night sleep only. "
                "The recommended range is for a full 24 hours."
            )
    else:
        notes.append(
            "No birthdate is set, so sleep duration cannot be scored against an age range."
        )

    # -- Efficiency ---------------------------------------------------------
    if metrics.sleep_efficiency is not None:
        floor, target = (0.70, 0.90) if infant else (0.75, 0.92)
        components["efficiency"] = _clamp(
            100.0 * (metrics.sleep_efficiency - floor) / (target - floor)
        )

    # -- Continuity ---------------------------------------------------------
    continuity_parts: list[float] = []
    waso_max = 90.0 if infant else 60.0
    if metrics.waso_min is not None:
        continuity_parts.append(_clamp(100.0 * (1.0 - metrics.waso_min / waso_max)))
    awakenings_ok = 2 if infant else 1
    awakenings_max = 8
    continuity_parts.append(
        _clamp(
            100.0
            * (
                1.0
                - max(0, metrics.awakenings - awakenings_ok)
                / float(awakenings_max - awakenings_ok)
            )
        )
    )
    bout_target = 360.0 if infant else 480.0
    if metrics.longest_bout_min is not None:
        continuity_parts.append(_clamp(100.0 * metrics.longest_bout_min / bout_target))
    if continuity_parts:
        components["continuity"] = sum(continuity_parts) / len(continuity_parts)

    # -- Timing consistency -------------------------------------------------
    timing_parts: list[float] = []
    if sri is not None:
        timing_parts.append(_clamp(sri))
    if midpoint_sd_min is not None:
        timing_parts.append(_clamp(100.0 * (1.0 - midpoint_sd_min / 90.0)))
    if timing_parts:
        components["timing"] = sum(timing_parts) / len(timing_parts)
    else:
        notes.append(
            "Timing consistency needs at least a week of nights before it can be scored."
        )

    # -- Environment (off by default; opt-in via the weights) ---------------
    if weights.get("environment", 0.0) > 0 and comfort is not None:
        env = _environment_subscore(metrics, comfort)
        if env is not None:
            components["environment"] = env

    active = {k: w for k, w in weights.items() if w > 0 and k in components}
    total_weight = sum(active.values())
    if not active or total_weight <= 0:
        return ScoreBreakdown(
            None, components, {}, notes, "Not enough of the night could be measured to score it."
        )

    normalised = {k: w / total_weight for k, w in active.items()}
    score = sum(components[k] * w for k, w in normalised.items())

    missing = [k for k in weights if weights[k] > 0 and k not in components]
    if missing:
        notes.append(
            "Scored without " + ", ".join(sorted(missing)) + "; the remaining parts were "
            "reweighted rather than filled in with a guess."
        )

    return ScoreBreakdown(_clamp(score), components, normalised, notes)


def _duration_subscore(total_h: float, low: float, high: float, slack: float = 2.0) -> float:
    """Sleep duration against the recommended band.

    Deliberately asymmetric. Undersleep falls to zero, because it is the thing
    the band exists to flag. Oversleep floors at 60: sleeping past the upper
    bound is a weaker signal and, in a small child, usually means they were
    catching up or coming down with something rather than that anything is
    wrong.
    """
    if total_h < low - slack:
        return 0.0
    if total_h < low:
        return _clamp(100.0 * (total_h - (low - slack)) / slack)
    if total_h <= high:
        return 100.0
    if total_h <= high + slack:
        return _clamp(100.0 - 40.0 * (total_h - high) / slack)
    return 60.0


def _environment_subscore(metrics: NightMetrics, comfort: Any) -> float | None:
    parts: list[float] = []
    if metrics.temp_c_mean is not None:
        low, high = comfort.temp_c_min, comfort.temp_c_max
        parts.append(_band_subscore(metrics.temp_c_mean, low, high, slack=3.0))
    if metrics.humidity_mean is not None:
        parts.append(
            _band_subscore(
                metrics.humidity_mean, comfort.humidity_min, comfort.humidity_max, slack=15.0
            )
        )
    return sum(parts) / len(parts) if parts else None


def _band_subscore(value: float, low: float, high: float, slack: float) -> float:
    if low <= value <= high:
        return 100.0
    distance = (low - value) if value < low else (value - high)
    return _clamp(100.0 * (1.0 - distance / slack))


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------------------


def build_night(
    *,
    child_id: int,
    night_of: str,
    timezone: str,
    metrics: NightMetrics,
    breakdown: ScoreBreakdown,
    age_days: int | None,
    status: NightStatus,
    computed_ms: int,
) -> Night:
    """Assemble the persisted rollup from the computed pieces."""
    return Night(
        child_id=child_id,
        night_of=night_of,
        timezone=timezone,
        bedtime_ms=metrics.bedtime_ms,
        sleep_onset_ms=metrics.sleep_onset_ms,
        final_wake_ms=metrics.final_wake_ms,
        out_of_bed_ms=metrics.out_of_bed_ms,
        tib_min=metrics.tib_min,
        tst_min=metrics.tst_min,
        sol_min=metrics.sol_min,
        waso_min=metrics.waso_min,
        awakenings=metrics.awakenings,
        longest_bout_min=metrics.longest_bout_min,
        sleep_efficiency=metrics.sleep_efficiency,
        midpoint_ms=metrics.midpoint_ms,
        restless_min=metrics.restless_min,
        cry_events=metrics.cry_events,
        cry_min=metrics.cry_min,
        noise_events=metrics.noise_events,
        peak_dbfs=metrics.peak_dbfs,
        mean_dbfs=metrics.mean_dbfs,
        motion_index=metrics.motion_index,
        temp_c_mean=metrics.temp_c_mean,
        temp_c_min=metrics.temp_c_min,
        temp_c_max=metrics.temp_c_max,
        humidity_mean=metrics.humidity_mean,
        quality_score=breakdown.score,
        score_components={
            **breakdown.to_dict(),
            "sleep_efficiency_spt": metrics.sleep_efficiency_spt,
            "stirrings": metrics.stirrings,
            "fragmentation_index": metrics.fragmentation_index,
            "tasafa_min": metrics.tasafa_min,
            "spt_min": metrics.spt_min,
        },
        coverage=metrics.coverage,
        status=status,
        age_days=age_days,
        computed_ms=computed_ms,
    )


def midpoint_minutes(night: Night) -> float | None:
    """A night's sleep midpoint as minutes after local midnight."""
    if night.midpoint_ms is None:
        return None
    return minutes_after_local_midnight(night.midpoint_ms, night.timezone)
