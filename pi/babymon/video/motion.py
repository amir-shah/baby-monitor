"""Motion and restlessness from the low-resolution luma stream.

This is video actigraphy: difference consecutive frames, count the pixels that
changed, aggregate into epochs, and read the result as movement. It is the same
technique validated against polysomnography for infant sleep staging, and it
works because a sleeping child is remarkably still and a waking one is not.

The hard part is night. Under infrared the auto-exposure drives analogue gain
to eight or sixteen times, and sensor shot noise alone will exceed a daytime
threshold. Four defences, in order of how much they matter:

1. **Count changed pixels, not mean squared error.** One hot pixel dominates a
   mean of squares; it barely moves a count.
2. **Spatially pool before differencing.** Block-averaging 320x240 down to
   40x30 cuts uncorrelated noise by roughly the block size while leaving a
   moving arm entirely intact. Far more effective than raising the threshold.
3. **Scale the threshold with gain.** Noise power tracks gain, so the bar has
   to as well.
4. **Discard the frame after an exposure change.** A gain or exposure step
   alters every pixel at once, which is indistinguishable from the whole scene
   moving.

None of this detects breathing, and it must never be presented as if it does.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .source import Frame

log = logging.getLogger(__name__)

__all__ = ["MotionDetector", "MotionReading", "MotionEvent"]

#: Side of the spatial pooling block, in low-res pixels.
POOL = 8


@dataclass(slots=True)
class MotionReading:
    ts_ms: int
    #: Fraction of pooled cells that changed, 0..1.
    score: float
    #: Whether motion is currently considered active (after hysteresis).
    active: bool
    threshold: float
    #: True when this frame was thrown away because the exposure changed.
    discarded: bool = False


@dataclass(slots=True)
class MotionEvent:
    start_ms: int
    end_ms: int | None = None
    peak_score: float = 0.0
    mean_score: float = 0.0
    frames: int = 0

    @property
    def duration_s(self) -> float:
        return 0.0 if self.end_ms is None else (self.end_ms - self.start_ms) / 1000.0


class MotionDetector:
    """Frame differencing with hysteresis, gain adaptation and masking."""

    def __init__(
        self,
        *,
        pixel_threshold: int = 18,
        on_threshold: float = 0.012,
        off_threshold: float = 0.005,
        min_on_s: float = 1.5,
        min_off_s: float = 8.0,
        warmup_s: float = 10.0,
        masks: list[list[float]] | None = None,
        gain_sensitivity: float = 0.5,
        epoch_s: float = 30.0,
    ) -> None:
        self.pixel_threshold = pixel_threshold
        self.on_threshold = on_threshold
        self.off_threshold = off_threshold
        self.min_on_s = min_on_s
        self.min_off_s = min_off_s
        self.warmup_s = warmup_s
        self.masks = masks or []
        self.gain_sensitivity = gain_sensitivity
        self.epoch_s = epoch_s

        self._previous: np.ndarray | None = None
        self._previous_meta: dict[str, Any] | None = None
        self._first_ms: int | None = None
        self._mask: np.ndarray | None = None
        self._mask_shape: tuple[int, int] | None = None

        self.active = False
        self._above_since_ms: int | None = None
        self._below_since_ms: int | None = None
        self._current: MotionEvent | None = None
        self._recent: deque[float] = deque(maxlen=64)
        # ~20 minutes at 5 fps: long enough that a restless spell cannot move
        # the baseline out from under itself, short enough to follow a change
        # in lighting or in how the child is lying.
        self._baseline_scores: deque[float] = deque(maxlen=6000)
        self._epoch: list[float] = field(default_factory=list)  # type: ignore[assignment]
        self._epoch = []
        self._epoch_start_ms: int | None = None
        self._discarded = 0
        self._frames = 0

    # -- main entry point ---------------------------------------------------

    def push(self, frame: Frame) -> tuple[MotionReading, MotionEvent | None]:
        """Process a frame. Returns the reading and any event that just closed."""
        self._frames += 1
        if self._first_ms is None:
            self._first_ms = frame.ts_ms

        pooled = self._pool(self._apply_mask(frame.luma.astype(np.int16)))

        warming = (frame.ts_ms - self._first_ms) / 1000.0 < self.warmup_s
        threshold = self._threshold_for(frame)

        if self._previous is None or self._previous.shape != pooled.shape:
            self._previous = pooled
            self._previous_meta = frame.meta
            return MotionReading(frame.ts_ms, 0.0, False, threshold, discarded=True), None

        if self._exposure_changed(frame.meta):
            # Every pixel moved because the camera changed, not the scene.
            self._previous = pooled
            self._previous_meta = frame.meta
            self._discarded += 1
            return MotionReading(frame.ts_ms, 0.0, self.active, threshold, discarded=True), None

        difference = np.abs(pooled - self._previous)
        changed = int(np.count_nonzero(difference > self.pixel_threshold))
        score = changed / max(1, difference.size)

        self._previous = pooled
        self._previous_meta = frame.meta
        self._recent.append(score)
        self._baseline_scores.append(score)
        self._accumulate_epoch(frame.ts_ms, score)

        if warming:
            return MotionReading(frame.ts_ms, score, False, threshold), None

        closed = self._update_state(frame.ts_ms, score, threshold)
        return MotionReading(frame.ts_ms, score, self.active, threshold), closed

    # -- internals ----------------------------------------------------------

    def _apply_mask(self, luma: np.ndarray) -> np.ndarray:
        """Zero out ignored rectangles — a mobile, a curtain, a humidifier."""
        if not self.masks:
            return luma
        shape = luma.shape
        if self._mask is None or self._mask_shape != shape:
            mask = np.ones(shape, dtype=np.int16)
            height, width = shape
            for rect in self.masks:
                x, y, w, h = rect
                x0, y0 = int(x * width), int(y * height)
                x1, y1 = int((x + w) * width), int((y + h) * height)
                mask[max(0, y0) : min(height, y1), max(0, x0) : min(width, x1)] = 0
            self._mask = mask
            self._mask_shape = shape
        return luma * self._mask

    @staticmethod
    def _pool(luma: np.ndarray) -> np.ndarray:
        """Block-average to suppress uncorrelated sensor noise."""
        height, width = luma.shape
        ph, pw = height // POOL, width // POOL
        if ph == 0 or pw == 0:
            return luma.astype(np.int16)
        trimmed = luma[: ph * POOL, : pw * POOL]
        return trimmed.reshape(ph, POOL, pw, POOL).mean(axis=(1, 3)).astype(np.int16)

    def _threshold_for(self, frame: Frame) -> float:
        """Raise the bar in proportion to analogue gain."""
        gain = 1.0
        if frame.meta:
            gain = float(frame.meta.get("analogue_gain") or 1.0)
        return self.on_threshold * (1.0 + self.gain_sensitivity * max(0.0, gain - 1.0))

    def _exposure_changed(self, meta: dict[str, Any] | None) -> bool:
        if not meta or not self._previous_meta:
            return False
        for key, tolerance in (("analogue_gain", 0.05), ("exposure_time", 0.05)):
            new = meta.get(key)
            old = self._previous_meta.get(key)
            if new is None or old is None or not old:
                continue
            if abs(float(new) - float(old)) / abs(float(old)) > tolerance:
                return True
        return False

    def _update_state(self, ts_ms: int, score: float, threshold: float) -> MotionEvent | None:
        off_threshold = threshold * (self.off_threshold / self.on_threshold)

        if not self.active:
            if score >= threshold:
                if self._above_since_ms is None:
                    self._above_since_ms = ts_ms
                # Sustained, not instantaneous: a single frame of noise that
                # survived pooling still should not open an event.
                if (ts_ms - self._above_since_ms) / 1000.0 >= self.min_on_s:
                    self.active = True
                    self._below_since_ms = None
                    self._current = MotionEvent(start_ms=self._above_since_ms)
                    self._above_since_ms = None
            else:
                self._above_since_ms = None
            if self._current is not None:
                self._current.frames += 1
                self._current.peak_score = max(self._current.peak_score, score)
            return None

        event = self._current
        if event is not None:
            event.frames += 1
            event.peak_score = max(event.peak_score, score)
            event.mean_score += (score - event.mean_score) / event.frames

        if score < off_threshold:
            if self._below_since_ms is None:
                self._below_since_ms = ts_ms
            if (ts_ms - self._below_since_ms) / 1000.0 >= self.min_off_s:
                self.active = False
                closed = self._current
                self._current = None
                if closed is not None:
                    closed.end_ms = self._below_since_ms
                self._below_since_ms = None
                return closed
        else:
            self._below_since_ms = None
        return None

    def _accumulate_epoch(self, ts_ms: int, score: float) -> None:
        if self._epoch_start_ms is None:
            self._epoch_start_ms = ts_ms
        self._epoch.append(score)
        if (ts_ms - self._epoch_start_ms) / 1000.0 >= self.epoch_s:
            self._epoch = self._epoch[-1:]
            self._epoch_start_ms = ts_ms

    # -- reporting ----------------------------------------------------------

    @property
    def recent_mean(self) -> float:
        """Mean score over the last few seconds, for the live view."""
        return float(np.mean(self._recent)) if self._recent else 0.0

    @property
    def baseline(self) -> float:
        """The score a *still* child produces in this particular room.

        Absolute cut points cannot work here. How much of the frame a child
        occupies depends on camera distance, lens and cot size, and the noise
        underneath depends on how dark the room is and therefore on analogue
        gain. A number tuned in one nursery is meaningless in the next.

        So, as with the audio noise floor, the baseline is learned: a low
        percentile of recent scores is what "still" looks like here, and
        activity is measured as excess above it.
        """
        if len(self._baseline_scores) < 32:
            return 0.0
        return float(np.percentile(np.fromiter(self._baseline_scores, dtype=np.float64), 20))

    def restlessness(self) -> str:
        """Coarse activity band, relative to the learned still baseline."""
        excess = max(0.0, self.recent_mean - self.baseline)
        if excess < self.on_threshold * 0.15:
            return "quiet"
        if excess < self.on_threshold * 2.0:
            return "restless"
        return "active"

    @property
    def restlessness_index(self) -> float:
        """Activity as a multiple of the on-threshold, clamped to 0..1.

        A single comparable number for the sleep state machine and the night
        timeline, independent of how the camera happens to be mounted.
        """
        excess = max(0.0, self.recent_mean - self.baseline)
        return min(1.0, excess / max(self.on_threshold * 4.0, 1e-9))

    def flush(self, ts_ms: int) -> MotionEvent | None:
        event = self._current
        self._current = None
        self.active = False
        if event is not None and event.end_ms is None:
            event.end_ms = ts_ms
        return event

    def status(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "score": round(self.recent_mean, 5),
            "baseline": round(self.baseline, 5),
            "restlessness": self.restlessness(),
            "restlessness_index": round(self.restlessness_index, 3),
            "frames": self._frames,
            "discarded_frames": self._discarded,
            "masks": len(self.masks),
        }


def is_dark(frame: Frame, threshold: int = 40) -> bool:
    """Whether the room reads as dark.

    Prefers the ISP's own lux estimate where the source provides one, because
    mean luma after auto-exposure has already been normalised and says more
    about the exposure than the room.
    """
    if frame.meta and frame.meta.get("lux") is not None:
        return float(frame.meta["lux"]) < 8.0
    return float(np.mean(frame.luma)) < threshold


class DayNightTracker:
    """Hysteresis and dwell around the day/night decision.

    A nightlight or a car's headlights sweeping the ceiling will otherwise flap
    the mode back and forth, and every switch changes the exposure, which reads
    as a frame of motion.
    """

    def __init__(self, dark_threshold: int = 40, dwell_s: float = 60.0) -> None:
        self.dark_threshold = dark_threshold
        self.dwell_s = dwell_s
        self.night = False
        self._candidate_since_ms: int | None = None

    def update(self, frame: Frame) -> bool:
        dark = is_dark(frame, self.dark_threshold)
        if dark == self.night:
            self._candidate_since_ms = None
            return self.night
        if self._candidate_since_ms is None:
            self._candidate_since_ms = frame.ts_ms
        elif (frame.ts_ms - self._candidate_since_ms) / 1000.0 >= self.dwell_s:
            self.night = dark
            self._candidate_since_ms = None
            log.info("switched to %s mode", "night" if dark else "day")
        return self.night
