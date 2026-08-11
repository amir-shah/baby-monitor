"""Short audio clips around events.

Continuous audio is never stored. It is a privacy liability in a child's
bedroom, it destroys SD cards, and it is not what anyone actually wants — the
question is "what was that noise at 2am?", which a ten-second clip answers
completely.

So the ring buffer keeps the last thirty seconds in memory, and when an event
closes, the four seconds before it started and the six after are encoded to a
small Opus file. Everything else is discarded as it ages out of the ring.

Because the clip has to include audio from *before* the event was recognised,
it can only be written once the event ends, reaching backwards into the ring.
That is the whole reason the ring exists.
"""

from __future__ import annotations

import logging
import shutil
import struct
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

__all__ = ["ClipWriter", "ClipResult"]


@dataclass(slots=True)
class ClipResult:
    rel_path: str
    mime: str
    bytes: int
    duration_s: float


class ClipWriter:
    """Encodes ring-buffer audio to a file under the media directory."""

    #: Preference order when the configured encoder is unavailable. WAV is last
    #: and always works, at roughly twenty times the size.
    _MIME = {"opus": "audio/ogg", "aac": "audio/mp4", "wav": "audio/wav"}

    def __init__(
        self,
        media_dir: str | Path,
        *,
        sample_rate: int = 16000,
        fmt: str = "opus",
        bitrate_kbps: int = 32,
    ) -> None:
        self.media_dir = Path(media_dir)
        self.sample_rate = sample_rate
        self.bitrate_kbps = bitrate_kbps
        self.format = self._resolve_format(fmt)
        (self.media_dir / "clips").mkdir(parents=True, exist_ok=True)

    def _resolve_format(self, fmt: str) -> str:
        if fmt == "wav":
            return "wav"
        if shutil.which("ffmpeg") is None:
            log.warning(
                "ffmpeg is not on PATH; audio clips will be written as WAV, which is "
                "about twenty times larger than %s",
                fmt,
            )
            return "wav"
        return fmt

    def write(
        self, samples: np.ndarray, *, night_of: str, event_id: int, ts_ms: int
    ) -> ClipResult | None:
        """Encode a clip. Returns None rather than raising if encoding fails."""
        if samples.size == 0:
            return None
        duration = samples.size / self.sample_rate

        directory = self.media_dir / "clips" / night_of
        directory.mkdir(parents=True, exist_ok=True)
        suffix = {"opus": "opus", "aac": "m4a", "wav": "wav"}[self.format]
        filename = f"event-{event_id}-{ts_ms}.{suffix}"
        path = directory / filename
        rel_path = str(path.relative_to(self.media_dir))

        try:
            if self.format == "wav":
                self._write_wav(path, samples)
            else:
                self._encode(path, samples)
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("could not write audio clip %s: %s", path, exc)
            path.unlink(missing_ok=True)
            return None

        if not path.exists() or path.stat().st_size == 0:
            log.warning("audio clip %s came out empty", path)
            path.unlink(missing_ok=True)
            return None

        return ClipResult(
            rel_path=rel_path,
            mime=self._MIME[self.format],
            bytes=path.stat().st_size,
            duration_s=duration,
        )

    def _write_wav(self, path: Path, samples: np.ndarray) -> None:
        pcm = np.clip(samples, -1.0, 1.0)
        data = (pcm * 32767.0).astype("<i2").tobytes()
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(self.sample_rate)
            handle.writeframes(data)

    def _encode(self, path: Path, samples: np.ndarray) -> None:
        """Pipe raw PCM through ffmpeg.

        Feeding via stdin rather than writing a temporary WAV keeps a
        several-times-a-night operation off the SD card entirely.
        """
        codec = "libopus" if self.format == "opus" else "aac"
        args = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "f32le", "-ar", str(self.sample_rate), "-ac", "1", "-i", "pipe:0",
            "-c:a", codec, "-b:a", f"{self.bitrate_kbps}k",
        ]
        if self.format == "opus":
            # Opus resamples internally to 48 kHz; being explicit avoids a
            # warning and makes the container's timestamps come out right.
            args += ["-ar", "48000", "-application", "voip"]
        args.append(str(path))

        payload = np.clip(samples, -1.0, 1.0).astype("<f4").tobytes()
        result = subprocess.run(
            args, input=payload, capture_output=True, timeout=30, check=False
        )
        if result.returncode != 0:
            raise subprocess.SubprocessError(
                result.stderr.decode("utf-8", "replace").strip()[:300] or "ffmpeg failed"
            )


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Cheap linear resample, for a mic that will not run at 16 kHz.

    Linear interpolation is not a good anti-aliasing resampler. It is used only
    on the clip-writing path, where the output is a lossy voice codec anyway
    and the alternative is a scipy dependency. Analysis always runs at the
    capture rate.
    """
    if source_rate == target_rate or samples.size == 0:
        return samples
    duration = samples.size / source_rate
    target_n = int(duration * target_rate)
    if target_n <= 0:
        return np.zeros(0, dtype=np.float32)
    source_positions = np.linspace(0, samples.size - 1, num=target_n, dtype=np.float64)
    return np.interp(
        source_positions, np.arange(samples.size, dtype=np.float64), samples
    ).astype(np.float32)


def pcm16_bytes(samples: np.ndarray) -> bytes:
    """Little-endian signed 16-bit PCM, for anything that wants raw bytes."""
    clipped = np.clip(samples, -1.0, 1.0)
    return struct.pack(f"<{clipped.size}h", *(clipped * 32767).astype(np.int16))
