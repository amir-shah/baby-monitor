"""``babymon-setup``: first-run helpers.

Small, boring jobs that would otherwise be a paragraph of README:
downloading the sound-classification model, generating credentials, listing the
hardware the Pi can see, and seeding demo data so the dashboard can be
evaluated before a camera is ever mounted.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

__all__ = ["main"]

YAMNET_URL = (
    "https://www.kaggle.com/api/v1/models/google/yamnet/tfLite/"
    "classification-tflite/1/download"
)
CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/master/research/"
    "audioset/yamnet/yamnet_class_map.csv"
)
#: The published TFLite model is 4,126,810 bytes. A download that comes back
#: much smaller is an error page, not a model, and would fail confusingly at
#: the first inference rather than here.
YAMNET_MIN_BYTES = 3_500_000
CLASS_MAP_MIN_BYTES = 10_000


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="babymon-setup", description=__doc__)
    parser.add_argument("-c", "--config", help="path to babymon.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    fetch = sub.add_parser("fetch-models", help="download the YAMNet sound classifier")
    fetch.add_argument("--force", action="store_true", help="re-download even if present")
    fetch.set_defaults(handler=_fetch_models)

    sub.add_parser("devices", help="list cameras and microphones").set_defaults(handler=_devices)
    sub.add_parser("secrets", help="generate a password, token and HomeKit PIN").set_defaults(
        handler=_secrets
    )

    demo = sub.add_parser("demo-data", help="seed plausible nights so the dashboard has content")
    demo.add_argument("--nights", type=int, default=60)
    demo.set_defaults(handler=_demo_data)

    args = parser.parse_args(argv)
    return int(args.handler(args) or 0)


# ---------------------------------------------------------------------------


def _fetch_models(args: Any) -> int:
    from .config import load_config

    config = load_config(args.config)
    models = Path(config.paths.models_dir)
    models.mkdir(parents=True, exist_ok=True)

    model_path = models / "yamnet.tflite"
    class_map_path = models / "yamnet_class_map.csv"

    if model_path.exists() and not args.force:
        print(f"already present: {model_path} ({model_path.stat().st_size} bytes)")
    else:
        print(f"downloading YAMNet to {model_path} ...")
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "yamnet.tar.gz"
            _download(YAMNET_URL, archive)
            extracted = _extract_tflite(archive, Path(tmp))
            if extracted.stat().st_size < YAMNET_MIN_BYTES:
                print(
                    f"error: the downloaded model is only {extracted.stat().st_size} bytes; "
                    "the download was truncated or returned an error page",
                    file=sys.stderr,
                )
                return 1
            shutil.move(str(extracted), model_path)
        print(f"  saved {model_path.stat().st_size} bytes")

    if class_map_path.exists() and not args.force:
        print(f"already present: {class_map_path}")
    else:
        print(f"downloading the class map to {class_map_path} ...")
        _download(CLASS_MAP_URL, class_map_path)
        if class_map_path.stat().st_size < CLASS_MAP_MIN_BYTES:
            print("error: the class map download looks truncated", file=sys.stderr)
            class_map_path.unlink(missing_ok=True)
            return 1

    lines = class_map_path.read_text(encoding="utf-8").strip().splitlines()
    print(f"  {len(lines) - 1} classes")
    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()[:16]
    print(f"model sha256: {digest}...")

    try:
        from .audio.classifier import YamnetClassifier

        classifier = YamnetClassifier(model_path, class_map_path)
        print(f"verified: {classifier.describe()}")
    except Exception as exc:
        print(f"warning: the model downloaded but could not be loaded: {exc}")
        print("install a TFLite runtime with `pip install ai-edge-litert`")
    return 0


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "babymon-setup"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as out:
        shutil.copyfileobj(response, out)


def _extract_tflite(archive: Path, into: Path) -> Path:
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            if member.name.endswith(".tflite"):
                # Never trust a path from an archive; extract by name into a
                # directory we control.
                target = into / Path(member.name).name
                extracted = tar.extractfile(member)
                if extracted is None:
                    continue
                target.write_bytes(extracted.read())
                return target
    raise RuntimeError(f"no .tflite file inside {archive}")


def _devices(args: Any) -> int:
    from .audio.capture import list_devices

    print("microphones:")
    devices = list_devices()
    if not devices:
        print("  none found")
    for device in devices:
        print(f"  {device}")

    print("\ncameras:")
    found = False
    for path in sorted(Path("/dev").glob("video*")):
        print(f"  {path}")
        found = True
    rpicam = shutil.which("rpicam-hello") or shutil.which("libcamera-hello")
    if rpicam:
        try:
            result = subprocess.run(
                [rpicam, "--list-cameras"], capture_output=True, text=True, timeout=10, check=False
            )
            print(result.stdout.strip() or "  (rpicam reported no cameras)")
            found = True
        except (subprocess.SubprocessError, OSError) as exc:
            print(f"  rpicam failed: {exc}")
    if not found:
        print("  none found")

    print("\nI2C:")
    detect = shutil.which("i2cdetect")
    if detect is None:
        print("  i2cdetect not installed (apt install i2c-tools)")
    else:
        result = subprocess.run(
            [detect, "-y", "1"], capture_output=True, text=True, timeout=10, check=False
        )
        print(result.stdout.rstrip() or "  nothing on bus 1")
    return 0


def _secrets(args: Any) -> int:
    import secrets

    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz"
    password = "".join(secrets.choice(alphabet) for _ in range(16))
    token = secrets.token_urlsafe(32)
    # HomeKit rejects trivially patterned codes, so keep drawing until the
    # digits are not all the same and not sequential.
    while True:
        digits = "".join(secrets.choice("0123456789") for _ in range(8))
        pin = f"{digits[:3]}-{digits[3:5]}-{digits[5:]}"
        if len(set(digits)) > 2 and digits not in ("12345678", "87654321"):
            break

    print("# Add these to deploy/babymon.env (or your systemd EnvironmentFile).")
    print("# They are secrets: keep them out of the YAML config and out of git.")
    print(f"BABYMON_API__AUTH__PASSWORD={password}")
    print(f"BABYMON_HOMEKIT__API_TOKEN={token}")
    print(f"BABYMON_API__AUTH__TOKENS=[{token!r}]")
    print(f"BABYMON_HOMEKIT__PIN={pin}")
    print(f"BABYMON_SECRET={secrets.token_urlsafe(48)}")
    return 0


def _demo_data(args: Any) -> int:
    """Seed plausible nights, notes and events.

    Exists so the analytics can be looked at honestly before anyone has
    collected six months of real data — and so the minimum-n gates and the
    factor analysis can be seen actually working.
    """
    import datetime as dt
    import random

    from .config import load_config
    from .models import EventKind, EventLabel, Severity, SleepSegment, SleepState
    from .sleep.sessions import NightBuilder
    from .storage import Repos, open_database
    from .timeutil import NightWindow

    config = load_config(args.config)
    config.paths.ensure()
    repos = Repos(open_database(config.paths.db))
    children = repos.bootstrap(config)
    child = children[0]
    rng = random.Random(7)

    if not child.birthdate:
        # Without a birthdate there is no age band, so the duration component
        # drops out and the demo shows a score built from three parts instead
        # of four — which is correct behaviour but a poor demonstration.
        born = dt.date.today() - dt.timedelta(days=700)
        child = repos.children.update(child.id, birthdate=born.isoformat()) or child
        print(f"  (set a demo birthdate of {born} so the duration score has an age band)")

    today = dt.date.today()
    print(f"seeding {args.nights} nights for {child.name} ...")
    for offset in range(args.nights, 0, -1):
        key = (today - dt.timedelta(days=offset)).isoformat()
        window = NightWindow.for_key(key, child.timezone, child.day_boundary_hour)

        dessert = rng.random() < 0.3
        screen = rng.random() < 0.35
        bath = rng.random() < 0.6
        # A real, modest effect for the analytics to find, plus noise.
        penalty = (28 if dessert else 0) + (18 if screen else 0)

        bedtime = window.start_ms + int((7.5 + rng.uniform(-0.4, 0.6)) * 3_600_000)
        onset = bedtime + int((12 + rng.uniform(0, 25) + penalty * 0.4) * 60_000)
        wake = onset + int((10.0 + rng.uniform(-1.2, 0.8)) * 3_600_000) - penalty * 60_000
        out_of_bed = wake + int(rng.uniform(3, 25) * 60_000)

        # An afternoon nap, because the age bands are per 24 hours *including*
        # naps: a toddler given ten hours of night and nothing else is scored
        # against an eleven-hour floor and comes out "Poor" every night, which
        # makes the seeded dashboard look like the analytics are broken. It is
        # also the case the nocturnal cut exists for, so demo data that omits
        # it exercises none of that.
        segments: list[SleepSegment] = []
        if rng.random() < 0.8:
            nap_start = window.start_ms + int((1.0 + rng.uniform(0, 1.5)) * 3_600_000)
            nap_end = nap_start + int(rng.uniform(45, 110) * 60_000)
            segments += [
                SleepSegment(0, child.id, key, nap_start, nap_end, SleepState.ASLEEP),
                SleepSegment(0, child.id, key, nap_end, bedtime, SleepState.ABSENT),
            ]
        segments.append(SleepSegment(0, child.id, key, bedtime, onset, SleepState.SETTLING))
        cursor = onset
        awakenings = rng.choices([0, 1, 2, 3], weights=[35, 35, 20, 10])[0] + (1 if dessert else 0)
        for _ in range(awakenings):
            span = int(rng.uniform(0.8, 2.6) * 3_600_000)
            if cursor + span >= wake:
                break
            segments.append(
                SleepSegment(0, child.id, key, cursor, cursor + span, SleepState.ASLEEP)
            )
            cursor += span
            duration = int(rng.uniform(6, 22) * 60_000)
            segments.append(
                SleepSegment(
                    0, child.id, key, cursor, min(cursor + duration, wake), SleepState.AWAKE
                )
            )
            cursor = min(cursor + duration, wake)
            eid = repos.events.open(
                child_id=child.id, night_of=key, start_ms=cursor,
                end_ms=cursor + 60_000, kind=EventKind.AUDIO, label=EventLabel.CRY,
                confidence=round(rng.uniform(0.5, 0.95), 2), severity=Severity.NOTICE,
                peak_dbfs=round(rng.uniform(-30, -12), 1),
            )
            repos.events.close(eid, cursor + 60_000)
        if cursor < wake:
            segments.append(SleepSegment(0, child.id, key, cursor, wake, SleepState.ASLEEP))
        segments.append(SleepSegment(0, child.id, key, wake, out_of_bed, SleepState.AWAKE))
        repos.segments.replace_night(child.id, key, segments)

        # Telemetry at the real sample interval, so coverage is realistic.
        step = int(config.sleep.sample_interval_s * 1000)
        from .models import Sample

        rows = []
        for ts in range(bedtime, out_of_bed, step):
            asleep = any(s.start_ms <= ts < s.end_ms and s.state.counts_as_sleep for s in segments)
            rows.append(
                Sample(
                    ts_ms=ts, child_id=child.id, night_of=key,
                    sound_dbfs=rng.uniform(-58, -50) if asleep else rng.uniform(-48, -32),
                    sound_peak_dbfs=rng.uniform(-45, -20),
                    noise_floor_dbfs=-58.0,
                    cry_score=0.02 if asleep else rng.uniform(0.0, 0.5),
                    motion=rng.uniform(0, 0.01) if asleep else rng.uniform(0.05, 0.6),
                    temp_c=round(rng.uniform(19.5, 21.8), 1),
                    humidity_pct=round(rng.uniform(42, 55), 1),
                    state=SleepState.ASLEEP if asleep else SleepState.AWAKE,
                )
            )
        repos.samples.add_many(rows)

        tags: list[dict[str, Any]] = []
        if dessert:
            tags.append({"slug": "dessert-before-bed"})
        if screen:
            tags.append({"slug": "screen-before-bed", "value_num": rng.choice([20, 30, 45, 60])})
        if bath:
            tags.append({"slug": "bath"})
        tags.append(
            {"slug": "lights-off", "value_min_local": 19 * 60 + rng.randint(0, 50)}
        )
        if tags:
            repos.notes.create(
                child_id=child.id, night_of=key, ts_ms=bedtime - 1_800_000,
                body=rng.choice(
                    ["", "", "long day", "skipped the afternoon nap", "teething again"]
                ),
                source="import", tags=tags,
            )

    print("computing rollups ...")
    builder = NightBuilder(config, repos)
    first = (today - dt.timedelta(days=args.nights)).isoformat()
    last = (today - dt.timedelta(days=1)).isoformat()
    count = builder.rebuild_range(child, first, last)
    print(f"done: {count} nights, {repos.db.stats()['rows']}")
    repos.db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
