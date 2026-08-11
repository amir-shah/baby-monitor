"""Microphone capture and framing.

Two backends, chosen at runtime:

* **sounddevice** (PortAudio) when it imports — a callback-driven capture with
  no polling loop.
* **arecord/ffmpeg subprocess** otherwise. Slower to start and one extra
  process, but it works on any system with ALSA and never needs a PortAudio
  build. This is the fallback that makes ``pip install`` enough.

Both feed the same lock-free-ish ring buffer, from which the analysis loop
pulls overlapping frames. The ring is also what the clip writer reaches back
into for an event's pre-roll: by the time a cry is *recognised* as a cry, the
first four seconds of it are already several seconds in the past, so they have
to have been kept.

One constraint that shapes everything: an ALSA capture device can be opened by
exactly one process. If the HomeKit bridge also wants the microphone, both must
open a ``dsnoop`` device instead — see ``deploy/asound.conf.example``.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..timeutil import now_ms

log = logging.getLogger(__name__)

__all__ = ["AudioCapture", "AudioRing", "CaptureError", "list_devices"]


class CaptureError(RuntimeError):
    """The microphone could not be opened or has stopped producing samples."""


@dataclass(slots=True)
class RingSnapshot:
    samples: np.ndarray
    end_ms: int
    sample_rate: int


class AudioRing:
    """Fixed-capacity circular buffer of float32 samples with timestamps.

    Writes come from the capture thread, reads from the analysis thread and
    occasionally the clip writer. A single lock guards the indices; the copies
    happen outside any audio callback, so a slow reader delays a clip rather
    than dropping audio.
    """

    def __init__(self, sample_rate: int, seconds: float) -> None:
        self.sample_rate = sample_rate
        self.capacity = max(sample_rate, int(sample_rate * seconds))
        self._buffer = np.zeros(self.capacity, dtype=np.float32)
        self._write = 0
        self._written = 0
        self._last_ms = 0
        self._lock = threading.Lock()

    def write(self, samples: np.ndarray, ts_ms: int | None = None) -> None:
        data = np.asarray(samples, dtype=np.float32).reshape(-1)
        if data.size == 0:
            return
        # Count what arrived, not what fitted. A single write larger than the
        # ring keeps only its tail, but the stream position has still advanced
        # by the whole of it, and readers address frames by that position.
        produced = data.size
        if data.size >= self.capacity:
            data = data[-self.capacity :]
        with self._lock:
            end = self._write + data.size
            if end <= self.capacity:
                self._buffer[self._write : end] = data
            else:
                split = self.capacity - self._write
                self._buffer[self._write :] = data[:split]
                self._buffer[: end - self.capacity] = data[split:]
            self._write = end % self.capacity
            self._written += produced
            self._last_ms = ts_ms if ts_ms is not None else now_ms()

    def latest(self, n: int) -> np.ndarray:
        """The most recent ``n`` samples, oldest first."""
        with self._lock:
            available = min(self._written, self.capacity)
            if available == 0:
                return np.zeros(0, dtype=np.float32)
            n = min(n, available)
            start = (self._write - n) % self.capacity
            if start + n <= self.capacity:
                return self._buffer[start : start + n].copy()
            first = self.capacity - start
            out = np.empty(n, dtype=np.float32)
            out[:first] = self._buffer[start:]
            out[first:] = self._buffer[: n - first]
            return out

    def ending_at(self, position: int, n: int) -> tuple[np.ndarray, int] | None:
        """``n`` samples ending at absolute sample index ``position``.

        Positions are counted from the start of the stream, so this addresses
        a specific stretch of audio rather than "the newest". That is the
        difference between an analysis loop that catches up and one that only
        appears to: reading the newest window while advancing a consumed
        counter re-analyses the same audio and never looks at the backlog at
        all, which is what this replaced.

        Returns the samples and the wall-clock time of the last of them,
        derived from the sample rate rather than from the clock — a frame from
        thirty seconds ago must not be stamped with now, or the event log puts
        a cry at the wrong minute. ``None`` when the request has already been
        overwritten or has not yet arrived.
        """
        if n <= 0:
            return None
        with self._lock:
            written, last_ms = self._written, self._last_ms
            if position > written or position < n:
                return None
            behind = written - position
            if behind + n > min(written, self.capacity):
                return None  # overwritten while we were away
            end = (self._write - behind) % self.capacity
            start = (end - n) % self.capacity
            if start + n <= self.capacity:
                out = self._buffer[start : start + n].copy()
            else:
                first = self.capacity - start
                out = np.empty(n, dtype=np.float32)
                out[:first] = self._buffer[start:]
                out[first:] = self._buffer[: n - first]
        return out, last_ms - int(behind * 1000 / self.sample_rate)

    def window(self, end_ms: int, duration_s: float) -> np.ndarray:
        """Samples covering ``duration_s`` ending at ``end_ms``.

        Used to reconstruct an event's audio after the fact. Returns whatever
        part of the requested window is still in the ring; a clip that asks for
        more history than the ring holds gets a short clip rather than an error.
        """
        with self._lock:
            last_ms = self._last_ms
            available = min(self._written, self.capacity)
        if available == 0:
            return np.zeros(0, dtype=np.float32)
        # How far back the requested end is from the newest sample.
        lag_samples = int(max(0.0, (last_ms - end_ms) / 1000.0) * self.sample_rate)
        want = int(duration_s * self.sample_rate)
        total = min(available, lag_samples + want)
        chunk = self.latest(total)
        if lag_samples <= 0:
            return chunk[-want:] if chunk.size > want else chunk
        cut = chunk.size - lag_samples
        if cut <= 0:
            return np.zeros(0, dtype=np.float32)
        return chunk[max(0, cut - want) : cut]

    @property
    def duration_s(self) -> float:
        return self.capacity / self.sample_rate

    @property
    def last_write_ms(self) -> int:
        with self._lock:
            return self._last_ms

    @property
    def total_written(self) -> int:
        with self._lock:
            return self._written


class AudioCapture:
    """Owns the microphone and hands out overlapping analysis frames."""

    def __init__(
        self,
        *,
        device: str = "default",
        sample_rate: int = 16000,
        channels: int = 1,
        frame_samples: int = 15600,
        hop_samples: int = 8000,
        ring_seconds: float = 30.0,
        backend: str | None = None,
    ) -> None:
        self.device = device
        self.sample_rate = sample_rate
        self.channels = channels
        self.frame_samples = frame_samples
        self.hop_samples = hop_samples
        self.ring = AudioRing(sample_rate, ring_seconds)

        self._backend = backend
        self._stream: Any = None
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._stop = threading.Event()
        self._running = False
        self._error: str | None = None
        self._frames_read = 0
        self._overruns = 0
        self._consumed = 0

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._stop.clear()
        self._error = None
        backend = self._backend or ("sounddevice" if _has_sounddevice() else "subprocess")
        try:
            if backend == "sounddevice":
                self._start_sounddevice()
            else:
                self._start_subprocess()
        except Exception as exc:
            self._error = str(exc)
            raise CaptureError(f"could not open audio device {self.device!r}: {exc}") from exc
        self._running = True
        self._backend = backend
        log.info(
            "audio capture started on %r via %s (%d Hz, %d ch)",
            self.device, backend, self.sample_rate, self.channels,
        )

    def _start_sounddevice(self) -> None:
        import sounddevice as sd

        def callback(indata: np.ndarray, frames: int, time_info: Any, status: Any) -> None:
            if status:
                # Input overflow means the callback fell behind; the samples are
                # already lost, so all we can do is count it for the health page.
                self._overruns += 1
            mono = indata[:, 0] if indata.ndim > 1 else indata
            self.ring.write(np.asarray(mono, dtype=np.float32))

        self._stream = sd.InputStream(
            device=None if self.device in ("default", "") else self.device,
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="float32",
            blocksize=self.hop_samples,
            callback=callback,
        )
        self._stream.start()

    def _start_subprocess(self) -> None:
        binary = shutil.which("arecord") or shutil.which("ffmpeg")
        if binary is None:
            raise CaptureError(
                "no audio backend available: install the `sounddevice` package, "
                "or make `arecord` (alsa-utils) or `ffmpeg` available on PATH"
            )
        if binary.endswith("arecord"):
            args = [
                binary, "-q", "-D", self.device, "-t", "raw", "-f", "S16_LE",
                "-r", str(self.sample_rate), "-c", str(self.channels), "-",
            ]
        else:
            args = [
                binary, "-hide_banner", "-loglevel", "error", "-f", "alsa",
                "-i", self.device, "-ar", str(self.sample_rate),
                "-ac", str(self.channels), "-f", "s16le", "-",
            ]
        self._process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._reader = threading.Thread(
            target=self._read_subprocess, name="audio-reader", daemon=True
        )
        self._reader.start()

    def _read_subprocess(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        chunk_bytes = self.hop_samples * 2 * self.channels
        scale = 1.0 / 32768.0
        while not self._stop.is_set():
            data = process.stdout.read(chunk_bytes)
            if not data:
                if not self._stop.is_set():
                    self._error = "capture process ended unexpectedly"
                    log.warning("audio capture process ended")
                break
            pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) * scale
            if self.channels > 1:
                pcm = pcm.reshape(-1, self.channels)[:, 0]
            self.ring.write(pcm)

    def stop(self) -> None:
        self._stop.set()
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._process is not None:
            self._process.terminate()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None
        if self._reader is not None:
            self._reader.join(timeout=2)
            self._reader = None

    # -- consumption --------------------------------------------------------

    def frames(self) -> Iterator[tuple[np.ndarray, int]]:
        """Yield ``(samples, end_ts_ms)`` frames at the configured hop.

        Paces itself against the ring rather than the clock: if the analysis
        loop falls behind it catches up by taking frames back to back, and if
        it is ahead it waits. A frame is skipped only when the ring has
        genuinely overrun, which is counted and surfaced on the health page.

        Frames are addressed by position, so catching up really does mean
        working through the backlog. Reading the newest window each time while
        advancing a consumed counter — which is what this did — analyses the
        same audio over and over, never looks at the audio it fell behind on,
        and stamps the whole burst with the current time, so a cry recovered
        after a stall is logged minutes from when it happened.
        """
        target = self.frame_samples
        #: Absolute sample index of the end of the last frame yielded; 0 until
        #: the first one, which ends at ``target``.
        reach = self.ring.capacity - target  # oldest whole frame still held
        while not self._stop.is_set():
            available = self.ring.total_written
            if available < target:
                time.sleep(0.05)
                continue
            if self._consumed == 0:
                self._consumed = target
                position = target
            else:
                behind = available - self._consumed
                if behind < self.hop_samples:
                    time.sleep(min(0.2, self.hop_samples / self.sample_rate / 2))
                    continue
                if behind > reach:
                    # We fell so far behind that the samples we wanted are
                    # gone. Jump to the oldest frame the ring can still serve.
                    self._overruns += 1
                    log.warning("audio analysis fell behind; skipped %d samples", behind - reach)
                    self._consumed = available - reach
                position = max(target, self._consumed + self.hop_samples)

            chunk = self.ring.ending_at(position, target)
            if chunk is None:
                # Overwritten between the check above and the read. Rare; drop
                # to the newest frame rather than spinning on a lost position.
                self._consumed = max(0, available - self.hop_samples)
                continue
            self._consumed = position
            self._frames_read += 1
            yield chunk

    def clip(self, end_ms: int, duration_s: float) -> np.ndarray:
        return self.ring.window(end_ms, duration_s)

    # -- status -------------------------------------------------------------

    @property
    def running(self) -> bool:
        # Two distinct reasons not to be running, kept apart because the
        # subprocess check only applies to one of the two backends.
        if not self._running:
            return False
        return not (self._process is not None and self._process.poll() is not None)

    @property
    def healthy(self) -> bool:
        """Producing samples recently, not merely open.

        A USB microphone that has been unplugged often leaves a stream object
        that reports itself as fine while delivering nothing.
        """
        if not self.running:
            return False
        last = self.ring.last_write_ms
        return last > 0 and (now_ms() - last) < 5000

    def status(self) -> dict[str, Any]:
        return {
            "backend": self._backend,
            "device": self.device,
            "running": self.running,
            "healthy": self.healthy,
            "sample_rate": self.sample_rate,
            "frames_read": self._frames_read,
            "overruns": self._overruns,
            "ring_seconds": round(self.ring.duration_s, 1),
            "last_sample_age_s": (
                round((now_ms() - self.ring.last_write_ms) / 1000.0, 1)
                if self.ring.last_write_ms
                else None
            ),
            "error": self._error,
        }


def _has_sounddevice() -> bool:
    try:
        import sounddevice  # noqa: F401
    except Exception:
        return False
    return True


def list_devices() -> list[dict[str, Any]]:
    """Enumerate capture devices, for the setup CLI and the System page."""
    devices: list[dict[str, Any]] = []
    try:
        import sounddevice as sd

        for index, info in enumerate(sd.query_devices()):
            if info.get("max_input_channels", 0) > 0:
                devices.append(
                    {
                        "index": index,
                        "name": info.get("name"),
                        "channels": info.get("max_input_channels"),
                        "default_samplerate": info.get("default_samplerate"),
                        "backend": "sounddevice",
                    }
                )
        return devices
    except Exception:
        pass
    arecord = shutil.which("arecord")
    if arecord is None:
        return devices
    try:
        output = subprocess.run(
            [arecord, "-l"], capture_output=True, text=True, timeout=5, check=False
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return devices
    for line in output.splitlines():
        if line.startswith("card "):
            devices.append({"name": line.strip(), "backend": "alsa"})
    return devices
