"""Sound classification: what was that noise?

Two backends behind one interface.

**YAMNet** is a MobileNet-v1 trained on AudioSet, 521 classes, distributed as a
4 MB int8-quantised TFLite model. Its input is a *fixed* 15600 samples — 0.975 s
at 16 kHz — and, in the TFLite conversion, its only output is a ``(1, 521)``
score vector. (The three-output form with the 1024-d embedding described on the
model card belongs to the TF2 SavedModel, not this one.)

**Heuristic** is spectral rules: cry-band energy, periodicity, flatness. Less
accurate, no model file, negligible CPU, and always available. It is what runs
if the model is missing or the runtime will not import, so a fresh install
still detects crying before anyone has downloaded anything.

The class-score post-processing matters as much as the model. Scores for the
background classes — ``White noise``, ``Mechanical fan``, ``Air conditioning``,
``Silence`` and the rest — are zeroed before the dominant class is chosen.
Without that, a nursery sound machine produces confident ``White noise``
detections all night, and the first thing the detector does with them is open
an event.
"""

from __future__ import annotations

import csv
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..models import EventLabel
from .dsp import FrameAnalysis

log = logging.getLogger(__name__)

__all__ = [
    "CLASS_TO_LABEL",
    "YAMNET_INPUT_SAMPLES",
    "Classification",
    "Classifier",
    "HeuristicClassifier",
    "NullClassifier",
    "YamnetClassifier",
    "build_classifier",
]

#: YAMNet's input is exactly this many samples. Not a suggestion.
YAMNET_INPUT_SAMPLES = 15600

#: AudioSet display names mapped onto our event vocabulary. Verified against
#: the real ``yamnet_class_map.csv``; note that "Whimper (dog)" is a separate
#: class from "Whimper" and must not be treated as a child.
CLASS_TO_LABEL: dict[str, EventLabel] = {
    "Baby cry, infant cry": EventLabel.CRY,
    "Crying, sobbing": EventLabel.CRY,
    "Wail, moan": EventLabel.CRY,
    "Whimper": EventLabel.WHIMPER,
    "Screaming": EventLabel.SCREAM,
    "Shout": EventLabel.SCREAM,
    "Yell": EventLabel.SCREAM,
    "Children shouting": EventLabel.SCREAM,
    "Speech": EventLabel.TALK,
    "Child speech, kid speaking": EventLabel.TALK,
    "Conversation": EventLabel.TALK,
    "Babbling": EventLabel.TALK,
    "Hubbub, speech noise, speech babble": EventLabel.TALK,
    "Laughter": EventLabel.LAUGH,
    "Baby laughter": EventLabel.LAUGH,
    "Belly laugh": EventLabel.LAUGH,
    "Giggle": EventLabel.LAUGH,
    "Snoring": EventLabel.SNORE,
    "Snort": EventLabel.SNORE,
    "Breathing": EventLabel.SNORE,
    "Cough": EventLabel.COUGH,
    "Sneeze": EventLabel.SNEEZE,
    "Sniff": EventLabel.COUGH,
    "Hiccup": EventLabel.COUGH,
    "Door": EventLabel.DOOR,
    "Doorbell": EventLabel.DOOR,
    "Slam": EventLabel.DOOR,
}

#: Sounds that mean "a child is fussing but not yet crying". Kept apart from
#: the cry family so the timeline can distinguish grizzling from distress.
_FUSS_CLASSES = frozenset({"Whimper", "Sigh", "Groan", "Grunt"})


@dataclass(slots=True)
class Classification:
    """What a frame sounded like."""

    label: EventLabel
    confidence: float
    #: Top few raw class names and scores, kept on the event for inspection.
    classes: dict[str, float] = field(default_factory=dict)
    backend: str = "none"
    #: True when the frame was skipped because it was too quiet to be worth
    #: classifying, as opposed to classified and found to be nothing.
    gated: bool = False

    @property
    def is_wake_sound(self) -> bool:
        return self.label in (
            EventLabel.CRY,
            EventLabel.FUSS,
            EventLabel.WHIMPER,
            EventLabel.SCREAM,
            EventLabel.TALK,
        )


class Classifier(ABC):
    """A frame in, a label out."""

    name = "abstract"

    @abstractmethod
    def classify(self, frame: FrameAnalysis) -> Classification:
        ...

    def close(self) -> None:
        return None

    @property
    def available(self) -> bool:
        return True

    def describe(self) -> dict[str, Any]:
        return {"backend": self.name, "available": self.available}


class NullClassifier(Classifier):
    """Level-only detection: every audible frame is simply 'noise'."""

    name = "none"

    def classify(self, frame: FrameAnalysis) -> Classification:
        return Classification(EventLabel.NOISE, 0.0, backend=self.name)


# ---------------------------------------------------------------------------
# Heuristic
# ---------------------------------------------------------------------------


class HeuristicClassifier(Classifier):
    """Spectral rules, no model.

    An infant cry has a fundamental around 350-600 Hz, strong harmonics and a
    clearly periodic structure. Broadband room noise has none of those and a
    spectral flatness near one. That contrast is enough to separate "a child is
    crying" from "the fan is on" without any machine learning, which is exactly
    what a fallback needs to do.

    It will not distinguish a cough from a sneeze, and it does confuse an adult
    talking with a child talking. Those are acceptable losses for a path that
    always works.
    """

    name = "heuristic"

    def __init__(self, cry_threshold: float = 0.55) -> None:
        self.cry_threshold = cry_threshold

    def classify(self, frame: FrameAnalysis) -> Classification:
        f = frame.features

        if f.flatness > 0.5 and f.periodicity < 0.2:
            return Classification(
                EventLabel.NOISE, 0.2, {"broadband": round(f.flatness, 3)}, self.name
            )

        # Each term is 0..1; the product is deliberately conservative, so a
        # frame has to look like a cry in several independent ways at once.
        band = min(1.0, f.cry_band_ratio / 0.35)
        periodic = min(1.0, f.periodicity / 0.6)
        tonal = 1.0 - min(1.0, f.flatness / 0.4)
        pitch_fit = 0.0
        if f.pitch_hz is not None and 250.0 <= f.pitch_hz <= 900.0:
            # Peaks at 450 Hz, falls off either side of the cry range.
            pitch_fit = 1.0 - min(1.0, abs(f.pitch_hz - 450.0) / 450.0)

        score = (0.35 * band + 0.30 * periodic + 0.20 * tonal + 0.15 * pitch_fit)
        detail = {
            "cry_band_ratio": round(f.cry_band_ratio, 3),
            "periodicity": round(f.periodicity, 3),
            "flatness": round(f.flatness, 3),
            "pitch_hz": round(f.pitch_hz, 1) if f.pitch_hz else None,
            "score": round(score, 3),
        }

        if score >= self.cry_threshold:
            return Classification(EventLabel.CRY, score, detail, self.name)
        if score >= self.cry_threshold * 0.65:
            return Classification(EventLabel.FUSS, score, detail, self.name)
        if f.zero_crossing_rate > 0.15 and f.centroid_hz > 1800:
            # High zero-crossing rate with energy up top is fricative-heavy —
            # speech, or something scraping.
            return Classification(EventLabel.TALK, min(0.5, score + 0.1), detail, self.name)
        return Classification(EventLabel.NOISE, score, detail, self.name)


# ---------------------------------------------------------------------------
# YAMNet
# ---------------------------------------------------------------------------


class YamnetClassifier(Classifier):
    """AudioSet sound classification via TFLite."""

    name = "yamnet"

    def __init__(
        self,
        model_path: str | Path,
        class_map_path: str | Path,
        *,
        threads: int = 1,
        background_classes: list[str] | None = None,
        top_k: int = 5,
    ) -> None:
        self.model_path = Path(model_path)
        self.class_map_path = Path(class_map_path)
        self.top_k = top_k
        self._interpreter: Any = None
        self._input_index: int | None = None
        self._output_index: int | None = None
        self._names: list[str] = []
        self._background_mask: np.ndarray | None = None
        self._background_names = set(background_classes or ())
        self._threads = threads
        self._load()

    @property
    def available(self) -> bool:
        return self._interpreter is not None

    def _load(self) -> None:
        if not self.model_path.exists():
            raise FileNotFoundError(
                f"YAMNet model not found at {self.model_path}. Run "
                "`deploy/fetch-models.sh` (or `babymon-setup fetch-models`) to "
                "download it, or set audio.classifier.backend to 'heuristic'."
            )
        if not self.class_map_path.exists():
            raise FileNotFoundError(f"YAMNet class map not found at {self.class_map_path}")

        interpreter_cls = _load_interpreter_class()
        self._interpreter = interpreter_cls(
            model_path=str(self.model_path), num_threads=self._threads
        )
        self._interpreter.allocate_tensors()

        inputs = self._interpreter.get_input_details()
        outputs = self._interpreter.get_output_details()
        if not inputs or not outputs:
            raise RuntimeError(f"{self.model_path} exposes no input or output tensors")
        self._input_index = inputs[0]["index"]
        self._output_index = outputs[0]["index"]

        expected = int(np.prod(inputs[0]["shape"]))
        if expected != YAMNET_INPUT_SAMPLES:
            log.warning(
                "YAMNet input is %d samples, expected %d; framing will be adjusted",
                expected,
                YAMNET_INPUT_SAMPLES,
            )
        self._input_samples = expected

        self._names = _read_class_map(self.class_map_path)
        classes = int(outputs[0]["shape"][-1])
        if len(self._names) != classes:
            raise RuntimeError(
                f"class map has {len(self._names)} entries but the model outputs "
                f"{classes} scores; they are from different versions"
            )

        mask = np.ones(classes, dtype=np.float32)
        unknown = []
        for name in self._background_names:
            try:
                mask[self._names.index(name)] = 0.0
            except ValueError:
                unknown.append(name)
        if unknown:
            log.warning(
                "audio.detector.background_classes contains names that are not in the "
                "YAMNet class map and will have no effect: %s",
                ", ".join(sorted(unknown)),
            )
        self._background_mask = mask
        log.info(
            "loaded YAMNet (%d classes, %d background classes suppressed)",
            classes,
            classes - int(mask.sum()),
        )

    def classify(self, frame: FrameAnalysis) -> Classification:
        if self._interpreter is None:
            return Classification(EventLabel.UNKNOWN, 0.0, backend=self.name)

        waveform = _fit_length(frame.samples, self._input_samples)
        self._interpreter.set_tensor(self._input_index, waveform.reshape(1, -1))
        self._interpreter.invoke()
        scores = np.asarray(self._interpreter.get_tensor(self._output_index)).reshape(-1)

        if self._background_mask is not None:
            # Zeroing rather than subtracting: we do not want the sound machine
            # to influence the ranking at all, only to be unable to win it.
            scores = scores * self._background_mask

        order = np.argsort(scores)[::-1][: self.top_k]
        top = {self._names[i]: float(scores[i]) for i in order if scores[i] > 0.01}
        if not top:
            return Classification(EventLabel.NOISE, 0.0, {}, self.name)

        best_name = self._names[int(order[0])]
        best_score = float(scores[int(order[0])])
        label = self._to_label(best_name, top)
        return Classification(label, best_score, top, self.name)

    def _to_label(self, best_name: str, top: dict[str, float]) -> EventLabel:
        direct = CLASS_TO_LABEL.get(best_name)
        if direct is not None:
            # Whimper on its own is fussing; whimper alongside crying is crying.
            if direct is EventLabel.WHIMPER and _cry_weight(top) > top.get(best_name, 0.0):
                return EventLabel.CRY
            return direct
        if best_name in _FUSS_CLASSES:
            return EventLabel.FUSS
        return EventLabel.NOISE

    def close(self) -> None:
        self._interpreter = None

    def describe(self) -> dict[str, Any]:
        return {
            "backend": self.name,
            "available": self.available,
            "model": str(self.model_path),
            "classes": len(self._names),
            "threads": self._threads,
        }


def _cry_weight(top: dict[str, float]) -> float:
    return sum(
        score
        for name, score in top.items()
        if CLASS_TO_LABEL.get(name) in (EventLabel.CRY, EventLabel.SCREAM)
    )


def _fit_length(samples: np.ndarray, length: int) -> np.ndarray:
    """Trim or zero-pad to the model's fixed input length."""
    data = np.asarray(samples, dtype=np.float32)
    if data.size == length:
        return data
    if data.size > length:
        # Centre-crop: the middle of the analysis window is the part the level
        # measurement was dominated by.
        start = (data.size - length) // 2
        return data[start : start + length]
    padded = np.zeros(length, dtype=np.float32)
    padded[: data.size] = data
    return padded


def _read_class_map(path: Path) -> list[str]:
    """Read ``yamnet_class_map.csv``: index, mid, display_name."""
    names: list[str] = []
    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header and header[0].strip().lower() not in ("index", "0"):
            # No header row after all; the first line was data.
            fh.seek(0)
            reader = csv.reader(fh)
        for row in reader:
            if len(row) >= 3:
                names.append(row[2].strip())
    return names


def _load_interpreter_class() -> Any:
    """Find a TFLite runtime.

    ``ai-edge-litert`` is the current Google package; ``tflite_runtime`` is the
    older one, still what some Pi images carry; full TensorFlow works too and is
    what a desktop is most likely to have. Try all three before giving up.
    """
    errors: list[str] = []
    try:
        from ai_edge_litert.interpreter import Interpreter  # type: ignore[import-not-found]

        return Interpreter
    except ImportError as exc:
        errors.append(f"ai-edge-litert: {exc}")
    try:
        from tflite_runtime.interpreter import Interpreter  # type: ignore[import-not-found]

        return Interpreter
    except ImportError as exc:
        errors.append(f"tflite-runtime: {exc}")
    try:
        from tensorflow.lite import Interpreter  # type: ignore[import-not-found]

        return Interpreter
    except ImportError as exc:
        errors.append(f"tensorflow: {exc}")
    raise ImportError(
        "no TFLite runtime is available. Install one with "
        "`pip install ai-edge-litert`, or set audio.classifier.backend to "
        "'heuristic'. Tried: " + "; ".join(errors)
    )


# ---------------------------------------------------------------------------


def build_classifier(config: Any, background_classes: list[str] | None = None) -> Classifier:
    """Construct the configured classifier, degrading rather than failing.

    A missing model file or an absent runtime is a reason to fall back to the
    heuristic and say so, not a reason for the monitor not to start.
    """
    backend = config.backend
    if backend == "none":
        return NullClassifier()
    if backend == "heuristic":
        return HeuristicClassifier()
    try:
        return YamnetClassifier(
            config.model_path,
            config.class_map_path,
            threads=config.threads,
            background_classes=background_classes,
        )
    except (FileNotFoundError, ImportError, RuntimeError) as exc:
        log.warning("falling back to the heuristic classifier: %s", exc)
        return HeuristicClassifier()
