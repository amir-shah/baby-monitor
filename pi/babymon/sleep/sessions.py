"""Building a night's rollup from the raw record.

Everything in the ``nights`` table is derived. This module is what derives it,
and it is written so that deleting the whole table and rebuilding is always
safe — which matters, because the scoring formula will change and every past
night has to be re-scorable under the new one.

The one thing that is *not* derived is a manual correction. If the user has
said "he actually fell asleep at 19:50", that anchor survives every recompute,
and the metrics are recalculated around it.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Config
from ..models import Child, Night, NightStatus, SleepState
from ..storage import Repos
from ..timeutil import (
    NightWindow,
    local_window_bounds,
    minutes_after_local_midnight,
    now_ms,
    shift_night,
)
from ..timeutil import (
    night_of as compute_night_of,
)
from . import metrics as M

log = logging.getLogger(__name__)

__all__ = ["NightBuilder"]

#: Bumped whenever the metrics or the score change, so that
#: ``nights_needing_recompute`` can find every stale row.
#:
#: 2 — the nocturnal cut. Before it, an afternoon nap under the same night_of
#:     key became the night's bedtime and sleep onset, so every night with a
#:     recorded nap has wrong anchors baked into it and must be rebuilt.
COMPUTE_VERSION = 2

#: Trailing window for the timing-consistency subscore.
REGULARITY_WINDOW_NIGHTS = 14
#: Minimum nights before timing consistency can be scored at all.
REGULARITY_MIN_NIGHTS = 7


class NightBuilder:
    """Recomputes a night's metrics, score and status."""

    def __init__(self, config: Config, repos: Repos) -> None:
        self.config = config
        self.repos = repos

    # -- public -------------------------------------------------------------

    def rebuild(self, child: Child, night_of: str, *, finalise: bool = False) -> Night | None:
        """Recompute one night. ``finalise`` marks it complete rather than in-progress."""
        window = NightWindow.for_key(night_of, child.timezone, child.day_boundary_hour)
        segments = self.repos.segments.for_night(child.id, night_of)
        samples = self.repos.samples.for_night(child.id, night_of)
        events = self.repos.events.for_night(child.id, night_of, with_media=False)

        if not segments and not samples:
            log.debug("nothing recorded for %s; skipping", night_of)
            return None

        existing = self.repos.nights.get(child.id, night_of)
        overrides = self._overrides(existing)
        night_start_ms = self._nocturnal_start(child, night_of)

        coverage = self.repos.samples.coverage(
            child.id, window.start_ms, window.end_ms, self.config.sleep.sample_interval_s
        )
        # Coverage against a whole 24-hour window would never approach 1 for a
        # monitor that is only on at night. Measure it over the period the
        # child was actually in bed — and only the nocturnal part of it, or an
        # afternoon nap stretches the window across the whole afternoon and the
        # coverage figure collapses for a night that was fully recorded.
        in_bed = [
            s
            for s in segments
            if s.state.counts_as_in_bed and s.end_ms > night_start_ms
        ] or [s for s in segments if s.state.counts_as_in_bed]
        if in_bed:
            coverage = self.repos.samples.coverage(
                child.id,
                max(in_bed[0].start_ms, night_start_ms),
                in_bed[-1].end_ms,
                self.config.sleep.sample_interval_s,
            )

        computed = M.compute_metrics(
            segments,
            samples,
            events,
            awakening_min_min=self.config.sleep.awakening_min_min,
            coverage=coverage,
            overrides=overrides,
            night_start_ms=night_start_ms,
        )

        age_days = child.age_days(computed.sleep_onset_ms or window.start_ms)
        sri, midpoint_sd = self._regularity(child, night_of)
        nap_min = self._nap_minutes(child, night_of)

        breakdown = M.score_night(
            computed,
            age_days=age_days,
            weights=self.config.scoring.weights,
            nap_min=nap_min,
            sri=sri,
            midpoint_sd_min=midpoint_sd,
            comfort=self.config.environment.comfort,
            min_coverage=self.config.scoring.min_coverage,
        )

        status = self._status(finalise, coverage, breakdown, existing)
        night = M.build_night(
            child_id=child.id,
            night_of=night_of,
            timezone=str(child.timezone or self.config.timezone),
            metrics=computed,
            breakdown=breakdown,
            age_days=age_days,
            status=status,
            computed_ms=now_ms(),
        )
        night.schema_version = COMPUTE_VERSION
        night.score_components["nap_min"] = nap_min
        night.score_components["sri"] = sri
        night.score_components["midpoint_sd_min"] = midpoint_sd
        night.score_components["stirrings"] = computed.stirrings

        # A recompute must never silently clear a manual exclusion.
        if existing is not None:
            night.excluded = existing.excluded
            night.exclude_reason = existing.exclude_reason
            if existing.excluded:
                night.status = NightStatus.EXCLUDED

        return self.repos.nights.upsert(night)

    def rebuild_range(
        self, child: Child, night_from: str, night_to: str, *, finalise: bool = True
    ) -> int:
        """Recompute a span of nights. Used after a scoring change."""
        from ..timeutil import night_dates

        today = compute_night_of(now_ms(), child.timezone, child.day_boundary_hour)
        count = 0
        for key in night_dates(night_from, night_to):
            night = self.rebuild(child, key, finalise=finalise and key != today)
            if night is not None:
                count += 1
        return count

    def summary_so_far(self, child: Child, night_of: str) -> dict[str, Any]:
        """Cheap running totals for the live view.

        Reads segments and event counts rather than running the whole rollup,
        because this is called on every tick.
        """
        segments = self.repos.segments.for_night(child.id, night_of)
        counts = self.repos.events.counts_for_night(child.id, night_of)
        asleep_ms = sum(
            s.end_ms - s.start_ms for s in segments if s.state.counts_as_sleep
        )
        awakenings = sum(
            1
            for i, s in enumerate(segments)
            if s.state is SleepState.AWAKE
            and i > 0
            and segments[i - 1].state.counts_as_sleep
            and (s.end_ms - s.start_ms) >= self.config.sleep.awakening_min_min * 60_000
        )
        return {
            "tst_min": round(asleep_ms / 60000.0, 1),
            "awakenings": awakenings,
            "cry_events": sum(
                v for k, v in counts.items() if k in ("cry", "scream", "whimper", "fuss")
            ),
            "noise_events": sum(
                v for k, v in counts.items()
                if k in ("cry", "scream", "whimper", "fuss", "talk", "cough", "noise", "door")
            ),
        }

    # -- internals ----------------------------------------------------------

    def _nocturnal_start(self, child: Child, night_of: str) -> int:
        """Where the night begins, separating it from the day's naps.

        A night_of key spans a whole local day, so with the default noon
        boundary an afternoon nap sits under the same key as the night that
        follows. This is the cut that keeps them apart, and it is deliberately
        the same instant ``_nap_minutes`` uses: sleep before it is counted once
        as a nap, sleep after it once as night sleep, and neither twice.
        """
        start, _ = local_window_bounds(
            night_of,
            (self.config.sleep.bedtime_window[0], self.config.sleep.bedtime_window[1]),
            child.timezone,
            child.day_boundary_hour,
        )
        return start

    @staticmethod
    def _overrides(existing: Night | None) -> dict[str, int | None]:
        """Manual anchor corrections, which survive every recompute."""
        if existing is None:
            return {}
        components = existing.score_components or {}
        manual = components.get("manual_anchors") or {}
        if not isinstance(manual, dict):
            return {}
        return {
            key: manual.get(key)
            for key in ("bedtime_ms", "sleep_onset_ms", "final_wake_ms", "out_of_bed_ms")
            if manual.get(key)
        }

    def _status(
        self,
        finalise: bool,
        coverage: float,
        breakdown: M.ScoreBreakdown,
        existing: Night | None,
    ) -> NightStatus:
        if existing is not None and existing.excluded:
            return NightStatus.EXCLUDED
        if not finalise:
            return NightStatus.IN_PROGRESS
        if coverage < self.config.scoring.min_coverage or breakdown.score is None:
            return NightStatus.PARTIAL
        return NightStatus.COMPLETE

    def _regularity(self, child: Child, night_of: str) -> tuple[float | None, float | None]:
        """Sleep Regularity Index and midpoint variability over the trailing window.

        Both need at least a week of history; below that they are None and the
        timing component drops out of the score rather than being guessed at.
        """
        from ..analytics import stats

        start = shift_night(night_of, -(REGULARITY_WINDOW_NIGHTS - 1))
        nights = self.repos.nights.list(
            child.id, night_from=start, night_to=night_of, include_excluded=False
        )
        midpoints = [
            minutes_after_local_midnight(n.midpoint_ms, n.timezone)
            for n in nights
            if n.midpoint_ms is not None
        ]
        midpoint_sd = (
            stats.circular_sd(midpoints)
            if len(midpoints) >= REGULARITY_MIN_NIGHTS
            else None
        )

        sri = self._sri(child, night_of)
        return sri, midpoint_sd

    def _sri(self, child: Child, night_of: str) -> float | None:
        """Sleep Regularity Index over a one-minute epoch grid.

        The grid is anchored to the child's day boundary rather than to
        midnight, so that the main night sits in the middle of a day rather
        than being split across two — which would make every night look
        irregular for no reason.
        """
        from ..analytics import stats
        from ..timeutil import night_dates

        start = shift_night(night_of, -(REGULARITY_WINDOW_NIGHTS - 1))
        keys = list(night_dates(start, night_of))
        if len(keys) < REGULARITY_MIN_NIGHTS:
            return None

        days: list[list[bool | None]] = []
        for key in keys:
            window = NightWindow.for_key(key, child.timezone, child.day_boundary_hour)
            segments = self.repos.segments.for_night(child.id, key)
            if not segments:
                # A night with no record contributes unknowns, which drop out
                # of both sides of the ratio rather than counting as "awake".
                days.append([None] * 1440)
                continue
            grid: list[bool | None] = [None] * 1440
            for segment in segments:
                first = max(0, int((segment.start_ms - window.start_ms) / 60_000))
                last = min(1440, int((segment.end_ms - window.start_ms) / 60_000))
                asleep = segment.state.counts_as_sleep
                for minute in range(first, last):
                    grid[minute] = asleep
            days.append(grid)

        scored = [d for d in days if any(v is not None for v in d)]
        if len(scored) < REGULARITY_MIN_NIGHTS:
            return None
        return stats.sleep_regularity_index(days)

    def _nap_minutes(self, child: Child, night_of: str) -> float:
        """Daytime sleep belonging to this night's 24-hour period.

        The age bands are per 24 hours including naps, so scoring night sleep
        against them without the naps would mark every healthy toddler as
        under-slept.
        """
        if not self.config.sleep.track_naps:
            return 0.0
        window = NightWindow.for_key(night_of, child.timezone, child.day_boundary_hour)
        segments = self.repos.segments.range(child.id, window.start_ms, window.end_ms)
        if not segments:
            return 0.0

        # Anything asleep before the evening bedtime window opens is a nap.
        # Same instant compute_metrics cuts the night at, so no minute of sleep
        # is counted in both places.
        bedtime_start = self._nocturnal_start(child, night_of)
        nap_ms = 0
        for segment in segments:
            if not segment.state.counts_as_sleep:
                continue
            # ``range`` returns anything overlapping the window, so the child
            # sleeping in past the day boundary arrives here as a segment that
            # began yesterday. Only the part inside this 24-hour period belongs
            # to it; the rest was already counted as last night's sleep.
            start = max(segment.start_ms, window.start_ms)
            end = min(segment.end_ms, bedtime_start)
            if end <= start:
                continue
            duration = end - start
            if duration >= self.config.sleep.nap_min_duration_min * 60_000:
                nap_ms += duration
        return nap_ms / 60000.0
