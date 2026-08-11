"""The sound-event state machine.

Frame scores are noisy; events are not. This turns one into the other:

.. code-block:: text

    frame (0.975 s, hop 0.5 s)
      -> level, A-weighted level, adaptive floor          (dsp)
      -> energy gate: excess >= 6 dB ? classify : skip
      -> background classes zeroed                        (classifier)
      -> median filter over 5 frames
      -> dual-condition hysteresis (level AND score)
      -> minimum duration -> cooldown -> merge -> emit

Every one of those steps exists because of a specific false positive or missed
detection found while simulating a realistic nursery night: a sound machine at
-42 dBFS, HVAC cutting in for a minute, a door slam, a thirty-second cry and a
three-second whimper.

**Median, not average, smoothing.** A door slam is one loud frame. A median of
five frames discards it outright; an average merely attenuates it, and also
smears the start and end of real events.

**Dual-condition hysteresis.** An event opens only when the level *and* the
class score are both above their upper thresholds, and closes when *either*
falls below its lower one. Level alone opens on the HVAC ramp. Score alone
opens on background misclassification. Requiring both opens on neither.

**Minimum duration.** Two seconds. Enough to reject a slam or a cough in the
hallway; short enough to catch a three-second whimper.

**The energy gate only applies while idle.** It exists to keep the CPU asleep
through the ninety percent of a night when nothing is happening, not to assert
that nothing is happening. Once an event is open, every frame is classified —
otherwise the quiet moment between two wails is scored as silence.

**Gated frames never enter the median.** They say nothing about what a sound
was, only that the room was quiet enough not to ask. Admitted as zeros, a
single stale one holds the median under the threshold long enough to miss a
short whimper entirely.

**Frames in the trailing merge window are not part of the event.** They are
kept only in case the event resumes. Counted, twenty seconds of room tone
after a three-second whimper out-votes the whimper and the event is logged as
"noise".

The dominant label is chosen by integrating each label's score across the whole
event rather than taking the peak frame, because a peak frame is exactly the
noisiest single observation available.
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..models import CRY_LABELS, EventLabel, Severity
from .classifier import Classification, Classifier
from .dsp import FrameAnalysis

log = logging.getLogger(__name__)

__all__ = ["DetectorState", "SoundEvent", "SoundEventDetector"]


@dataclass(slots=True)
class SoundEvent:
    """A completed (or in-progress) sound event."""

    start_ms: int
    end_ms: int | None = None
    label: EventLabel = EventLabel.NOISE
    confidence: float = 0.0
    peak_dbfs: float = -100.0
    mean_dbfs: float = -100.0
    floor_at_start_dbfs: float = -100.0
    frames: int = 0
    #: Accumulated score per label across the event, for choosing the winner.
    label_weights: dict[str, float] = field(default_factory=dict)
    #: Highest-scoring raw classifier classes seen, for the event's meta blob.
    top_classes: dict[str, float] = field(default_factory=dict)
    backend: str = "none"

    @property
    def duration_s(self) -> float:
        if self.end_ms is None:
            return 0.0
        return (self.end_ms - self.start_ms) / 1000.0

    @property
    def severity(self) -> Severity:
        """How loudly to surface this.

        Crying is an alert; anything else that suggests waking is a notice;
        everything else is a log line.
        """
        if self.label in CRY_LABELS:
            return Severity.ALERT if self.duration_s >= 20 else Severity.NOTICE
        if self.label in (EventLabel.TALK, EventLabel.SCREAM):
            return Severity.NOTICE
        return Severity.INFO

    def meta(self) -> dict[str, Any]:
        return {
            "classes": {k: round(v, 3) for k, v in sorted(
                self.top_classes.items(), key=lambda kv: kv[1], reverse=True
            )[:5]},
            "label_weights": {k: round(v, 3) for k, v in self.label_weights.items()},
            "floor_dbfs": round(self.floor_at_start_dbfs, 1),
            "frames": self.frames,
            "backend": self.backend,
        }


class DetectorState:
    IDLE = "idle"
    OPEN = "open"
    CLOSING = "closing"


class SoundEventDetector:
    """Feed it frames; it yields events.

    Stateful and single-threaded — one instance per microphone, driven from the
    audio thread.
    """

    def __init__(
        self,
        *,
        classifier: Classifier,
        on_db_above_floor: float = 10.0,
        off_db_above_floor: float = 5.0,
        score_on: float = 0.45,
        score_off: float = 0.30,
        score_high: float = 0.80,
        gate_db_above_floor: float = 6.0,
        min_duration_s: float = 2.0,
        merge_gap_s: float = 20.0,
        cooldown_s: float = 15.0,
        smoothing_frames: int = 5,
        label_thresholds: dict[str, float] | None = None,
        hop_s: float = 0.5,
    ) -> None:
        self.classifier = classifier
        self.on_db = on_db_above_floor
        self.off_db = off_db_above_floor
        self.score_on = score_on
        self.score_off = score_off
        self.score_high = score_high
        self.gate_db = gate_db_above_floor
        self.min_duration_s = min_duration_s
        self.merge_gap_s = merge_gap_s
        self.cooldown_s = cooldown_s
        self.label_thresholds = label_thresholds or {}
        self.hop_s = hop_s

        self.state = DetectorState.IDLE
        self._scores: deque[float] = deque(maxlen=max(1, smoothing_frames))
        self._current: SoundEvent | None = None
        self._below_since_ms: int | None = None
        self._last_emitted: SoundEvent | None = None
        self._cooldown_until_ms: dict[str, int] = {}
        self._classifications = 0
        self._gated = 0

    # -- main entry point ---------------------------------------------------

    def push(self, frame: FrameAnalysis) -> SoundEvent | None:
        """Process one frame. Returns a completed event, if one just finished."""
        classification = self._classify(frame)
        smoothed = self._smooth(classification.confidence, classification.gated)

        loud = frame.excess_db >= self.on_db
        quiet = frame.excess_db < self.off_db
        confident = smoothed >= self.score_on
        unconfident = smoothed < self.score_off

        if self.state is DetectorState.IDLE or self._current is None:
            # The ordinary path needs both conditions. The second clause is a
            # deliberate relaxation on a *different* axis: a sound the
            # classifier is highly confident about, audible at all, opens an
            # event even if it is a decibel or two under the level threshold.
            # That catches a quiet whimper next to a white-noise machine
            # without lowering the noise bar — broadband room noise never
            # scores anywhere near score_high, so this cannot readmit the HVAC
            # and sound-machine false positives the level threshold exists for.
            audible = frame.excess_db >= self.gate_db
            if (loud and confident) or (audible and smoothed >= self.score_high):
                self._open(frame, classification, smoothed)
            return None

        # Either condition falling below its lower threshold ends the event.
        if quiet or unconfident:
            if self._below_since_ms is None:
                self._below_since_ms = frame.ts_ms
            # Frames in the trailing window are provisional: the event may yet
            # resume, but these frames are *not* part of it and must not feed
            # its label, peak or mean. Twenty seconds of room tone after a
            # three-second whimper would otherwise out-vote the whimper and
            # the event would be logged as "noise".
            if (frame.ts_ms - self._below_since_ms) / 1000.0 >= self.merge_gap_s:
                return self._close(frame.ts_ms)
            return None

        self._below_since_ms = None
        self._accumulate(frame, classification, smoothed)
        return None

    def flush(self, ts_ms: int) -> SoundEvent | None:
        """Close any open event — on shutdown, or when audio drops out."""
        if self._current is None:
            return None
        return self._close(ts_ms, forced=True)

    # -- internals ----------------------------------------------------------

    def _classify(self, frame: FrameAnalysis) -> Classification:
        # The gate exists to keep the CPU asleep through the ninety-odd percent
        # of a night when the room is at its floor. It is *not* an assertion
        # that nothing is happening — so it only applies while idle. Once an
        # event is open every frame is classified, because a cry comes in
        # bursts and the quiet moment between two wails would otherwise be
        # scored as silence and drag the median down.
        if self.state is DetectorState.IDLE and frame.excess_db < self.gate_db:
            self._gated += 1
            return Classification(EventLabel.NOISE, 0.0, {}, "gated", gated=True)
        self._classifications += 1
        return self.classifier.classify(frame)

    def _smooth(self, score: float, gated: bool) -> float:
        """Median filter over the classifier score.

        A gated frame never enters the buffer. It carries no information about
        what the sound was — only that the room was quiet enough not to ask —
        and admitting it as a zero would let the silence between two wails
        out-vote the wails. A single stale zero left over from a quiet spell is
        enough to hold the median under the threshold for several frames, which
        is exactly long enough to miss a three-second whimper.
        """
        if gated:
            if not self._scores:
                return 0.0
            return float(np.median(np.fromiter(self._scores, dtype=np.float64)))
        self._scores.append(score)
        if len(self._scores) == 1:
            return score
        return float(np.median(np.fromiter(self._scores, dtype=np.float64)))

    def _open(self, frame: FrameAnalysis, classification: Classification, score: float) -> None:
        label = classification.label
        threshold = self.label_thresholds.get(str(label))
        if threshold is not None and score < threshold:
            # The class-specific bar is higher than the generic one; respect it.
            return
        until = self._cooldown_until_ms.get(str(label))
        if until is not None and frame.ts_ms < until:
            return

        # Reopening inside the merge window continues the previous event rather
        # than logging a second one — one fussing spell should be one row.
        previous = self._last_emitted
        if (
            previous is not None
            and previous.end_ms is not None
            and (frame.ts_ms - previous.end_ms) / 1000.0 < self.merge_gap_s
            and previous.label == label
        ):
            self._current = previous
            self._current.end_ms = None
            self._last_emitted = None
        else:
            self._current = SoundEvent(
                start_ms=frame.ts_ms,
                label=label,
                floor_at_start_dbfs=frame.floor_dbfs,
                backend=classification.backend,
            )
        self.state = DetectorState.OPEN
        self._below_since_ms = None
        self._accumulate(frame, classification, score)

    def _accumulate(
        self, frame: FrameAnalysis, classification: Classification, score: float
    ) -> None:
        event = self._current
        if event is None:
            return
        event.frames += 1
        event.peak_dbfs = max(event.peak_dbfs, frame.peak_dbfs)
        # Running mean over the frames seen so far.
        event.mean_dbfs = (
            frame.a_weighted_dbfs
            if event.frames == 1
            else event.mean_dbfs + (frame.a_weighted_dbfs - event.mean_dbfs) / event.frames
        )
        if not classification.gated:
            event.label_weights[str(classification.label)] = (
                event.label_weights.get(str(classification.label), 0.0) + score
            )
            for name, value in classification.classes.items():
                event.top_classes[name] = max(event.top_classes.get(name, 0.0), value)

    def _close(self, ts_ms: int, *, forced: bool = False) -> SoundEvent | None:
        event = self._current
        self._current = None
        self.state = DetectorState.IDLE
        self._below_since_ms = None
        self._scores.clear()
        if event is None:
            return None

        # The event ended when it fell quiet, not when the merge window expired.
        event.end_ms = ts_ms if forced else ts_ms - int(self.merge_gap_s * 1000)
        if event.end_ms <= event.start_ms:
            event.end_ms = event.start_ms + int(self.hop_s * 1000)

        if event.duration_s < self.min_duration_s:
            log.debug(
                "discarding a %.1fs event (below the %.1fs minimum)",
                event.duration_s,
                self.min_duration_s,
            )
            return None

        if event.label_weights:
            # Integrated score, not the peak frame: the peak frame is the
            # noisiest single observation available.
            best = max(event.label_weights.items(), key=lambda kv: kv[1])
            event.label = EventLabel(best[0])
            event.confidence = min(1.0, best[1] / max(1, event.frames))

        self._cooldown_until_ms[str(event.label)] = event.end_ms + int(self.cooldown_s * 1000)
        self._last_emitted = event
        return event

    @property
    def current(self) -> SoundEvent | None:
        return self._current

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "classifications": self._classifications,
            "gated_frames": self._gated,
            "gate_ratio": (
                self._gated / (self._gated + self._classifications)
                if (self._gated + self._classifications)
                else 0.0
            ),
            "open_event": None if self._current is None else self._current.start_ms,
        }


def summarise_labels(events: list[SoundEvent]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for event in events:
        counts[str(event.label)] += 1
    return dict(counts)
