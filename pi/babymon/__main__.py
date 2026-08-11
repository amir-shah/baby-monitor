"""Command line entry point: ``babymon <command>``."""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
from typing import Any

from . import __version__

__all__ = ["main"]


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 1
    return int(args.handler(args) or 0)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="babymon", description=__doc__)
    parser.add_argument("--version", action="version", version=f"babymon {__version__}")
    parser.add_argument("-c", "--config", help="path to babymon.yaml")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="run the API and the sensing loops")
    serve.add_argument("--host", help="override api.host")
    serve.add_argument("--port", type=int, help="override api.port")
    serve.add_argument(
        "--no-sensors",
        action="store_true",
        help="serve the API and dashboard without opening any hardware",
    )
    serve.set_defaults(handler=_serve)

    status = sub.add_parser("status", help="print health and recent activity")
    status.set_defaults(handler=_status)

    recompute = sub.add_parser("recompute", help="rebuild night rollups")
    recompute.add_argument("--from", dest="night_from", help="first night (YYYY-MM-DD)")
    recompute.add_argument("--to", dest="night_to", help="last night (YYYY-MM-DD)")
    recompute.add_argument("--all", action="store_true", help="every night on record")
    recompute.set_defaults(handler=_recompute)

    export = sub.add_parser("export", help="export the per-night factor matrix")
    export.add_argument("--format", choices=("csv", "json"), default="csv")
    export.add_argument("-o", "--output", help="write to a file instead of stdout")
    export.add_argument("--days", type=int, default=365)
    export.set_defaults(handler=_export)

    maint = sub.add_parser("maintenance", help="run retention, backup and optimise now")
    maint.set_defaults(handler=_maintenance)

    check = sub.add_parser("check", help="validate the config and probe the hardware")
    check.set_defaults(handler=_check)

    return parser


# ---------------------------------------------------------------------------


def _setup(args: Any) -> tuple[Any, Any]:
    from .config import ConfigError, load_config
    from .storage import Repos, open_database

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"configuration error:\n{exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    _configure_logging(config, args.verbose)
    for warning in config.warnings():
        logging.getLogger("babymon.config").warning(warning)

    config.paths.ensure()
    database = open_database(config.paths.db)
    repos = Repos(database)
    repos.bootstrap(config)
    return config, repos


def _configure_logging(config: Any, verbose: bool) -> None:
    level = logging.DEBUG if verbose else getattr(logging, config.logging.level.upper(), logging.INFO)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if config.logging.file:
        handlers.append(logging.FileHandler(config.logging.file))
    if config.logging.format == "json":
        formatter: logging.Formatter = _JsonFormatter()
    else:
        # journald stamps its own timestamps, so ours would be redundant under
        # systemd; they are cheap and useful when running by hand.
        formatter = logging.Formatter("%(asctime)s %(levelname)-7s %(name)-28s %(message)s",
                                      datefmt="%H:%M:%S")
    for handler in handlers:
        handler.setFormatter(formatter)
    logging.basicConfig(level=level, handlers=handlers, force=True)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        import json

        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload)


# ---------------------------------------------------------------------------


def _serve(args: Any) -> int:
    import uvicorn

    from .api.app import create_app
    from .bus import NullRuntime

    config, repos = _setup(args)
    log = logging.getLogger("babymon")

    runtime: Any
    if args.no_sensors:
        runtime = NullRuntime()
        log.info("running without sensors")
    else:
        from .service import SensingRuntime

        runtime = SensingRuntime(config, repos)
        runtime.start()

    app = create_app(config, repos, runtime)

    stopping = threading.Event()

    def shutdown(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        log.info("received signal %s; shutting down", signal.Signals(signum).name)
        if hasattr(runtime, "stop"):
            runtime.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, shutdown)

    try:
        uvicorn.run(
            app,
            host=args.host or config.api.host,
            port=args.port or config.api.port,
            log_config=None,
            access_log=False,
        )
    finally:
        if not stopping.is_set() and hasattr(runtime, "stop"):
            runtime.stop()
        repos.db.close()
    return 0


def _status(args: Any) -> int:
    import json

    config, repos = _setup(args)
    child = repos.children.default()
    if child is None:
        print("no children configured")
        return 1
    from .timeutil import night_of as compute_night_of
    from .timeutil import now_ms

    tonight = compute_night_of(now_ms(), child.timezone, child.day_boundary_hour)
    night = repos.nights.get(child.id, tonight)
    sample = repos.samples.latest(child.id)
    events, total = repos.events.list(child_id=child.id, night_of=tonight, limit=10)

    print(f"child      : {child.name} (id {child.id}, {child.timezone or config.timezone})")
    print(f"tonight    : {tonight}")
    if sample:
        age = (now_ms() - sample.ts_ms) / 1000
        print(f"last sample: {age:.0f}s ago, state={sample.state}, "
              f"sound={sample.sound_dbfs}, motion={sample.motion}")
    else:
        print("last sample: none")
    if night:
        print(f"night      : TST={night.tst_min}m awakenings={night.awakenings} "
              f"score={night.quality_score} status={night.status}")
    print(f"events     : {total} tonight")
    for event in events[:10]:
        print(f"  {event.start_ms} {event.kind}/{event.label} conf={event.confidence}")
    print("database   :", json.dumps(repos.db.stats()["rows"]))
    repos.db.close()
    return 0


def _recompute(args: Any) -> int:
    config, repos = _setup(args)
    from .sleep.sessions import NightBuilder
    from .timeutil import night_of as compute_night_of
    from .timeutil import now_ms

    builder = NightBuilder(config, repos)
    total = 0
    for child in repos.children.list():
        if args.all:
            rows = repos.db.query(
                "SELECT MIN(night_of) AS a, MAX(night_of) AS b FROM samples WHERE child_id = ?",
                (child.id,),
            )
            first, last = (rows[0]["a"], rows[0]["b"]) if rows else (None, None)
        else:
            first = args.night_from
            last = args.night_to or compute_night_of(
                now_ms(), child.timezone, child.day_boundary_hour
            )
        if not first:
            print(f"{child.name}: nothing recorded")
            continue
        count = builder.rebuild_range(child, first, last)
        print(f"{child.name}: recomputed {count} night(s) from {first} to {last}")
        total += count
    repos.db.close()
    return 0 if total or args.all else 1


def _export(args: Any) -> int:
    config, repos = _setup(args)
    from .analytics.reports import export_matrix

    child = repos.children.default()
    if child is None:
        return 1
    text = export_matrix(repos, child, days=args.days, fmt=args.format)
    if args.output:
        from pathlib import Path

        Path(args.output).write_text(text, encoding="utf-8")
        print(f"wrote {args.output}")
    else:
        sys.stdout.write(text)
    repos.db.close()
    return 0


def _maintenance(args: Any) -> int:
    config, repos = _setup(args)
    from .maintenance import run_maintenance

    summary = run_maintenance(config, repos)
    for key, value in sorted(summary.items()):
        print(f"{key}: {value}")
    repos.db.close()
    return 0


def _check(args: Any) -> int:
    """Validate the configuration and probe every piece of hardware."""
    from .config import ConfigError, load_config

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"FAIL  configuration\n{exc}", file=sys.stderr)
        return 2
    print(f"ok    configuration ({config.source_path or 'defaults'})")
    for warning in config.warnings():
        print(f"warn  {warning}")

    failures = 0

    try:
        from .storage import open_database

        database = open_database(config.paths.db)
        problems = database.integrity_check()
        stats = database.stats()
        if problems:
            print(f"FAIL  database integrity: {problems}")
            failures += 1
        else:
            print(f"ok    database (schema v{stats['schema_version']}, "
                  f"{stats['size_bytes'] // 1024} KiB, "
                  f"{stats['disk_free_bytes'] // 1024**2 if stats['disk_free_bytes'] else '?'} MiB free)")
        database.close()
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  database: {exc}")
        failures += 1

    if config.audio.enabled:
        from .audio.capture import AudioCapture, CaptureError, list_devices

        devices = list_devices()
        print(f"info  {len(devices)} capture device(s): "
              + ", ".join(str(d.get('name')) for d in devices[:4]))
        capture = AudioCapture(
            device=config.audio.device,
            sample_rate=config.audio.sample_rate,
            frame_samples=config.audio.frame_samples,
            hop_samples=config.audio.hop_samples,
        )
        try:
            capture.start()
            import time

            time.sleep(1.5)
            if capture.healthy:
                print(f"ok    microphone {config.audio.device!r}")
            else:
                print(f"FAIL  microphone {config.audio.device!r} opened but produced no samples")
                failures += 1
            capture.stop()
        except CaptureError as exc:
            print(f"FAIL  microphone: {exc}")
            failures += 1

        from .audio.classifier import build_classifier

        classifier = build_classifier(
            config.audio.classifier, config.audio.detector.background_classes
        )
        described = classifier.describe()
        if described["backend"] != config.audio.classifier.backend:
            print(f"warn  classifier fell back to {described['backend']} "
                  f"(configured: {config.audio.classifier.backend})")
        else:
            print(f"ok    classifier {described}")

    if config.camera.enabled and config.camera.source != "none":
        from .video.source import build_source

        source = build_source(config.camera)
        try:
            source.open()
            frame = source.read()
            if frame is None:
                print(f"FAIL  camera {config.camera.source}: opened but produced no frames")
                failures += 1
            else:
                print(f"ok    camera {config.camera.source} ({frame.width}x{frame.height} analysis)")
            source.close()
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL  camera {config.camera.source}: {exc}")
            failures += 1

    if config.environment.enabled:
        from .env.sensors import build_sensor

        sensor = build_sensor(config.environment)
        reading = sensor.read_with_retry(attempts=3, delay_s=1.0)
        if reading.ok:
            print(f"ok    {sensor.name}: {reading.temp_c:.1f}C {reading.humidity_pct:.0f}%")
        else:
            print(f"FAIL  {sensor.name}: no reading ({sensor.status().get('error')})")
            failures += 1
        sensor.close()

    import shutil

    for tool, why in (("ffmpeg", "audio clips and HomeKit video"),):
        if shutil.which(tool):
            print(f"ok    {tool} found")
        else:
            print(f"warn  {tool} not on PATH; {why} will be limited")

    print()
    print("all checks passed" if failures == 0 else f"{failures} check(s) failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
