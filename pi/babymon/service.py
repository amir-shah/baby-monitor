"""The sensing service: the loops that turn hardware into rows in a database.

Four threads, deliberately independent so that one failing subsystem degrades
the monitor rather than stopping it:

``audio``
    Pulls frames from the microphone ring, runs the DSP and classifier, drives
    the sound-event state machine, writes clips.
``video``
    Pulls low-resolution frames, runs motion analysis, tracks day/night.
``environment``
    Polls the thermometer on a slow timer.
``tick``
    Every ``sleep.sample_interval_s``, fuses the current audio and video state
    into a sleep state, writes one telemetry row, and publishes to the bus.
    Also handles the day boundary, the nightly rollup, retention and backups.

Everything the API needs comes through :class:`SensingRuntime`, which
implements the :class:`~babymon.bus.Runtime` protocol.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator
from typing import Any

from .audio.capture import AudioCapture, CaptureError
from .audio.classifier import build_classifier
from .audio.clips import ClipWriter
from .audio.detector import SoundEvent, SoundEventDetector
from .audio.dsp import AWeighting, NoiseFloor, analyse_frame
from .bus import ComponentHealth, EventBus, Topic
from .config import Config
from .env.sensors import ComfortEvaluator, Reading, build_sensor
from .models import (
    CRY_LABELS,
    Child,
    EventKind,
    EventLabel,
    LiveState,
    MediaKind,
    Sample,
    Severity,
    SleepState,
)
from .sleep.sessions import NightBuilder
from .sleep.state import Observation, SegmentBuilder, SleepStateMachine
from .storage import Repos
from .timeutil import night_of as compute_night_of
from .timeutil import now_ms
from .video.motion import DayNightTracker, MotionDetector
from .video.source import Picamera2Source, build_source, with_retry

log = logging.getLogger(__name__)

__all__ = ["SensingRuntime"]


class SensingRuntime:
    """Owns the sensors and the loops that read them."""

    def __init__(self, config: Config, repos: Repos, bus: EventBus | None = None) -> None:
        self.config = config
        self.repos = repos
        self.bus = bus or EventBus()

        children = repos.children.list()
        if not children:
            raise RuntimeError("no children configured; check the `children:` config block")
        # One camera and one microphone means one child is being monitored at a
        # time. Extra children exist so their history can live side by side.
        self.child: Child = children[0]

        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._started_ms = now_ms()

        # -- audio ----------------------------------------------------------
        self.capture: AudioCapture | None = None
        self.detector: SoundEventDetector | None = None
        self.clips: ClipWriter | None = None
        self.noise_floor = NoiseFloor(
            window_s=config.audio.noise_floor.window_s,
            percentile=config.audio.noise_floor.percentile,
            min_dbfs=config.audio.noise_floor.min_dbfs,
            max_dbfs=config.audio.noise_floor.max_dbfs,
            hop_s=config.audio.hop_s,
        )
        self.weighting = (
            AWeighting(config.audio.sample_rate, config.audio.frame_samples)
            if config.audio.a_weighting
            else None
        )

        # -- video ----------------------------------------------------------
        self.source: Any = None
        self.motion: MotionDetector | None = None
        self.day_night = DayNightTracker(
            dark_threshold=config.camera.night_vision.dark_threshold
        )

        # -- environment ------------------------------------------------------
        self.env_sensor: Any = None
        self.comfort = ComfortEvaluator(
            config.environment.comfort, config.environment.alerts.sustained_min
        )

        # -- fused state ------------------------------------------------------
        self.state_machine = SleepStateMachine(
            onset_quiet_min=config.sleep.onset_quiet_min,
            awakening_min_min=config.sleep.awakening_min_min,
            absent_after_min=config.sleep.absent_after_min,
            sample_interval_s=config.sleep.sample_interval_s,
            lapse_tolerance_s=config.sleep.lapse_tolerance_s,
        )
        self.night_builder = NightBuilder(config, repos)
        self._segments: SegmentBuilder | None = None
        self._night_of = compute_night_of(
            now_ms(), self.child.timezone, self.child.day_boundary_hour
        )

        self._latest_audio: dict[str, Any] = {}
        self._latest_env: Reading | None = None
        self._open_sound_event_id: int | None = None
        self._open_motion_event_id: int | None = None
        self._lock = threading.Lock()
        self._last_maintenance_day: str | None = None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self.config.paths.ensure()
        self._stop.clear()
        self.state_machine.begin_night(now_ms())
        self._segments = SegmentBuilder(self.child.id, self._night_of)
        self._recover_open_events()

        if self.config.audio.enabled:
            self._start_audio()
        if self.config.camera.enabled and self.config.camera.source != "none":
            self._start_video()
        if self.config.environment.enabled:
            self._start_environment()

        self._spawn(self._tick_loop, "tick")
        self.repos.syslog.add("info", "service", "sensing service started")
        self.bus.publish(Topic.SYSTEM, {"event": "started"})
        log.info("sensing service started for %s", self.child.name)

    def stop(self) -> None:
        log.info("stopping sensing service")
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5)
        self._threads.clear()

        ts = now_ms()
        if self.detector is not None:
            event = self.detector.flush(ts)
            if event is not None:
                self._record_sound_event(event)
        if self.motion is not None:
            self.motion.flush(ts)
        if self.capture is not None:
            self.capture.stop()
        if self.source is not None:
            self.source.close()
        if self.env_sensor is not None:
            self.env_sensor.close()

        # Close anything the detectors left open so the log has no dangling rows.
        self.repos.events.close_stale(self.child.id, ts + 1, ts)
        self._flush_segments(ts, final=True)
        self.repos.syslog.add("info", "service", "sensing service stopped")

    def _spawn(self, target: Any, name: str) -> None:
        thread = threading.Thread(
            target=self._guard(target, name), name=f"babymon-{name}", daemon=True
        )
        thread.start()
        self._threads.append(thread)

    def _guard(self, target: Any, name: str) -> Any:
        def wrapper() -> None:
            try:
                target()
            except Exception:
                log.exception("%s loop died", name)
                self.repos.syslog.add("error", name, "loop died; see the journal for the traceback")

        return wrapper

    def _recover_open_events(self) -> None:
        """Close events left open by a crash or an abrupt shutdown."""
        closed = self.repos.events.close_stale(self.child.id, now_ms(), now_ms())
        if closed:
            log.info("closed %d event(s) left open by the previous run", closed)

    # -- audio loop ---------------------------------------------------------

    def _start_audio(self) -> None:
        cfg = self.config.audio
        self.clips = ClipWriter(
            self.config.paths.media_dir,
            sample_rate=cfg.sample_rate,
            fmt=cfg.clips.format,
            bitrate_kbps=cfg.clips.bitrate_kbps,
        )
        classifier = build_classifier(cfg.classifier, cfg.detector.background_classes)
        self.detector = SoundEventDetector(
            classifier=classifier,
            on_db_above_floor=cfg.detector.on_db_above_floor,
            off_db_above_floor=cfg.detector.off_db_above_floor,
            score_on=cfg.detector.score_on,
            score_off=cfg.detector.score_off,
            score_high=cfg.detector.score_high,
            gate_db_above_floor=cfg.classifier.gate_db_above_floor,
            min_duration_s=cfg.detector.min_duration_s,
            merge_gap_s=cfg.detector.merge_gap_s,
            cooldown_s=cfg.detector.cooldown_s,
            smoothing_frames=cfg.detector.smoothing_frames,
            label_thresholds=cfg.detector.label_thresholds,
            hop_s=cfg.hop_s,
        )
        # The ring must outlast the longest clip we might want to reach back
        # for, plus headroom for the analysis lagging behind.
        ring_seconds = max(30.0, cfg.clips.pre_s + cfg.clips.post_s + 20.0)
        self.capture = AudioCapture(
            device=cfg.device,
            sample_rate=cfg.sample_rate,
            channels=cfg.channels,
            frame_samples=cfg.frame_samples,
            hop_samples=cfg.hop_samples,
            ring_seconds=ring_seconds,
        )
        try:
            self.capture.start()
        except CaptureError as exc:
            log.error("audio disabled: %s", exc)
            self.repos.syslog.add("error", "audio", str(exc))
            self.capture = None
            return
        self._spawn(self._audio_loop, "audio")

    def _audio_loop(self) -> None:
        capture, detector = self.capture, self.detector
        if capture is None or detector is None:
            return
        cfg = self.config.audio
        for samples, ts_ms in capture.frames():
            if self._stop.is_set():
                break
            frame = analyse_frame(
                samples,
                ts_ms=ts_ms,
                sample_rate=cfg.sample_rate,
                floor=self.noise_floor,
                weighting=self.weighting,
                gain_db=cfg.gain_db,
            )
            with self._lock:
                self._latest_audio = {
                    "dbfs": frame.a_weighted_dbfs,
                    "peak_dbfs": frame.peak_dbfs,
                    "floor_dbfs": frame.floor_dbfs,
                    "excess_db": frame.excess_db,
                    "ts_ms": ts_ms,
                }

            event = detector.push(frame)
            open_event = detector.current
            with self._lock:
                if open_event is not None:
                    self._latest_audio["cry_score"] = max(
                        (v for k, v in open_event.label_weights.items() if k in CRY_LABELS),
                        default=0.0,
                    ) / max(1, open_event.frames)
                    self._latest_audio["wake_sound"] = str(open_event.label) in (
                        cfg.detector.wake_labels
                    )
                else:
                    self._latest_audio["cry_score"] = 0.0
                    self._latest_audio["wake_sound"] = False

            if event is not None:
                self._record_sound_event(event)

    def _record_sound_event(self, event: SoundEvent) -> None:
        night = compute_night_of(
            event.start_ms, self.child.timezone, self.child.day_boundary_hour
        )
        severity = event.severity
        event_id = self.repos.events.open(
            child_id=self.child.id,
            night_of=night,
            start_ms=event.start_ms,
            end_ms=event.end_ms,
            kind=EventKind.AUDIO,
            label=event.label,
            confidence=event.confidence,
            severity=severity,
            peak_dbfs=event.peak_dbfs,
            mean_dbfs=event.mean_dbfs,
            meta=event.meta(),
        )
        log.info(
            "sound event: %s for %.0fs (confidence %.2f, peak %.1f dBFS)",
            event.label, event.duration_s, event.confidence, event.peak_dbfs,
        )
        self._attach_media(event, event_id, night, severity)

        record = self.repos.events.get(event_id)
        if record is not None:
            self.bus.publish(
                Topic.EVENT_CLOSE,
                _event_payload(record),
                child_id=self.child.id,
            )
        self.bus.publish(
            Topic.SOUND,
            {
                "active": False,
                "label": str(event.label),
                "confidence": round(event.confidence, 3),
                "peak_dbfs": round(event.peak_dbfs, 1),
                "ts_ms": event.end_ms or event.start_ms,
            },
            child_id=self.child.id,
        )
        self._notify(record)

    def _attach_media(
        self, event: SoundEvent, event_id: int, night: str, severity: Severity
    ) -> None:
        cfg = self.config.audio
        retention = self.config.retention

        if (
            cfg.clips.enabled
            and self.clips is not None
            and self.capture is not None
            and severity.at_least(cfg.clips.min_severity)
        ):
            duration = min(
                event.duration_s + cfg.clips.pre_s + cfg.clips.post_s,
                self.capture.ring.duration_s,
            )
            # The clip must include audio from before the event was recognised,
            # which is exactly why the ring buffer exists.
            # Reach back past the end of the event by the post-roll, so the
            # clip covers the moment it stopped as well as the moment it began.
            clip_end_ms = (event.end_ms or event.start_ms) + int(cfg.clips.post_s * 1000)
            samples = self.capture.clip(clip_end_ms, duration)
            result = self.clips.write(
                samples, night_of=night, event_id=event_id, ts_ms=event.start_ms
            )
            if result is not None:
                self.repos.media.add(
                    child_id=self.child.id,
                    night_of=night,
                    kind=MediaKind.AUDIO_CLIP,
                    rel_path=result.rel_path,
                    mime=result.mime,
                    ts_ms=event.start_ms,
                    event_id=event_id,
                    bytes_=result.bytes,
                    duration_s=result.duration_s,
                    expires_ms=_expiry(retention.audio_clips_days),
                )

        if (
            cfg.snapshots.enabled
            and self.source is not None
            and severity.at_least(cfg.snapshots.min_severity)
        ):
            jpeg = self.source.snapshot_jpeg()
            if jpeg:
                from pathlib import Path

                directory = Path(self.config.paths.media_dir) / "snapshots" / night
                directory.mkdir(parents=True, exist_ok=True)
                path = directory / f"event-{event_id}-{event.start_ms}.jpg"
                path.write_bytes(jpeg)
                self.repos.media.add(
                    child_id=self.child.id,
                    night_of=night,
                    kind=MediaKind.SNAPSHOT,
                    rel_path=str(path.relative_to(self.config.paths.media_dir)),
                    mime="image/jpeg",
                    ts_ms=event.start_ms,
                    event_id=event_id,
                    bytes_=len(jpeg),
                    expires_ms=_expiry(retention.snapshots_days),
                )

    # -- video loop ---------------------------------------------------------

    def _start_video(self) -> None:
        cfg = self.config.camera
        self.source = build_source(cfg)
        self.motion = MotionDetector(
            pixel_threshold=self.config.motion.pixel_threshold,
            on_threshold=self.config.motion.on_threshold,
            off_threshold=self.config.motion.off_threshold,
            min_on_s=self.config.motion.min_on_s,
            min_off_s=self.config.motion.min_off_s,
            warmup_s=self.config.motion.warmup_s,
            masks=self.config.motion.masks,
        )
        self._spawn(self._video_loop, "video")

    def _video_loop(self) -> None:
        source, motion = self.source, self.motion
        if source is None or motion is None:
            return
        with_retry(source, self._stop)
        interval = 1.0 / 5.0  # analysis at 5 fps; infant movement is slow

        while not self._stop.is_set():
            started = time.monotonic()
            frame = source.read()
            if frame is None:
                log.warning("camera stopped producing frames; reconnecting")
                source.close()
                with_retry(source, self._stop)
                continue

            if self.config.camera.night_vision.auto:
                night = self.day_night.update(frame)
                if isinstance(source, Picamera2Source) and night != getattr(
                    self, "_night_mode", None
                ):
                    source.apply_night_controls(night)
                    self._night_mode = night

            _, closed = motion.push(frame)
            if motion.active and self._open_motion_event_id is None:
                self._open_motion(frame.ts_ms)
            if closed is not None:
                self._close_motion(closed)

            elapsed = time.monotonic() - started
            if self._stop.wait(max(0.0, interval - elapsed)):
                break

    def _open_motion(self, ts_ms: int) -> None:
        night = compute_night_of(ts_ms, self.child.timezone, self.child.day_boundary_hour)
        self._open_motion_event_id = self.repos.events.open(
            child_id=self.child.id,
            night_of=night,
            start_ms=ts_ms,
            kind=EventKind.MOTION,
            label=EventLabel.MOTION,
            severity=Severity.INFO,
        )
        self.bus.publish(
            Topic.MOTION,
            {"active": True, "score": round(self.motion.recent_mean, 5) if self.motion else 0.0,
             "ts_ms": ts_ms},
            child_id=self.child.id,
        )

    def _close_motion(self, event: Any) -> None:
        event_id = self._open_motion_event_id
        self._open_motion_event_id = None
        if event_id is not None:
            self.repos.events.close(
                event_id, event.end_ms or now_ms(), motion_peak=event.peak_score
            )
        self.bus.publish(
            Topic.MOTION,
            {"active": False, "score": round(event.peak_score, 5),
             "ts_ms": event.end_ms or now_ms()},
            child_id=self.child.id,
        )

    # -- environment loop ---------------------------------------------------

    def _start_environment(self) -> None:
        self.env_sensor = build_sensor(self.config.environment)
        self._spawn(self._environment_loop, "environment")

    def _environment_loop(self) -> None:
        sensor = self.env_sensor
        if sensor is None:
            return
        while not self._stop.is_set():
            reading = sensor.read_with_retry(attempts=3, delay_s=2.0)
            if reading.ok:
                with self._lock:
                    self._latest_env = reading
                if self.config.environment.alerts.enabled:
                    for name, active, value in self.comfort.evaluate(reading):
                        self._record_environment_event(name, active, value, reading.ts_ms)
            if self._stop.wait(self.config.environment.poll_s):
                break

    def _record_environment_event(
        self, name: str, active: bool, value: float, ts_ms: int
    ) -> None:
        night = compute_night_of(ts_ms, self.child.timezone, self.child.day_boundary_hour)
        if active:
            self.repos.events.open(
                child_id=self.child.id,
                night_of=night,
                start_ms=ts_ms,
                kind=EventKind.ENVIRONMENT,
                label=name,
                severity=Severity.NOTICE,
                meta={"value": round(value, 2)},
            )
            log.info("environment: %s (%.1f)", name, value)
        else:
            # Close the matching open event rather than logging a second one.
            open_events, _ = self.repos.events.list(
                child_id=self.child.id, labels=[name], limit=1, order="desc"
            )
            for event in open_events:
                if event.end_ms is None:
                    self.repos.events.close(event.id, ts_ms)

    # -- tick loop ----------------------------------------------------------

    def _tick_loop(self) -> None:
        interval = self.config.sleep.sample_interval_s
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self._tick()
            except Exception:
                log.exception("tick failed")
            elapsed = time.monotonic() - started
            if self._stop.wait(max(0.5, interval - elapsed)):
                break

    def _tick(self) -> None:
        ts = now_ms()
        night = compute_night_of(ts, self.child.timezone, self.child.day_boundary_hour)

        if night != self._night_of:
            self._roll_night(ts, night)

        with self._lock:
            audio = dict(self._latest_audio)
            env = self._latest_env

        motion_score = self.motion.restlessness_index if self.motion else 0.0
        motion_active = self.motion.active if self.motion else False
        audio_ok = self.capture.healthy if self.capture else False
        video_ok = self.source.healthy if self.source else False

        change = self.state_machine.observe(
            Observation(
                ts_ms=ts,
                motion=motion_score,
                motion_active=motion_active,
                sound_excess_db=audio.get("excess_db", 0.0) if audio_ok else 0.0,
                cry_score=audio.get("cry_score", 0.0) if audio_ok else 0.0,
                wake_sound=bool(audio.get("wake_sound")) if audio_ok else False,
                video_ok=video_ok,
                audio_ok=audio_ok,
            )
        )
        if change is not None and self._segments is not None:
            self._segments.push(change.ts_ms, change.current, change.confidence)
            self._record_sleep_event(change)

        self.repos.samples.add(
            Sample(
                ts_ms=ts,
                child_id=self.child.id,
                night_of=night,
                sound_dbfs=audio.get("dbfs"),
                sound_peak_dbfs=audio.get("peak_dbfs"),
                noise_floor_dbfs=audio.get("floor_dbfs"),
                cry_score=audio.get("cry_score"),
                motion=motion_score,
                temp_c=env.temp_c if env else None,
                humidity_pct=env.humidity_pct if env else None,
                state=self.state_machine.state,
            )
        )
        self.bus.publish(
            Topic.STATE, self.live_state(self.child.id).to_dict(), child_id=self.child.id
        )

    def _record_sleep_event(self, change: Any) -> None:
        """Log the structural moments of a night, so they appear on the timeline."""
        label = {
            SleepState.ASLEEP: (
                EventLabel.SLEEP_ONSET
                if change.previous in (SleepState.SETTLING, SleepState.AWAKE, SleepState.UNKNOWN)
                and self.state_machine.sleep_onset_ms == change.ts_ms
                else EventLabel.BACK_TO_SLEEP
            ),
            SleepState.AWAKE: (
                EventLabel.AWAKENING if change.previous.counts_as_sleep else None
            ),
            SleepState.ABSENT: EventLabel.OUT_OF_BED,
        }.get(change.current)
        if label is None:
            return
        night = compute_night_of(change.ts_ms, self.child.timezone, self.child.day_boundary_hour)
        self.repos.events.open(
            child_id=self.child.id,
            night_of=night,
            start_ms=change.ts_ms,
            end_ms=change.ts_ms,
            kind=EventKind.SLEEP,
            label=label,
            confidence=change.confidence,
            severity=Severity.INFO,
            meta={"from": str(change.previous), "to": str(change.current), "reason": change.reason},
        )

    def _roll_night(self, ts: int, new_night: str) -> None:
        """Cross the day boundary: close out yesterday, start today."""
        log.info("night boundary: %s -> %s", self._night_of, new_night)
        previous = self._night_of
        self._flush_segments(ts, final=True)
        self._night_of = new_night
        self._segments = SegmentBuilder(self.child.id, new_night)
        self.state_machine.begin_night(ts)

        # Recompute the night that just ended, then run maintenance once a day.
        try:
            night = self.night_builder.rebuild(self.child, previous, finalise=True)
            if night is not None:
                self.bus.publish(Topic.NIGHT, {"night_of": night.night_of}, child_id=self.child.id)
        except Exception:
            log.exception("could not finalise the night of %s", previous)
        self._maintenance(new_night)

    def _flush_segments(self, ts: int, *, final: bool = False) -> None:
        """Write the night's hypnogram to the database.

        ``final`` only when the builder is about to be thrown away — at the day
        boundary, or on shutdown. Every other flush takes a snapshot, because
        finalising the segment the child is currently in would end the
        hypnogram at that instant and record nothing more until they next moved.
        A recompute of tonight, triggered from the dashboard, is exactly that
        case: it used to cost the rest of the night, permanently, because the
        write below replaces the night's rows wholesale.
        """
        if self._segments is None:
            return
        builder = self._segments
        segments = builder.close(ts) if final else builder.snapshot(ts)
        if not segments:
            return
        from .models import SleepSegment

        self.repos.segments.replace_night(
            self.child.id,
            builder.night_of,
            [
                SleepSegment(
                    id=0,
                    child_id=self.child.id,
                    night_of=builder.night_of,
                    start_ms=s["start_ms"],
                    end_ms=s["end_ms"],
                    state=s["state"],
                    confidence=s["confidence"],
                )
                for s in segments
            ],
        )

    def _maintenance(self, today: str) -> None:
        if self._last_maintenance_day == today:
            return
        self._last_maintenance_day = today
        try:
            from .maintenance import run_maintenance

            run_maintenance(self.config, self.repos)
        except Exception:
            log.exception("maintenance failed")

    def _notify(self, event: Any) -> None:
        if event is None or not self.config.notifications.enabled:
            return
        try:
            from .notify import send_notification

            send_notification(self.config, event, self.child)
        except Exception:
            log.exception("notification failed")

    # -- Runtime protocol ---------------------------------------------------

    def live_state(self, child_id: int) -> LiveState:
        with self._lock:
            audio = dict(self._latest_audio)
            env = self._latest_env
        ts = now_ms()
        state = LiveState(
            ts_ms=ts,
            child_id=self.child.id,
            night_of=self._night_of,
            state=self.state_machine.state,
            state_since_ms=self.state_machine.state_since_ms,
            sound_dbfs=audio.get("dbfs"),
            noise_floor_dbfs=audio.get("floor_dbfs"),
            cry_score=audio.get("cry_score"),
            motion=self.motion.restlessness_index if self.motion else None,
            temp_c=env.temp_c if env else None,
            humidity_pct=env.humidity_pct if env else None,
            camera_online=self.source.healthy if self.source else False,
            audio_online=self.capture.healthy if self.capture else False,
            env_online=self.env_sensor.healthy if self.env_sensor else False,
        )
        state.night_so_far = self.night_builder.summary_so_far(self.child, self._night_of)
        return state

    def snapshot(self, width: int | None = None, height: int | None = None) -> bytes | None:
        if self.source is None:
            return None
        return self.source.snapshot_jpeg(width, height)

    def mjpeg_stream(self, fps: float = 5.0, width: int | None = None) -> Iterator[bytes]:
        """Multipart MJPEG for the dashboard preview."""
        boundary = b"--frame\r\n"
        interval = 1.0 / max(0.5, min(fps, 15.0))
        while not self._stop.is_set():
            jpeg = self.snapshot(width)
            if jpeg:
                yield boundary + b"Content-Type: image/jpeg\r\nContent-Length: " + str(
                    len(jpeg)
                ).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
            time.sleep(interval)

    def health(self) -> list[ComponentHealth]:
        components = [
            ComponentHealth(
                "database", True, extra={"schema_version": self.repos.db.version()}
            )
        ]
        if self.config.audio.enabled:
            status = self.capture.status() if self.capture else {"error": "not started"}
            components.append(
                ComponentHealth(
                    "audio",
                    bool(self.capture and self.capture.healthy),
                    str(status.get("error") or ""),
                    extra={**status, "noise_floor_dbfs": round(self.noise_floor.value, 1),
                           "detector": self.detector.stats if self.detector else None},
                )
            )
        if self.config.camera.enabled and self.config.camera.source != "none":
            status = self.source.status() if self.source else {"error": "not started"}
            components.append(
                ComponentHealth(
                    "camera",
                    bool(self.source and self.source.healthy),
                    str(status.get("error") or ""),
                    extra={**status, "motion": self.motion.status() if self.motion else None,
                           "night_mode": self.day_night.night},
                )
            )
        if self.config.environment.enabled:
            status = self.env_sensor.status() if self.env_sensor else {"error": "not started"}
            components.append(
                ComponentHealth(
                    "environment",
                    bool(self.env_sensor and self.env_sensor.healthy),
                    str(status.get("error") or ""),
                    extra=status,
                )
            )
        components.append(
            ComponentHealth(
                "sleep",
                True,
                extra={**self.state_machine.status(), "night_of": self._night_of},
            )
        )
        return components

    def recompute_night(self, child_id: int, night_of: str) -> None:
        child = self.repos.children.get(child_id) or self.child
        # Persist whatever is buffered first, or a recompute of tonight will
        # miss everything since the last boundary.
        if night_of == self._night_of:
            self._flush_segments(now_ms())
        self.night_builder.rebuild(child, night_of, finalise=night_of != self._night_of)

    @property
    def uptime_s(self) -> float:
        return (now_ms() - self._started_ms) / 1000.0


def _expiry(days: int) -> int | None:
    if days <= 0:
        return None
    return now_ms() + days * 86_400_000


def _event_payload(event: Any) -> dict[str, Any]:
    return {
        "id": event.id,
        "child_id": event.child_id,
        "night_of": event.night_of,
        "start_ms": event.start_ms,
        "end_ms": event.end_ms,
        "duration_s": event.duration_s,
        "kind": str(event.kind),
        "label": str(event.label),
        "confidence": event.confidence,
        "severity": str(event.severity),
        "peak_dbfs": event.peak_dbfs,
        "meta": event.meta,
        "media": [
            {"id": m.id, "kind": str(m.kind), "duration_s": m.duration_s}
            for m in event.media
        ],
    }
