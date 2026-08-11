"""Signal processing for the nursery microphone.

Three ideas do most of the work here, and all three exist because of one piece
of furniture: the white-noise machine that is running in most nurseries.

**Never threshold on absolute level.** A sound machine raises the room's floor
by twenty to thirty decibels. Any fixed dBFS threshold is then either
permanently tripped or permanently deaf. Everything downstream thresholds on
*excess over an adaptive floor* instead, which is the single most important
decision in the audio path.

**Track the floor as a low percentile, not a mean.** A mean is dragged upward
by the very events we are trying to detect; the twentieth percentile over five
minutes is not. Five minutes is also long enough that a thirty-second cry
cannot move the floor out from under itself, and short enough that switching
the sound machine on re-converges within a couple of minutes.

**Measure A-weighted.** Traffic rumble and HVAC are mostly below 200 Hz, where
A-weighting attenuates by twenty to forty decibels. Weighting the level is a
free way to stop reacting to lorries going past.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

__all__ = [
    "dbfs",
    "a_weight_filter",
    "AWeighting",
    "spectral_features",
    "SpectralFeatures",
    "NoiseFloor",
    "FrameAnalysis",
    "analyse_frame",
]

#: Level reported for digital silence. Real silence is -inf dBFS, which breaks
#: every downstream average, so it is clamped to something a percentile can use.
SILENCE_DBFS = -100.0


def dbfs(samples: np.ndarray) -> float:
    """RMS level of a float32 [-1, 1] frame, in dBFS."""
    if samples.size == 0:
        return SILENCE_DBFS
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if rms <= 1e-10:
        return SILENCE_DBFS
    return max(SILENCE_DBFS, 20.0 * math.log10(rms))


def peak_dbfs(samples: np.ndarray) -> float:
    if samples.size == 0:
        return SILENCE_DBFS
    peak = float(np.max(np.abs(samples)))
    if peak <= 1e-10:
        return SILENCE_DBFS
    return max(SILENCE_DBFS, 20.0 * math.log10(peak))


# ---------------------------------------------------------------------------
# A-weighting
# ---------------------------------------------------------------------------


def a_weight_filter(freqs: np.ndarray) -> np.ndarray:
    """A-weighting gain (linear, not dB) at each frequency.

    The IEC 61672-1 analogue design, evaluated directly in the frequency domain
    because we already have a spectrum. Applying it as a spectral mask is
    exact enough for a level measurement and avoids the numerical trouble of
    running a fourth-order IIR at 16 kHz in Python.
    """
    f = np.maximum(freqs, 1e-6)
    f2 = f * f
    numerator = (12194.0**2) * f2 * f2
    denominator = (
        (f2 + 20.6**2)
        * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2))
        * (f2 + 12194.0**2)
    )
    weight = numerator / np.maximum(denominator, 1e-30)
    # +2.00 dB normalisation so the response is unity at 1 kHz.
    return weight * (10.0 ** (1.9997 / 20.0))


class AWeighting:
    """Cached A-weighting mask for a fixed FFT size."""

    def __init__(self, sample_rate: int, n_fft: int) -> None:
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
        self.gain = a_weight_filter(freqs).astype(np.float32)

    def level_dbfs(self, magnitude: np.ndarray) -> float:
        """A-weighted level from a magnitude spectrum."""
        weighted = magnitude * self.gain
        power = float(np.sum(np.square(weighted, dtype=np.float64)))
        if power <= 1e-20:
            return SILENCE_DBFS
        # Parseval, with the same normalisation as the unweighted RMS so the
        # two levels are directly comparable.
        rms = math.sqrt(power * 2.0) / self.n_fft
        if rms <= 1e-10:
            return SILENCE_DBFS
        return max(SILENCE_DBFS, 20.0 * math.log10(rms))


# ---------------------------------------------------------------------------
# Spectral features
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SpectralFeatures:
    centroid_hz: float
    #: Geometric mean over arithmetic mean of the spectrum, 0..1. Near 1 means
    #: broadband noise (a sound machine, a fan); a voiced cry is near 0. This is
    #: the cheapest reliable white-noise discriminator available.
    flatness: float
    #: Fraction of energy in 300-600 Hz, where an infant cry's fundamental sits.
    cry_band_ratio: float
    zero_crossing_rate: float
    #: Strength of the strongest autocorrelation peak in the pitch range, 0..1.
    #: A cry is strongly periodic; noise is not.
    periodicity: float
    pitch_hz: float | None


def spectral_features(
    samples: np.ndarray, magnitude: np.ndarray, sample_rate: int
) -> SpectralFeatures:
    """Cheap frame-level descriptors, computed from an existing spectrum."""
    freqs = np.fft.rfftfreq(len(samples), d=1.0 / sample_rate)
    power = np.square(magnitude, dtype=np.float64)
    total = float(np.sum(power))

    if total <= 1e-20:
        return SpectralFeatures(0.0, 1.0, 0.0, 0.0, 0.0, None)

    centroid = float(np.sum(freqs * power) / total)

    positive = power[power > 0]
    if positive.size > 1:
        log_mean = float(np.mean(np.log(positive)))
        arithmetic_mean = float(np.mean(positive))
        flatness = math.exp(log_mean) / arithmetic_mean if arithmetic_mean > 0 else 1.0
    else:
        flatness = 1.0

    band = (freqs >= 300.0) & (freqs <= 600.0)
    cry_ratio = float(np.sum(power[band]) / total)

    signs = np.signbit(samples)
    zcr = float(np.count_nonzero(signs[1:] != signs[:-1])) / max(1, len(samples) - 1)

    periodicity, pitch = _pitch(samples, sample_rate)

    return SpectralFeatures(
        centroid_hz=centroid,
        flatness=min(1.0, max(0.0, flatness)),
        cry_band_ratio=cry_ratio,
        zero_crossing_rate=zcr,
        periodicity=periodicity,
        pitch_hz=pitch,
    )


def _pitch(samples: np.ndarray, sample_rate: int) -> tuple[float, float | None]:
    """Autocorrelation pitch estimate over the 80-1000 Hz range."""
    if samples.size < 512:
        return 0.0, None
    centred = samples - float(np.mean(samples))
    energy = float(np.dot(centred, centred))
    if energy <= 1e-12:
        return 0.0, None
    # Only the first ~1/80 s of lag is needed, so correlate a truncated window.
    max_lag = min(len(centred) - 1, int(sample_rate / 80))
    min_lag = max(1, int(sample_rate / 1000))
    if max_lag <= min_lag:
        return 0.0, None
    segment = centred[: min(len(centred), max_lag * 4)]
    correlation = np.correlate(segment, segment, mode="full")[len(segment) - 1 :]
    if correlation.size <= max_lag or correlation[0] <= 0:
        return 0.0, None
    normalised = correlation[min_lag : max_lag + 1] / correlation[0]
    if normalised.size == 0:
        return 0.0, None
    best = int(np.argmax(normalised))
    strength = float(normalised[best])
    if strength <= 0:
        return 0.0, None
    lag = best + min_lag
    return min(1.0, strength), sample_rate / lag if lag > 0 else None


# ---------------------------------------------------------------------------
# Adaptive noise floor
# ---------------------------------------------------------------------------


class NoiseFloor:
    """Rolling low-percentile estimate of the room's background level.

    Bounded by ``min_dbfs``/``max_dbfs`` so a dead microphone (a floor pinned at
    silence, making everything look like an event) or a wedged one (a floor so
    high nothing can exceed it) is caught rather than believed.
    """

    def __init__(
        self,
        window_s: float = 300.0,
        percentile: float = 20.0,
        min_dbfs: float = -75.0,
        max_dbfs: float = -25.0,
        hop_s: float = 0.5,
    ) -> None:
        self.percentile = percentile
        self.min_dbfs = min_dbfs
        self.max_dbfs = max_dbfs
        capacity = max(8, int(window_s / max(hop_s, 0.01)))
        self._samples: deque[float] = deque(maxlen=capacity)
        self._cached: float | None = None
        self._dirty = True

    def update(self, level_dbfs: float) -> float:
        self._samples.append(level_dbfs)
        self._dirty = True
        return self.value

    @property
    def value(self) -> float:
        if not self._samples:
            return self.min_dbfs
        if self._dirty or self._cached is None:
            # Recomputing a percentile over ~600 floats twice a second is
            # cheaper than maintaining a sorted structure, and far easier to
            # reason about.
            raw = float(np.percentile(np.fromiter(self._samples, dtype=np.float64), self.percentile))
            self._cached = min(self.max_dbfs, max(self.min_dbfs, raw))
            self._dirty = False
        return self._cached

    @property
    def ready(self) -> bool:
        """Whether enough history has accumulated for the floor to mean anything."""
        return len(self._samples) >= max(8, (self._samples.maxlen or 8) // 10)

    @property
    def saturated(self) -> bool:
        """True when the raw estimate is pinned at a bound — usually a broken mic."""
        if not self._samples:
            return False
        raw = float(np.percentile(np.fromiter(self._samples, dtype=np.float64), self.percentile))
        return raw <= self.min_dbfs or raw >= self.max_dbfs

    def reset(self) -> None:
        self._samples.clear()
        self._cached = None
        self._dirty = True


# ---------------------------------------------------------------------------
# Frame analysis
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class FrameAnalysis:
    ts_ms: int
    level_dbfs: float
    peak_dbfs: float
    a_weighted_dbfs: float
    floor_dbfs: float
    excess_db: float
    features: SpectralFeatures
    #: The frame's samples, kept so the classifier can run on the same window
    #: without a second copy of the framing logic.
    samples: np.ndarray

    @property
    def is_broadband(self) -> bool:
        """Looks like a fan or a sound machine rather than a voice."""
        return self.features.flatness > 0.35 and self.features.periodicity < 0.25


def analyse_frame(
    samples: np.ndarray,
    *,
    ts_ms: int,
    sample_rate: int,
    floor: NoiseFloor,
    weighting: AWeighting | None,
    gain_db: float = 0.0,
) -> FrameAnalysis:
    """Level, spectrum and floor for one analysis frame."""
    if gain_db:
        samples = samples * (10.0 ** (gain_db / 20.0))
        np.clip(samples, -1.0, 1.0, out=samples)

    window = np.hanning(len(samples)).astype(np.float32)
    magnitude = np.abs(np.fft.rfft(samples * window))

    level = dbfs(samples)
    weighted = weighting.level_dbfs(magnitude) if weighting is not None else level
    # The floor tracks whichever level the detector will threshold on, so the
    # two cannot drift apart.
    floor_value = floor.update(weighted)

    return FrameAnalysis(
        ts_ms=ts_ms,
        level_dbfs=level,
        peak_dbfs=peak_dbfs(samples),
        a_weighted_dbfs=weighted,
        floor_dbfs=floor_value,
        excess_db=weighted - floor_value,
        features=spectral_features(samples, magnitude, sample_rate),
        samples=samples,
    )
