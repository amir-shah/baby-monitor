"""The sleep state machine.

Fuses motion and sound into one of five states, sampled every fifteen seconds:

===========  =============================================================
ABSENT       Nothing at all for a long time. Nobody is in the room.
AWAKE        Clearly active — sustained movement, or talking, or crying.
SETTLING     In bed, winding down, not yet asleep. Only reachable before
             sleep onset; after onset the equivalent state is RESTLESS.
RESTLESS     Asleep but moving or vocalising. Counts as sleep.
ASLEEP       Still and quiet.
===========  =============================================================

Two things make this more than a threshold.

**Dwell times.** Every transition requires the evidence to persist. A child who
rolls over does not wake up, and scoring them awake for one sample would put a
spurious awakening in the night's tally and knock points off the score. The
required persistence differs by direction: falling asleep is slow and should be
scored slowly; waking is fast.

**Asymmetry around sleep.** Actigraphy conventions treat a brief arousal
differently from an awakening, and so does this: activity while asleep first
becomes RESTLESS, and only becomes AWAKE if it keeps up. That single rule is
what stops a normal night from being reported as a dozen awakenings.

The output is a stream of state changes, which
:mod:`babymon.sleep.sessions` turns into contiguous segments and then into the
metrics in :mod:`babymon.sleep.metrics`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..models import SleepState

log = logging.getLogger(__name__)

__all__ = ["SleepStateMachine", "Observation", "StateChange"]


@dataclass(slots=True)
class Observation:
    """One tick's worth of fused evidence."""

    ts_ms: int
    #: Motion activity, 0..1, already normalised against the room's baseline.
    motion: float = 0.0
    #: True while the motion detector's own hysteresis says movement is active.
    motion_active: bool = False
    #: Level above the adaptive noise floor, in dB.
    sound_excess_db: float = 0.0
    #: Highest smoothed cry-family classifier score this tick, 0..1.
    cry_score: float = 0.0
    #: True when a sound event suggesting waking is currently open.
    wake_sound: bool = False
    #: False when the camera or microphone is not reporting.
    video_ok: bool = True
    audio_ok: bool = True

    @property
    def has_evidence(self) -> bool:
        return self.video_ok or self.audio_ok


@dataclass(slots=True)
class StateChange:
    ts_ms: int
    previous: SleepState
    current: SleepState
    confidence: float
    reason: str


@dataclass(slots=True)
class _Candidate:
    state: SleepState
    since_ms: int


class SleepStateMachine:
    """Fuses observations into a sleep state, with per-transition dwell times."""

    def __init__(
        self,
        *,
        onset_quiet_min: float = 12.0,
        awakening_min_min: float = 5.0,
        absent_after_min: float = 25.0,
        motion_awake: float = 0.25,
        motion_restless: float = 0.05,
        sound_awake_db: float = 10.0,
        cry_awake: float = 0.45,
        sample_interval_s: float = 15.0,
    ) -> None:
        self.onset_quiet_ms = int(onset_quiet_min * 60_000)
        self.awakening_min_ms = int(awakening_min_min * 60_000)
        self.absent_after_ms = int(absent_after_min * 60_000)
        self.motion_awake = motion_awake
        self.motion_restless = motion_restless
        self.sound_awake_db = sound_awake_db
        self.cry_awake = cry_awake
        self.sample_interval_s = sample_interval_s

        self.state = SleepState.UNKNOWN
        self.state_since_ms: int | None = None
        self._candidate: _Candidate | None = None
        self._last_activity_ms: int | None = None
        self._sleep_onset_ms: int | None = None
        self._confidence = 0.0
        self._history: list[StateChange] = []

    # -- main entry point ---------------------------------------------------

    def observe(self, obs: Observation) -> StateChange | None:
        """Feed one tick. Returns a change if the state just moved."""
        if not obs.has_evidence:
            # Both sensors down. Holding the last state is more honest than
            # inventing ABSENT, which would look like the child left the room.
            return None

        instantaneous, confidence, reason = self._interpret(obs)

        if self._is_active(obs):
            self._last_activity_ms = obs.ts_ms

        if instantaneous is self.state:
            self._candidate = None
            self._confidence = max(self._confidence, confidence)
            return None

        if self._candidate is None or self._candidate.state is not instantaneous:
            self._candidate = _Candidate(instantaneous, obs.ts_ms)
            return None

        required = self._dwell_ms(self.state, instantaneous)
        if obs.ts_ms - self._candidate.since_ms < required:
            return None

        return self._transition(obs.ts_ms, instantaneous, confidence, reason)

    # -- interpretation -----------------------------------------------------

    def _interpret(self, obs: Observation) -> tuple[SleepState, float, str]:
        """What the current tick looks like, before any dwell requirement."""
        loud = obs.sound_excess_db >= self.sound_awake_db
        crying = obs.cry_score >= self.cry_awake or obs.wake_sound
        moving_a_lot = obs.motion >= self.motion_awake
        stirring = obs.motion >= self.motion_restless or obs.motion_active

        if crying:
            return SleepState.AWAKE, min(1.0, 0.6 + obs.cry_score * 0.4), "crying"
        if moving_a_lot and loud:
            return SleepState.AWAKE, 0.9, "movement and noise"
        if moving_a_lot:
            return SleepState.AWAKE, 0.75, "sustained movement"

        # Nothing at all for a long time reads as an empty room, but only if
        # we have actually been watching — an outage must not become ABSENT.
        if (
            self._last_activity_ms is not None
            and obs.ts_ms - self._last_activity_ms >= self.absent_after_ms
            and not stirring
            and obs.video_ok
            and obs.motion <= 1e-6
        ):
            return SleepState.ABSENT, 0.5, "no activity for a long time"

        if stirring or loud:
            # Before sleep onset the same evidence means settling; after it,
            # restlessness. Same signal, different meaning.
            if self._sleep_onset_ms is None:
                return SleepState.SETTLING, 0.6, "active in bed"
            return SleepState.RESTLESS, 0.7, "stirring"

        return SleepState.ASLEEP, 0.8, "still and quiet"

    def _is_active(self, obs: Observation) -> bool:
        return (
            obs.motion >= self.motion_restless
            or obs.motion_active
            or obs.sound_excess_db >= self.sound_awake_db
            or obs.cry_score >= self.cry_awake
        )

    def _dwell_ms(self, current: SleepState, target: SleepState) -> int:
        """How long the evidence must persist for this particular transition."""
        # Waking should be responsive: a parent looking at the live view wants
        # to see "awake" while the child is still crying, not five minutes on.
        if target is SleepState.AWAKE:
            if current.counts_as_sleep:
                # From sleep, though, the bar is the actigraphy definition of
                # an awakening. Anything shorter is an arousal and stays
                # RESTLESS, which is what keeps the awakening count honest.
                return self.awakening_min_ms
            return int(30_000)
        if target is SleepState.ASLEEP:
            if current is SleepState.RESTLESS:
                # Settling back after a stir is quick.
                return int(90_000)
            # A first sleep onset needs a sustained quiet period.
            return self.onset_quiet_ms
        if target is SleepState.ABSENT:
            return int(120_000)
        if target is SleepState.RESTLESS:
            return int(45_000)
        return int(60_000)

    def _transition(
        self, ts_ms: int, target: SleepState, confidence: float, reason: str
    ) -> StateChange:
        previous = self.state
        # The state changed at the moment the evidence started, not when the
        # dwell timer expired. Otherwise every segment boundary is late by the
        # dwell time and the metrics inherit that error.
        effective_ms = self._candidate.since_ms if self._candidate else ts_ms

        self.state = target
        self.state_since_ms = effective_ms
        self._candidate = None
        self._confidence = confidence

        if target.counts_as_sleep and self._sleep_onset_ms is None:
            self._sleep_onset_ms = effective_ms
            log.info("sleep onset at %d", effective_ms)

        change = StateChange(effective_ms, previous, target, confidence, reason)
        self._history.append(change)
        log.debug("state %s -> %s (%s)", previous, target, reason)
        return change

    # -- session control ----------------------------------------------------

    def begin_night(self, ts_ms: int) -> None:
        """Reset the per-night state at the day boundary.

        ``_sleep_onset_ms`` in particular must not carry over, or the machine
        will treat the following evening's settling as post-onset restlessness.
        """
        self._sleep_onset_ms = None
        self._last_activity_ms = ts_ms
        self._candidate = None
        self._history.clear()

    @property
    def sleep_onset_ms(self) -> int | None:
        return self._sleep_onset_ms

    @property
    def confidence(self) -> float:
        return self._confidence

    def asleep_for_min(self, now_ms_value: int) -> float | None:
        if not self.state.counts_as_sleep or self.state_since_ms is None:
            return None
        return (now_ms_value - self.state_since_ms) / 60000.0

    def status(self) -> dict[str, Any]:
        return {
            "state": str(self.state),
            "since_ms": self.state_since_ms,
            "confidence": round(self._confidence, 2),
            "sleep_onset_ms": self._sleep_onset_ms,
            "pending": None if self._candidate is None else str(self._candidate.state),
        }


@dataclass(slots=True)
class SegmentBuilder:
    """Accumulates state changes into contiguous, non-overlapping segments.

    The hypnogram must have no gaps and no overlaps — the metrics assume it,
    and a gap silently becomes missing sleep. Segments are closed by the next
    one starting, and the final one by :meth:`close`.
    """

    child_id: int
    night_of: str
    segments: list[dict[str, Any]] = field(default_factory=list)
    _open: dict[str, Any] | None = None

    def push(self, ts_ms: int, state: SleepState, confidence: float) -> None:
        if self._open is not None:
            if self._open["state"] is state:
                return
            if ts_ms <= self._open["start_ms"]:
                # A change effective-dated before the current segment started
                # would create an inverted segment; extend instead.
                self._open["state"] = state
                self._open["confidence"] = confidence
                return
            self._open["end_ms"] = ts_ms
            self.segments.append(self._open)
        self._open = {
            "start_ms": ts_ms,
            "end_ms": ts_ms,
            "state": state,
            "confidence": confidence,
        }

    def close(self, ts_ms: int) -> list[dict[str, Any]]:
        if self._open is not None and ts_ms > self._open["start_ms"]:
            self._open["end_ms"] = ts_ms
            self.segments.append(self._open)
            self._open = None
        return self.segments
