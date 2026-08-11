"""Camera sources.

A libcamera device can be opened by exactly one process, and this project has
four consumers: the HomeKit live stream, HomeKit Secure Video, motion analysis
and dashboard snapshots. The resolution is to not open the camera here at all
in the normal case — MediaMTX owns it, publishes a full-resolution H.264 path
and a low-resolution secondary path, and everything else pulls RTSP from
localhost. That also buys fault isolation: a bug in the Python motion code
cannot take the video pipeline down with it.

The sources below therefore serve two purposes: pulling frames from that RTSP
hub for analysis, and covering the setups where MediaMTX is not in the picture
(a USB webcam, a development laptop, CI).

===========  ==============================================================
picamera2    The Pi camera stack directly. Used when MediaMTX is not running.
             Main stream for snapshots, ``lores`` stream for motion — one
             camera open, two resolutions, which is libcamera's own facility.
v4l2         A USB webcam through OpenCV.
rtsp         Pull from MediaMTX or any other RTSP camera. The default.
file         Loop a video file. For development.
synthetic    A generated scene with a slowly breathing shape. For CI, and for
             seeing the dashboard work before any hardware exists.
===========  ==============================================================
"""

from __future__ import annotations

import logging
import math
import shutil
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..timeutil import now_ms

log = logging.getLogger(__name__)

__all__ = ["Frame", "VideoSource", "build_source", "encode_jpeg"]


@dataclass(slots=True)
class Frame:
    """One captured frame.

    ``luma`` is the low-resolution grey plane used for motion analysis;
    ``jpeg`` is filled lazily and only when something actually asks for a
    snapshot, because encoding one on every frame would dominate the CPU cost
    of the whole analysis loop.
    """

    ts_ms: int
    luma: np.ndarray
    width: int
    height: int
    jpeg: bytes | None = None
    #: ISP metadata where the source provides it — lux, gain, exposure. Used
    #: for day/night detection and for gain-adaptive motion thresholds.
    meta: dict[str, Any] | None = None


class VideoSource(ABC):
    """A source of frames, plus a snapshot path."""

    name = "abstract"

    def __init__(self, width: int, height: int, lores_width: int, lores_height: int) -> None:
        self.width = width
        self.height = height
        self.lores_width = lores_width
        self.lores_height = lores_height
        self._last_frame: Frame | None = None
        self._error: str | None = None
        self._lock = threading.Lock()

    @abstractmethod
    def open(self) -> None:
        ...

    @abstractmethod
    def read(self) -> Frame | None:
        ...

    def close(self) -> None:
        return None

    def snapshot_jpeg(self, width: int | None = None, height: int | None = None) -> bytes | None:
        """Most recent frame as JPEG, scaled if asked."""
        with self._lock:
            frame = self._last_frame
        if frame is None:
            return None
        if frame.jpeg is not None and width is None and height is None:
            return frame.jpeg
        return encode_jpeg(frame, width, height)

    def _store(self, frame: Frame) -> Frame:
        with self._lock:
            self._last_frame = frame
        return frame

    @property
    def last_frame(self) -> Frame | None:
        with self._lock:
            return self._last_frame

    @property
    def healthy(self) -> bool:
        frame = self.last_frame
        return frame is not None and (now_ms() - frame.ts_ms) < 10_000

    def status(self) -> dict[str, Any]:
        frame = self.last_frame
        return {
            "source": self.name,
            "healthy": self.healthy,
            "resolution": f"{self.width}x{self.height}",
            "last_frame_age_s": (
                None if frame is None else round((now_ms() - frame.ts_ms) / 1000, 1)
            ),
            "error": self._error,
        }


# ---------------------------------------------------------------------------
# ffmpeg-backed sources (rtsp, file)
# ---------------------------------------------------------------------------


class FfmpegSource(VideoSource):
    """Decode an RTSP or file input to raw grey frames via ffmpeg.

    Only the luma plane at analysis resolution is decoded — we ask ffmpeg for
    ``gray`` at the low resolution and a low frame rate, so a 1080p30 source
    costs almost nothing to analyse. Snapshots come from a separate one-shot
    ffmpeg against the same URL, which is rare enough not to matter.
    """

    name = "ffmpeg"

    def __init__(
        self,
        url: str,
        width: int,
        height: int,
        lores_width: int,
        lores_height: int,
        *,
        fps: float = 5.0,
        loop: bool = False,
        rtsp_transport: str = "tcp",
    ) -> None:
        super().__init__(width, height, lores_width, lores_height)
        self.url = url
        self.fps = fps
        self.loop = loop
        self.rtsp_transport = rtsp_transport
        self._process: subprocess.Popen[bytes] | None = None
        self._frame_bytes = lores_width * lores_height

    def open(self) -> None:
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("ffmpeg is required for the rtsp and file camera sources")
        args = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
        if self.url.startswith("rtsp://"):
            # UDP loses packets on a busy Pi and produces torn frames; the
            # source is on localhost anyway, so TCP costs nothing.
            args += ["-rtsp_transport", self.rtsp_transport]
        if self.loop:
            args += ["-stream_loop", "-1"]
        args += [
            "-i", self.url,
            "-an", "-sn",
            "-vf", f"fps={self.fps},scale={self.lores_width}:{self.lores_height}",
            "-pix_fmt", "gray",
            "-f", "rawvideo", "pipe:1",
        ]
        self._process = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=self._frame_bytes * 4
        )
        self._error = None

    def read(self) -> Frame | None:
        process = self._process
        if process is None or process.stdout is None:
            return None
        data = process.stdout.read(self._frame_bytes)
        if not data or len(data) < self._frame_bytes:
            self._error = "video stream ended"
            return None
        luma = np.frombuffer(data, dtype=np.uint8).reshape(self.lores_height, self.lores_width)
        return self._store(
            Frame(ts_ms=now_ms(), luma=luma, width=self.lores_width, height=self.lores_height)
        )

    def snapshot_jpeg(self, width: int | None = None, height: int | None = None) -> bytes | None:
        """Grab a full-resolution still directly from the source.

        The analysis stream is 320x240 grey, which is not something anyone
        wants to look at. A one-shot ffmpeg against the same URL gives a real
        colour frame at full resolution.
        """
        if shutil.which("ffmpeg") is None:
            return super().snapshot_jpeg(width, height)
        target_w = width or self.width
        target_h = height or self.height
        args = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
        if self.url.startswith("rtsp://"):
            args += ["-rtsp_transport", self.rtsp_transport]
        args += [
            "-i", self.url, "-frames:v", "1",
            "-vf", f"scale={target_w}:{target_h}",
            "-q:v", "4", "-f", "mjpeg", "pipe:1",
        ]
        try:
            result = subprocess.run(args, capture_output=True, timeout=6, check=False)
        except (subprocess.SubprocessError, OSError) as exc:
            log.debug("snapshot failed: %s", exc)
            return super().snapshot_jpeg(width, height)
        if result.returncode != 0 or not result.stdout:
            return super().snapshot_jpeg(width, height)
        return result.stdout

    def close(self) -> None:
        if self._process is not None:
            self._process.terminate()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None


# ---------------------------------------------------------------------------
# picamera2
# ---------------------------------------------------------------------------


class Picamera2Source(VideoSource):
    """The Pi camera stack directly, with a main and a lores stream.

    Only used when MediaMTX is not managing the camera. The lores stream is
    where motion analysis reads from; slicing it to ``[:h, :w]`` is not
    optional, because the buffer is stride-aligned and wider than requested —
    and that slice happens to extract exactly the Y plane of the YUV420 frame,
    which is what motion wants.
    """

    name = "picamera2"

    def __init__(
        self,
        width: int,
        height: int,
        lores_width: int,
        lores_height: int,
        *,
        fps: int = 15,
        rotation: int = 0,
        hflip: bool = False,
        vflip: bool = False,
        tuning_file: str | None = None,
    ) -> None:
        super().__init__(width, height, lores_width, lores_height)
        self.fps = fps
        self.rotation = rotation
        self.hflip = hflip
        self.vflip = vflip
        self.tuning_file = tuning_file
        self._camera: Any = None

    def open(self) -> None:
        try:
            from libcamera import Transform  # type: ignore[import-not-found]
            from picamera2 import Picamera2  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "picamera2 is not available. It is an apt package, not a pip one: "
                "`sudo apt install python3-picamera2`, and the venv must have been "
                "created with --system-site-packages for it to be importable."
            ) from exc

        tuning = None
        if self.tuning_file:
            tuning = Picamera2.load_tuning_file(self.tuning_file)
        self._camera = Picamera2(tuning=tuning) if tuning else Picamera2()

        transform = Transform(hflip=int(self.hflip), vflip=int(self.vflip))
        if self.rotation == 180:
            transform = Transform(hflip=1, vflip=1)

        config = self._camera.create_video_configuration(
            main={"size": (self.width, self.height), "format": "YUV420"},
            lores={"size": (self.lores_width, self.lores_height), "format": "YUV420"},
            transform=transform,
            controls={
                # Cap the frame duration. Left unbounded, auto-exposure in a
                # dark nursery picks a 200 ms exposure, the stream silently
                # drops to 5 fps and every frame is motion-blurred.
                "FrameDurationLimits": (int(1e6 / self.fps), int(1e6 / max(1, self.fps // 2))),
            },
        )
        self._camera.configure(config)
        self._camera.start()
        self._error = None
        log.info("picamera2 started at %dx%d (lores %dx%d)", self.width, self.height,
                 self.lores_width, self.lores_height)

    def read(self) -> Frame | None:
        if self._camera is None:
            return None
        try:
            array = self._camera.capture_array("lores")
            metadata = self._camera.capture_metadata()
        except Exception as exc:
            self._error = str(exc)
            return None
        # Stride padding: the buffer is wider than requested. This slice both
        # removes it and extracts the Y plane.
        luma = array[: self.lores_height, : self.lores_width]
        return self._store(
            Frame(
                ts_ms=now_ms(),
                luma=luma,
                width=self.lores_width,
                height=self.lores_height,
                meta={
                    "lux": metadata.get("Lux"),
                    "analogue_gain": metadata.get("AnalogueGain"),
                    "exposure_time": metadata.get("ExposureTime"),
                },
            )
        )

    def snapshot_jpeg(self, width: int | None = None, height: int | None = None) -> bytes | None:
        if self._camera is None:
            return None
        try:
            import io

            buffer = io.BytesIO()
            self._camera.capture_file(buffer, format="jpeg")
            return buffer.getvalue()
        except Exception as exc:
            log.debug("picamera2 snapshot failed: %s", exc)
            return super().snapshot_jpeg(width, height)

    def apply_night_controls(self, night: bool) -> None:
        """Relax exposure for a dark room, and stop the lens hunting.

        Camera Module 3's phase-detect autofocus hunts under flat infrared
        light, and every hunt changes the whole frame — which reads as motion.
        Pinning focus is the single most effective night-vision fix.
        """
        if self._camera is None:
            return
        try:
            from libcamera import controls  # type: ignore[import-not-found]

            if night:
                self._camera.set_controls(
                    {
                        "AeEnable": True,
                        "AeExposureMode": controls.AeExposureModeEnum.Long,
                        "FrameDurationLimits": (int(1e6 / self.fps), int(1e6 / 15)),
                        # Auto white balance is unstable under narrowband IR,
                        # and the image is near-monochrome anyway.
                        "AwbEnable": False,
                        "ColourGains": (1.0, 1.0),
                        "AfMode": controls.AfModeEnum.Manual,
                        "LensPosition": 0.5,
                    }
                )
            else:
                self._camera.set_controls(
                    {
                        "AeEnable": True,
                        "AeExposureMode": controls.AeExposureModeEnum.Normal,
                        "AwbEnable": True,
                    }
                )
        except Exception as exc:
            log.debug("could not apply night controls: %s", exc)

    def close(self) -> None:
        if self._camera is not None:
            try:
                self._camera.stop()
                self._camera.close()
            except Exception:
                pass
            self._camera = None


# ---------------------------------------------------------------------------
# v4l2 (USB webcam)
# ---------------------------------------------------------------------------


class V4l2Source(VideoSource):
    """A USB webcam through OpenCV."""

    name = "v4l2"

    def __init__(
        self, device: str, width: int, height: int, lores_width: int, lores_height: int
    ) -> None:
        super().__init__(width, height, lores_width, lores_height)
        self.device = device
        self._capture: Any = None

    def open(self) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "the v4l2 camera source needs OpenCV: `sudo apt install python3-opencv`"
            ) from exc
        self._cv2 = cv2
        index = int(self.device.rsplit("video", 1)[-1]) if "video" in self.device else self.device
        self._capture = cv2.VideoCapture(index)
        if not self._capture.isOpened():
            raise RuntimeError(f"could not open camera {self.device}")
        self._capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self._capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self._error = None

    def read(self) -> Frame | None:
        if self._capture is None:
            return None
        ok, image = self._capture.read()
        if not ok or image is None:
            self._error = "camera read failed"
            return None
        grey = self._cv2.cvtColor(image, self._cv2.COLOR_BGR2GRAY)
        luma = self._cv2.resize(grey, (self.lores_width, self.lores_height))
        ok, encoded = self._cv2.imencode(".jpg", image, [int(self._cv2.IMWRITE_JPEG_QUALITY), 80])
        return self._store(
            Frame(
                ts_ms=now_ms(),
                luma=luma,
                width=self.lores_width,
                height=self.lores_height,
                jpeg=encoded.tobytes() if ok else None,
            )
        )

    def close(self) -> None:
        if self._capture is not None:
            self._capture.release()
            self._capture = None


# ---------------------------------------------------------------------------
# synthetic
# ---------------------------------------------------------------------------


class SyntheticSource(VideoSource):
    """A generated scene: a slowly breathing shape on a dim background.

    Exists so the dashboard, the API and the sleep state machine can be
    exercised end to end with no hardware, in CI and on a laptop. The motion it
    produces is deliberately in the same range as a real sleeping child, so
    tuning done against it is not completely fictional.
    """

    name = "synthetic"

    def __init__(self, width: int, height: int, lores_width: int, lores_height: int) -> None:
        super().__init__(width, height, lores_width, lores_height)
        self._t = 0.0
        self._rng = np.random.default_rng(4)
        #: Scripted activity, 0..1. Roughly: 0.0 deeply asleep, 0.05 the odd
        #: twitch, 0.3 restless and turning over, 0.8 sitting up and moving.
        self.activity = 0.02
        #: Sensor noise, raised to imitate the high analogue gain of a dark room.
        self.noise_sigma = 1.4
        self._cx = lores_width * 0.5
        self._cy = lores_height * 0.55
        self._twitch = 0.0

    def open(self) -> None:
        self._error = None

    def read(self) -> Frame | None:
        self._t += 0.2
        h, w = self.lores_height, self.lores_width

        # Movement as a random walk with occasional larger twitches, pulled
        # gently back toward the centre of the cot. A smooth sinusoidal drift
        # would be sub-pixel per frame and produce no frame-to-frame difference
        # at all, which is not how a child moves — real movement is sporadic
        # and large when it happens.
        step = self.activity * 9.0
        if self._rng.random() < self.activity * 0.35:
            self._twitch = self.activity * 22.0
        self._twitch *= 0.6
        self._cx += self._rng.normal(0, step) + self._rng.normal(0, self._twitch)
        self._cy += self._rng.normal(0, step * 0.6) + self._rng.normal(0, self._twitch * 0.5)
        self._cx += (w * 0.5 - self._cx) * 0.04
        self._cy += (h * 0.55 - self._cy) * 0.04

        frame = np.full((h, w), 28, dtype=np.float32)
        yy, xx = np.mgrid[0:h, 0:w]
        breathe = 2.0 * math.sin(self._t * 0.9)
        radius = min(w, h) * 0.28 + breathe
        blob = np.exp(-(((xx - self._cx) ** 2 + (yy - self._cy) ** 2) / (2 * radius**2)))
        frame += blob * 90

        frame += self._rng.normal(0, self.noise_sigma, size=(h, w))
        luma = np.clip(frame, 0, 255).astype(np.uint8)
        return self._store(Frame(ts_ms=now_ms(), luma=luma, width=w, height=h))

    def snapshot_jpeg(self, width: int | None = None, height: int | None = None) -> bytes | None:
        """Render the scene at full size rather than at analysis resolution.

        Analysis runs on a 320x240 grey plane, which is not something anyone
        wants to look at in the dashboard or the Home app. Upscaling the
        analysis frame is enough here — this source exists for development, and
        a soft image is a truer preview of what a real camera gives at night
        than a synthetically sharp one would be.
        """
        frame = self.last_frame
        if frame is None:
            return None
        return encode_jpeg(frame, width or self.width, height or self.height)


# ---------------------------------------------------------------------------


def build_source(config: Any) -> VideoSource:
    """Construct the configured camera source."""
    source = config.source
    if source == "picamera2":
        return Picamera2Source(
            config.width, config.height, config.lores_width, config.lores_height,
            fps=config.fps, rotation=config.rotation, hflip=config.hflip, vflip=config.vflip,
        )
    if source == "v4l2":
        return V4l2Source(
            config.device, config.width, config.height, config.lores_width, config.lores_height
        )
    if source in ("rtsp", "file"):
        url = config.url or config.rtsp_url
        return FfmpegSource(
            url, config.width, config.height, config.lores_width, config.lores_height,
            loop=(source == "file"),
        )
    if source == "synthetic":
        return SyntheticSource(
            config.width, config.height, config.lores_width, config.lores_height
        )
    raise ValueError(f"unknown camera source {source!r}")


def encode_jpeg(frame: Frame, width: int | None = None, height: int | None = None) -> bytes | None:
    """Encode a frame's luma plane as JPEG.

    A fallback for sources with no native snapshot path. Tries OpenCV, then
    Pillow, then gives up — a monitor with no JPEG encoder still records
    everything else, it simply cannot show a still.
    """
    image = frame.luma
    target = (width or frame.width, height or frame.height)
    try:
        import cv2  # type: ignore[import-not-found]

        if target != (frame.width, frame.height):
            image = cv2.resize(image, target)
        ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return encoded.tobytes() if ok else None
    except ImportError:
        pass
    try:
        import io

        from PIL import Image  # type: ignore[import-not-found]

        pil = Image.fromarray(image, mode="L")
        if target != (frame.width, frame.height):
            pil = pil.resize(target)
        buffer = io.BytesIO()
        pil.save(buffer, format="JPEG", quality=80)
        return buffer.getvalue()
    except ImportError:
        return None


def with_retry(source: VideoSource, stop: threading.Event, max_delay_s: float = 30.0) -> None:
    """Keep a source open, reconnecting with backoff.

    A camera that is unplugged, an RTSP server that restarts, a Pi that boots
    faster than its USB bus: all of these are ordinary and none should require
    a human. Runs until ``stop`` is set.
    """
    delay = 1.0
    while not stop.is_set():
        try:
            source.open()
            delay = 1.0
            return
        except Exception as exc:
            log.warning("camera %s unavailable (%s); retrying in %.0fs", source.name, exc, delay)
            if stop.wait(delay):
                return
            delay = min(delay * 2, max_delay_s)
            time.sleep(0)
