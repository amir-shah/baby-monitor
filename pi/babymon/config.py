"""Configuration loading, validation and interpolation.

Layers, lowest precedence first:

1. The defaults baked into the dataclasses below.
2. ``config/babymon.yaml`` (or whatever ``--config`` / ``BABYMON_CONFIG`` names).
3. Environment variables prefixed ``BABYMON_``, with ``__`` for nesting:
   ``BABYMON_API__AUTH__PASSWORD``, ``BABYMON_AUDIO__DEVICE``.

Values may reference other resolved values with ``${dotted.path}``; the
short forms ``${data_dir}`` and ``${media_dir}`` are also accepted inside
``paths`` because writing ``${paths.data_dir}`` inside ``paths`` reads badly.

Validation is deliberately strict about things that would silently produce
wrong data (an unknown timezone, a day boundary outside 0..23, a bedtime window
that does not parse) and forgiving about things that only degrade a feature (a
missing model file, a sensor that is not wired up). The former raise at
startup; the latter are reported through :meth:`Config.warnings`.
"""

from __future__ import annotations

import copy
import os
import re
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, get_args, get_origin

import yaml

from .timeutil import get_tz, parse_hhmm

__all__ = ["Config", "ConfigError", "load_config"]

ENV_PREFIX = "BABYMON_"
_INTERP_RE = re.compile(r"\$\{([A-Za-z0-9_.]+)\}")


class ConfigError(ValueError):
    """A configuration problem serious enough to refuse to start."""


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


@dataclass
class SiteConfig:
    name: str = "Nursery"
    timezone: str | None = None


@dataclass
class PathsConfig:
    data_dir: str = "/var/lib/babymon"
    db: str = "${data_dir}/babymon.db"
    media_dir: str = "${data_dir}/media"
    hap_dir: str = "${data_dir}/hap"
    models_dir: str = "${data_dir}/models"
    static_dir: str | None = None

    def ensure(self) -> None:
        """Create the directories the service writes to."""
        for path in (self.data_dir, self.media_dir, self.hap_dir, self.models_dir):
            Path(path).mkdir(parents=True, exist_ok=True)
        Path(self.db).parent.mkdir(parents=True, exist_ok=True)
        for sub in ("snapshots", "clips", "video"):
            (Path(self.media_dir) / sub).mkdir(parents=True, exist_ok=True)


@dataclass
class ChildConfig:
    name: str = "Kiddo"
    birthdate: str | None = None
    room: str | None = None
    timezone: str | None = None
    day_boundary_hour: int = 12
    target_bedtime: str | None = "19:30"
    target_waketime: str | None = "07:00"
    avatar_color: str | None = None


@dataclass
class NightVisionConfig:
    auto: bool = True
    dark_threshold: int = 40
    ir_led_gpio: int | None = None


@dataclass
class CameraConfig:
    enabled: bool = True
    source: str = "picamera2"
    device: str = "/dev/video0"
    url: str | None = None
    width: int = 1280
    height: int = 720
    fps: int = 15
    bitrate_kbps: int = 1500
    rotation: int = 0
    hflip: bool = False
    vflip: bool = False
    lores_width: int = 320
    lores_height: int = 240
    rtsp_enabled: bool = True
    rtsp_url: str = "rtsp://127.0.0.1:8554/babymon"
    encoder: str | None = None
    night_vision: NightVisionConfig = field(default_factory=NightVisionConfig)

    VALID_SOURCES = ("picamera2", "v4l2", "rtsp", "file", "synthetic", "none")


@dataclass
class MotionConfig:
    enabled: bool = True
    pixel_threshold: int = 18
    on_threshold: float = 0.012
    off_threshold: float = 0.005
    min_on_s: float = 1.5
    min_off_s: float = 8.0
    warmup_s: float = 10.0
    masks: list[list[float]] = field(default_factory=list)


@dataclass
class NoiseFloorConfig:
    window_s: float = 300.0
    percentile: float = 20.0
    min_dbfs: float = -75.0
    max_dbfs: float = -25.0


@dataclass
class ClassifierConfig:
    backend: str = "yamnet"
    model_path: str = "${paths.models_dir}/yamnet.tflite"
    class_map_path: str = "${paths.models_dir}/yamnet_class_map.csv"
    gate_db_above_floor: float = 6.0
    threads: int = 1

    VALID_BACKENDS = ("yamnet", "heuristic", "none")


@dataclass
class DetectorConfig:
    on_db_above_floor: float = 10.0
    off_db_above_floor: float = 5.0
    score_on: float = 0.45
    score_off: float = 0.30
    score_high: float = 0.80
    min_duration_s: float = 2.0
    merge_gap_s: float = 20.0
    cooldown_s: float = 15.0
    smoothing_frames: int = 5
    background_classes: list[str] = field(
        default_factory=lambda: [
            "Mechanical fan", "Air conditioning", "Rumble", "Hum", "Silence",
            "Inside, small room", "Noise", "Environmental noise", "Static",
            "Mains hum", "White noise", "Pink noise", "Throbbing", "Vibration",
        ]
    )
    label_thresholds: dict[str, float] = field(
        default_factory=lambda: {
            "cry": 0.45, "fuss": 0.35, "whimper": 0.35, "scream": 0.50,
            "talk": 0.45, "cough": 0.40, "snore": 0.40, "door": 0.45,
        }
    )
    wake_labels: list[str] = field(
        default_factory=lambda: ["cry", "fuss", "whimper", "scream", "talk"]
    )


@dataclass
class ClipsConfig:
    enabled: bool = True
    pre_s: float = 4.0
    post_s: float = 6.0
    min_severity: str = "notice"
    format: str = "opus"
    bitrate_kbps: int = 32


@dataclass
class SnapshotsConfig:
    enabled: bool = True
    min_severity: str = "notice"


@dataclass
class AudioConfig:
    enabled: bool = True
    device: str = "default"
    sample_rate: int = 16000
    channels: int = 1
    a_weighting: bool = True
    frame_s: float = 0.975
    hop_s: float = 0.5
    gain_db: float = 0.0
    noise_floor: NoiseFloorConfig = field(default_factory=NoiseFloorConfig)
    classifier: ClassifierConfig = field(default_factory=ClassifierConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    clips: ClipsConfig = field(default_factory=ClipsConfig)
    snapshots: SnapshotsConfig = field(default_factory=SnapshotsConfig)

    @property
    def frame_samples(self) -> int:
        return round(self.frame_s * self.sample_rate)

    @property
    def hop_samples(self) -> int:
        return round(self.hop_s * self.sample_rate)


@dataclass
class ComfortConfig:
    temp_c_min: float = 19.0
    temp_c_max: float = 21.5
    humidity_min: float = 40.0
    humidity_max: float = 60.0


@dataclass
class EnvAlertsConfig:
    enabled: bool = True
    sustained_min: float = 15.0


@dataclass
class EnvironmentConfig:
    enabled: bool = True
    sensor: str = "dht22"
    gpio_pin: int = 4
    i2c_bus: int = 1
    i2c_address: int | None = None
    poll_s: float = 60.0
    temp_offset_c: float = 0.0
    humidity_offset_pct: float = 0.0
    comfort: ComfortConfig = field(default_factory=ComfortConfig)
    alerts: EnvAlertsConfig = field(default_factory=EnvAlertsConfig)

    # "synthetic" generates a plausible room, so the dashboard and the sleep
    # analysis can be exercised on a laptop with no hardware attached.
    VALID_SENSORS = ("dht22", "dht11", "bme280", "sht31", "sht4x", "synthetic", "none")


@dataclass
class SleepConfig:
    sample_interval_s: float = 15.0
    bedtime_window: list[str] = field(default_factory=lambda: ["17:00", "23:59"])
    wake_window: list[str] = field(default_factory=lambda: ["04:00", "11:00"])
    onset_quiet_min: float = 12.0
    awakening_min_min: float = 5.0
    final_wake_min: float = 20.0
    absent_after_min: float = 25.0
    track_naps: bool = True
    nap_min_duration_min: float = 20.0


@dataclass
class ScoringConfig:
    # These must stay in step with config/babymon.example.yaml and
    # docs/ANALYTICS.md. Duration dominates, as it does in every consumer sleep
    # tracker; the quarter of the score those trackers spend on sleep-stage
    # composition is reallocated to timing regularity, which a camera and a
    # microphone can actually observe. Environment is off by default because it
    # measures the room rather than the child.
    weights: dict[str, float] = field(
        default_factory=lambda: {
            "duration": 0.40, "efficiency": 0.20, "continuity": 0.20,
            "timing": 0.20, "environment": 0.00,
        }
    )
    min_coverage: float = 0.6

    def normalised_weights(self) -> dict[str, float]:
        total = sum(max(0.0, w) for w in self.weights.values())
        if total <= 0:
            raise ConfigError("scoring.weights must contain at least one positive weight")
        return {k: max(0.0, v) / total for k, v in self.weights.items()}


@dataclass
class AnalyticsConfig:
    default_metric: str = "quality_score"
    default_window_days: int = 180
    min_nights_per_group: int = 10
    min_nights_total: int = 20
    permutations: int = 10000
    bootstrap_iterations: int = 5000
    fdr_q: float = 0.10
    permutation_mode: str = "circular_shift"
    shrinkage: bool = True
    confound_phi_threshold: float = 0.3
    duplicate_phi_threshold: float = 0.6
    min_span_fraction: float = 0.4
    random_seed: int = 20260101

    VALID_PERMUTATION_MODES = ("circular_shift", "shuffle")


@dataclass
class AuthConfig:
    enabled: bool = True
    password: str | None = None
    tokens: list[str] = field(default_factory=list)
    session_days: int = 30
    media_token_ttl_s: int = 3600
    #: Derived at load time; never read from the file.
    secret: str = ""


@dataclass
class NotesApiConfig:
    autocreate_tags: bool = True


@dataclass
class ApiConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173"])
    auth: AuthConfig = field(default_factory=AuthConfig)
    notes: NotesApiConfig = field(default_factory=NotesApiConfig)
    sse_heartbeat_s: float = 20.0


@dataclass
class RetentionConfig:
    samples_days: int = 400
    events_days: int = 400
    audio_clips_days: int = 30
    snapshots_days: int = 30
    video_clips_days: int = 14
    system_log_days: int = 30
    media_max_gb: float = 8.0
    run_at: str = "03:30"


@dataclass
class BackupConfig:
    enabled: bool = True
    dir: str = "${paths.data_dir}/backups"
    keep: int = 7
    run_at: str = "03:45"


@dataclass
class HomeKitVideoConfig:
    source_url: str | None = None
    copy_video: bool = True
    max_width: int = 1280
    max_height: int = 720
    max_fps: int = 15
    max_bitrate_kbps: int = 1500
    extra_args: list[str] = field(default_factory=list)
    debug: bool = False


@dataclass
class HomeKitAudioConfig:
    enabled: bool = True
    device: str = "default"
    codec: str = "libopus"
    bitrate_kbps: int = 24
    sample_rate: int = 24000
    two_way: bool = False
    playback_device: str = "default"


@dataclass
class HksvConfig:
    enabled: bool = True
    prebuffer_s: float = 6.0
    fragment_ms: int = 4000
    max_width: int = 1920
    max_height: int = 1080
    max_fps: int = 30
    max_bitrate_kbps: int = 2000
    audio: bool = True
    triggers: list[str] = field(default_factory=lambda: ["motion", "sound"])


@dataclass
class HomeKitSensorsConfig:
    temperature: bool = True
    humidity: bool = True
    motion: bool = True
    sound: bool = True
    awake_contact: bool = True


@dataclass
class TagSwitchConfig:
    slug: str
    label: str


@dataclass
class HomeKitConfig:
    enabled: bool = True
    name: str = "Baby Monitor"
    pin: str = "031-45-154"
    setup_id: str = "BBMN"
    username: str | None = None
    port: int = 51826
    advertiser: str = "ciao"
    api_url: str = "http://127.0.0.1:8080"
    api_token: str | None = None
    video: HomeKitVideoConfig = field(default_factory=HomeKitVideoConfig)
    audio: HomeKitAudioConfig = field(default_factory=HomeKitAudioConfig)
    hksv: HksvConfig = field(default_factory=HksvConfig)
    sensors: HomeKitSensorsConfig = field(default_factory=HomeKitSensorsConfig)
    tag_switches: list[TagSwitchConfig] = field(
        default_factory=lambda: [
            TagSwitchConfig("dessert-before-bed", "Dessert Before Bed"),
            TagSwitchConfig("screen-before-bed", "Screen Before Bed"),
            TagSwitchConfig("late-nap", "Late Nap"),
            TagSwitchConfig("teething", "Teething"),
        ]
    )

    VALID_ADVERTISERS = ("ciao", "bonjour-hap", "avahi")


@dataclass
class NotificationsConfig:
    enabled: bool = False
    min_severity: str = "alert"
    quiet_hours: list[str] | None = None
    webhook_url: str | None = None
    webhook_headers: dict[str, str] = field(default_factory=dict)


@dataclass
class LoggingConfig:
    level: str = "INFO"
    format: str = "text"
    file: str | None = None


@dataclass
class Config:
    site: SiteConfig = field(default_factory=SiteConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    children: list[ChildConfig] = field(default_factory=lambda: [ChildConfig()])
    camera: CameraConfig = field(default_factory=CameraConfig)
    motion: MotionConfig = field(default_factory=MotionConfig)
    audio: AudioConfig = field(default_factory=AudioConfig)
    environment: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    sleep: SleepConfig = field(default_factory=SleepConfig)
    scoring: ScoringConfig = field(default_factory=ScoringConfig)
    analytics: AnalyticsConfig = field(default_factory=AnalyticsConfig)
    api: ApiConfig = field(default_factory=ApiConfig)
    retention: RetentionConfig = field(default_factory=RetentionConfig)
    backup: BackupConfig = field(default_factory=BackupConfig)
    homekit: HomeKitConfig = field(default_factory=HomeKitConfig)
    notifications: NotificationsConfig = field(default_factory=NotificationsConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    #: Populated by :func:`load_config`; non-fatal problems worth telling the
    #: user about, surfaced on the dashboard's System page.
    _warnings: list[str] = field(default_factory=list, repr=False)
    #: The file this was loaded from, if any.
    source_path: str | None = field(default=None, repr=False)

    # -- accessors ---------------------------------------------------------

    @property
    def timezone(self) -> str:
        return str(get_tz(self.site.timezone))

    def child_timezone(self, child: ChildConfig | None = None) -> str:
        if child and child.timezone:
            return child.timezone
        return self.site.timezone or str(get_tz(None))

    def warnings(self) -> list[str]:
        return list(self._warnings)

    def warn(self, message: str) -> None:
        if message not in self._warnings:
            self._warnings.append(message)

    def to_dict(self, redact: bool = True) -> dict[str, Any]:
        data = _to_plain(self)
        data.pop("_warnings", None)
        if redact:
            for path in (
                ("api", "auth", "password"),
                ("api", "auth", "secret"),
                ("api", "auth", "tokens"),
                ("homekit", "pin"),
                ("homekit", "api_token"),
                ("notifications", "webhook_url"),
                ("notifications", "webhook_headers"),
            ):
                _redact(data, path)
        return data


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_config(
    path: str | os.PathLike[str] | None = None,
    *,
    environ: dict[str, str] | None = None,
) -> Config:
    """Load, merge, interpolate and validate the configuration."""
    environ = os.environ if environ is None else environ
    path = path or environ.get(f"{ENV_PREFIX}CONFIG")

    raw: dict[str, Any] = {}
    resolved_path: str | None = None
    if path:
        p = Path(path).expanduser()
        if not p.exists():
            raise ConfigError(f"config file not found: {p}")
        raw = _read_yaml(p)
        resolved_path = str(p)
    else:
        for candidate in _default_config_paths():
            if candidate.exists():
                raw = _read_yaml(candidate)
                resolved_path = str(candidate)
                break

    raw = _merge(raw, _env_overrides(environ))
    cfg = _build(Config, raw, "")
    cfg.source_path = resolved_path
    _interpolate(cfg)
    _derive(cfg, environ)
    _validate(cfg)
    return cfg


def _default_config_paths() -> list[Path]:
    here = Path(__file__).resolve()
    repo_root = here.parents[2]
    return [
        Path("/etc/babymon/babymon.yaml"),
        repo_root / "config" / "babymon.yaml",
        Path.cwd() / "babymon.yaml",
    ]


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path}: invalid YAML: {exc}") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be a mapping, got {type(data).__name__}")
    return data


def _merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge two mappings; lists are replaced wholesale, not concatenated."""
    out = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _env_overrides(environ: dict[str, str]) -> dict[str, Any]:
    """Turn ``BABYMON_A__B=c`` into ``{"a": {"b": "c"}}``, YAML-parsing values."""
    out: dict[str, Any] = {}
    for key, value in environ.items():
        if not key.startswith(ENV_PREFIX) or key == f"{ENV_PREFIX}CONFIG":
            continue
        parts = [p.lower() for p in key[len(ENV_PREFIX) :].split("__") if p]
        if not parts:
            continue
        try:
            parsed = yaml.safe_load(value)
        except yaml.YAMLError:
            parsed = value
        # A bare string that happens to look like a YAML doc should stay a
        # string; only scalars we recognise get converted.
        if not isinstance(parsed, (bool, int, float, list, dict)) or isinstance(parsed, str):
            parsed = value if parsed is None and value != "" else parsed
        cursor = out
        for part in parts[:-1]:
            nxt = cursor.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[part] = nxt
            cursor = nxt
        cursor[parts[-1]] = parsed
    return out


def _build(cls: type, data: Any, path: str) -> Any:
    """Instantiate a dataclass tree from plain data, rejecting unknown keys."""
    if not is_dataclass(cls):
        return data
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path or 'config'}: expected a mapping, got {type(data).__name__}")

    known = {f.name: f for f in fields(cls) if not f.name.startswith("_")}
    unknown = set(data) - set(known)
    if unknown:
        raise ConfigError(
            f"{path or 'config'}: unknown option(s) {sorted(unknown)}; "
            f"valid options are {sorted(known)}"
        )

    kwargs: dict[str, Any] = {}
    for name, f in known.items():
        if name not in data:
            continue
        child_path = f"{path}.{name}" if path else name
        kwargs[name] = _coerce(f.type, data[name], child_path)
    try:
        return cls(**kwargs)
    except TypeError as exc:
        raise ConfigError(f"{path or 'config'}: {exc}") from exc


def _coerce(annotation: Any, value: Any, path: str) -> Any:
    """Convert a YAML value to the annotated type, recursing into dataclasses."""
    # Annotations are strings under `from __future__ import annotations`.
    if isinstance(annotation, str):
        annotation = _resolve_annotation(annotation)

    origin = get_origin(annotation)
    if origin is list:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ConfigError(f"{path}: expected a list, got {type(value).__name__}")
        (inner,) = get_args(annotation) or (Any,)
        return [_coerce(inner, item, f"{path}[{i}]") for i, item in enumerate(value)]
    if origin is dict:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ConfigError(f"{path}: expected a mapping, got {type(value).__name__}")
        args = get_args(annotation)
        vtype = args[1] if len(args) == 2 else Any
        return {k: _coerce(vtype, v, f"{path}.{k}") for k, v in value.items()}
    if origin is not None:  # Optional[X] / X | None
        args = [a for a in get_args(annotation) if a is not type(None)]
        if value is None:
            return None
        if len(args) == 1:
            return _coerce(args[0], value, path)
        return value

    if is_dataclass(annotation):
        return _build(annotation, value, path)
    if annotation in (int, float, str, bool) and value is not None:
        return _coerce_scalar(annotation, value, path)
    return value


def _coerce_scalar(target: type, value: Any, path: str) -> Any:
    if isinstance(value, target) and not (target is int and isinstance(value, bool)):
        return value
    try:
        if target is bool:
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in ("true", "yes", "on", "1"):
                    return True
                if lowered in ("false", "no", "off", "0"):
                    return False
                raise ValueError(value)
            return bool(value)
        if target is int:
            if isinstance(value, float) and not value.is_integer():
                raise ValueError(value)
            return int(value)
        return target(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{path}: expected {target.__name__}, got {value!r}") from exc


_ANNOTATION_NS: dict[str, Any] = {}


def _resolve_annotation(text: str) -> Any:
    if not _ANNOTATION_NS:
        _ANNOTATION_NS.update(vars(__import__(__name__, fromlist=["*"])))
        _ANNOTATION_NS.update({"Any": Any, "list": list, "dict": dict, "str": str,
                               "int": int, "float": float, "bool": bool, "None": None})
    try:
        return eval(text, _ANNOTATION_NS)
    except Exception:
        return Any


# ---------------------------------------------------------------------------
# Interpolation, derivation, validation
# ---------------------------------------------------------------------------


def _interpolate(cfg: Config) -> None:
    """Resolve ``${dotted.path}`` references in string fields, in place."""
    for _ in range(5):  # bounded, so a reference cycle cannot hang startup
        changed = _interpolate_pass(cfg, cfg, "")
        if not changed:
            return
    raise ConfigError("unresolved ${...} reference (possible cycle) in configuration")


def _interpolate_pass(node: Any, root: Config, path: str) -> bool:
    changed = False
    if is_dataclass(node) and not isinstance(node, type):
        for f in fields(node):
            child_path = f"{path}.{f.name}" if path else f.name
            value = getattr(node, f.name)
            new = _interpolate_value(value, root, child_path)
            if new is not value:
                setattr(node, f.name, new)
                changed = True
            elif _interpolate_pass(value, root, child_path):
                changed = True
    elif isinstance(node, list):
        for i, item in enumerate(node):
            new = _interpolate_value(item, root, f"{path}[{i}]")
            if new is not item:
                node[i] = new
                changed = True
            elif _interpolate_pass(item, root, f"{path}[{i}]"):
                changed = True
    elif isinstance(node, dict):
        for key, item in list(node.items()):
            new = _interpolate_value(item, root, f"{path}.{key}")
            if new is not item:
                node[key] = new
                changed = True
    return changed


def _interpolate_value(value: Any, root: Config, path: str) -> Any:
    if not isinstance(value, str) or "${" not in value:
        return value

    def replace(match: re.Match[str]) -> str:
        ref = match.group(1)
        resolved = _lookup(root, ref)
        if resolved is None and path.startswith("paths"):
            # Inside `paths`, ${data_dir} is shorthand for ${paths.data_dir}.
            resolved = _lookup(root, f"paths.{ref}")
        if resolved is None:
            raise ConfigError(f"{path}: cannot resolve ${{{ref}}}")
        return str(resolved)

    return _INTERP_RE.sub(replace, value)


def _lookup(root: Any, dotted: str) -> Any:
    cursor: Any = root
    for part in dotted.split("."):
        if is_dataclass(cursor) and hasattr(cursor, part):
            cursor = getattr(cursor, part)
        elif isinstance(cursor, dict) and part in cursor:
            cursor = cursor[part]
        else:
            return None
    return None if isinstance(cursor, str) and "${" in cursor else cursor


def _derive(cfg: Config, environ: dict[str, str]) -> None:
    """Fill in values that are computed rather than configured."""
    if cfg.homekit.video.source_url is None:
        cfg.homekit.video.source_url = cfg.camera.rtsp_url
    if not cfg.api.auth.secret:
        cfg.api.auth.secret = _session_secret(cfg, environ)
    if cfg.homekit.username is None:
        cfg.homekit.username = _derive_hap_username(cfg)


def _session_secret(cfg: Config, environ: dict[str, str]) -> str:
    """A stable secret for signing session cookies and media tokens.

    Read from the environment if given, otherwise generated once and kept in
    the data directory. Regenerating it only logs everyone out; it is not
    catastrophic, so a lost file is a warning rather than an error.
    """
    from_env = environ.get(f"{ENV_PREFIX}SECRET")
    if from_env:
        return from_env
    secret_file = Path(cfg.paths.data_dir) / "session.secret"
    try:
        if secret_file.exists():
            existing = secret_file.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        import secrets

        value = secrets.token_urlsafe(48)
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        secret_file.write_text(value, encoding="utf-8")
        secret_file.chmod(0o600)
        return value
    except OSError:
        import secrets

        cfg.warn(
            f"could not persist a session secret at {secret_file}; sessions will "
            "not survive a restart"
        )
        return secrets.token_urlsafe(48)


def _derive_hap_username(cfg: Config) -> str:
    """A stable pseudo-MAC for the HomeKit accessory.

    Derived from the machine ID so it survives reinstalls of the software but
    differs between two Pis on the same network. The locally-administered bit
    is set and the multicast bit cleared, as a MAC of this kind should be.
    """
    import hashlib

    seed = ""
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id", "/proc/cpuinfo"):
        try:
            seed = Path(path).read_text(encoding="utf-8").strip()
            if seed:
                break
        except OSError:
            continue
    seed = f"{seed}:{cfg.homekit.name}:babymon"
    digest = hashlib.sha256(seed.encode()).digest()
    octets = bytearray(digest[:6])
    octets[0] = (octets[0] | 0x02) & 0xFE
    return ":".join(f"{b:02X}" for b in octets)


def _validate(cfg: Config) -> None:
    """Refuse to start on anything that would silently produce wrong data."""
    errors: list[str] = []

    if cfg.site.timezone:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(cfg.site.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            errors.append(f"site.timezone: unknown timezone {cfg.site.timezone!r}")

    if not cfg.children:
        errors.append("children: at least one child must be configured")
    seen_names: set[str] = set()
    for i, child in enumerate(cfg.children):
        where = f"children[{i}]"
        if not child.name.strip():
            errors.append(f"{where}.name must not be empty")
        if child.name in seen_names:
            errors.append(f"{where}.name: duplicate name {child.name!r}")
        seen_names.add(child.name)
        if not 0 <= child.day_boundary_hour <= 23:
            errors.append(f"{where}.day_boundary_hour must be 0..23")
        for attr in ("target_bedtime", "target_waketime"):
            value = getattr(child, attr)
            if value:
                try:
                    parse_hhmm(value)
                except ValueError as exc:
                    errors.append(f"{where}.{attr}: {exc}")
        if child.birthdate:
            from .timeutil import parse_date

            try:
                parse_date(child.birthdate)
            except ValueError as exc:
                errors.append(f"{where}.birthdate: {exc}")

    if cfg.camera.source not in CameraConfig.VALID_SOURCES:
        errors.append(
            f"camera.source: {cfg.camera.source!r} is not one of {list(CameraConfig.VALID_SOURCES)}"
        )
    if cfg.camera.source in ("rtsp", "file") and not cfg.camera.url:
        errors.append(f"camera.url is required when camera.source is {cfg.camera.source!r}")
    if cfg.camera.rotation not in (0, 90, 180, 270):
        errors.append("camera.rotation must be 0, 90, 180 or 270")
    if cfg.camera.fps <= 0 or cfg.camera.width <= 0 or cfg.camera.height <= 0:
        errors.append("camera width/height/fps must be positive")
    for i, mask in enumerate(cfg.motion.masks):
        if len(mask) != 4 or not all(0.0 <= v <= 1.0 for v in mask):
            errors.append(f"motion.masks[{i}] must be [x, y, w, h] with each value in 0..1")

    if cfg.audio.classifier.backend not in ClassifierConfig.VALID_BACKENDS:
        errors.append(
            f"audio.classifier.backend: {cfg.audio.classifier.backend!r} is not one of "
            f"{list(ClassifierConfig.VALID_BACKENDS)}"
        )
    if cfg.audio.sample_rate <= 0:
        errors.append("audio.sample_rate must be positive")
    if cfg.audio.hop_s <= 0 or cfg.audio.frame_s <= 0:
        errors.append("audio.frame_s and audio.hop_s must be positive")
    if cfg.audio.hop_s > cfg.audio.frame_s:
        cfg.warn("audio.hop_s exceeds audio.frame_s: analysis frames will have gaps between them")
    if cfg.audio.detector.off_db_above_floor >= cfg.audio.detector.on_db_above_floor:
        errors.append(
            "audio.detector.off_db_above_floor must be below on_db_above_floor, "
            "otherwise events cannot close (no hysteresis)"
        )
    if cfg.audio.detector.score_high < cfg.audio.detector.score_on:
        errors.append("audio.detector.score_high must be at or above score_on")
    if cfg.audio.detector.score_off >= cfg.audio.detector.score_on:
        errors.append(
            "audio.detector.score_off must be below score_on, otherwise events "
            "cannot close (no hysteresis on the classifier score)"
        )
    if cfg.audio.detector.smoothing_frames < 1:
        errors.append("audio.detector.smoothing_frames must be at least 1")
    if cfg.audio.classifier.gate_db_above_floor >= cfg.audio.detector.on_db_above_floor:
        cfg.warn(
            "audio.classifier.gate_db_above_floor is at or above "
            "audio.detector.on_db_above_floor, so the classifier will not have run "
            "by the time an event could open and every event will be unlabelled"
        )
    if cfg.audio.noise_floor.min_dbfs >= cfg.audio.noise_floor.max_dbfs:
        errors.append("audio.noise_floor.min_dbfs must be below max_dbfs")
    if not 0 < cfg.audio.noise_floor.percentile < 100:
        errors.append("audio.noise_floor.percentile must be between 0 and 100")

    if cfg.motion.off_threshold >= cfg.motion.on_threshold:
        errors.append("motion.off_threshold must be below motion.on_threshold (hysteresis)")

    if cfg.environment.sensor not in EnvironmentConfig.VALID_SENSORS:
        errors.append(
            f"environment.sensor: {cfg.environment.sensor!r} is not one of "
            f"{list(EnvironmentConfig.VALID_SENSORS)}"
        )
    if cfg.environment.comfort.temp_c_min >= cfg.environment.comfort.temp_c_max:
        errors.append("environment.comfort.temp_c_min must be below temp_c_max")

    for name, window in (("bedtime_window", cfg.sleep.bedtime_window),
                         ("wake_window", cfg.sleep.wake_window)):
        if len(window) != 2:
            errors.append(f"sleep.{name} must be a two-element [start, end] list")
            continue
        for value in window:
            try:
                parse_hhmm(value)
            except ValueError as exc:
                errors.append(f"sleep.{name}: {exc}")
    if cfg.sleep.sample_interval_s <= 0:
        errors.append("sleep.sample_interval_s must be positive")

    try:
        cfg.scoring.normalised_weights()
    except ConfigError as exc:
        errors.append(str(exc))
    unknown_weights = set(cfg.scoring.weights) - {
        "duration", "efficiency", "continuity", "timing", "environment"
    }
    if unknown_weights:
        errors.append(f"scoring.weights: unknown component(s) {sorted(unknown_weights)}")

    if cfg.analytics.permutation_mode not in AnalyticsConfig.VALID_PERMUTATION_MODES:
        errors.append(
            f"analytics.permutation_mode: {cfg.analytics.permutation_mode!r} is not one of "
            f"{list(AnalyticsConfig.VALID_PERMUTATION_MODES)}"
        )
    if not 0 < cfg.analytics.fdr_q < 1:
        errors.append("analytics.fdr_q must be between 0 and 1")
    if cfg.analytics.min_nights_per_group < 10:
        cfg.warn(
            f"analytics.min_nights_per_group is {cfg.analytics.min_nights_per_group}; below 10 "
            "nights per group the only detectable effects are ones large enough to be obvious "
            "without statistics, and whatever does reach significance is biased upward"
        )
    if cfg.analytics.permutations < 1000:
        cfg.warn("analytics.permutations below 1000 gives a very coarse p-value")
    if cfg.analytics.permutation_mode == "shuffle":
        cfg.warn(
            "analytics.permutation_mode is 'shuffle': plain shuffling ignores the fact that "
            "both sleep and habits come in runs, which inflates the false-positive rate"
        )

    if cfg.api.auth.enabled and not cfg.api.auth.password and not cfg.api.auth.tokens:
        errors.append(
            "api.auth is enabled but no password or token is set. Set "
            "BABYMON_API__AUTH__PASSWORD, or set api.auth.enabled to false if you "
            "genuinely want the camera dashboard open to your whole network."
        )

    if cfg.homekit.enabled:
        if not re.fullmatch(r"\d{3}-\d{2}-\d{3}", cfg.homekit.pin):
            errors.append("homekit.pin must look like 031-45-154")
        elif cfg.homekit.pin in _WEAK_HOMEKIT_PINS:
            cfg.warn(
                f"homekit.pin is {cfg.homekit.pin}, which HomeKit rejects as too "
                "simple; pick another"
            )
        if not re.fullmatch(r"[A-Z0-9]{4}", cfg.homekit.setup_id):
            errors.append("homekit.setup_id must be four uppercase letters or digits")
        if cfg.homekit.advertiser not in HomeKitConfig.VALID_ADVERTISERS:
            errors.append(
                f"homekit.advertiser: {cfg.homekit.advertiser!r} is not one of "
                f"{list(HomeKitConfig.VALID_ADVERTISERS)}"
            )
        if cfg.homekit.username and not re.fullmatch(
            r"([0-9A-F]{2}:){5}[0-9A-F]{2}", cfg.homekit.username
        ):
            errors.append("homekit.username must be a MAC-like AA:BB:CC:DD:EE:FF (uppercase)")
        if cfg.homekit.hksv.enabled and cfg.homekit.hksv.prebuffer_s < 4:
            cfg.warn(
                "homekit.hksv.prebuffer_s below 4 s: HomeKit asks for four seconds of "
                "pre-roll, so recordings may start after the event that triggered them"
            )
        for i, sw in enumerate(cfg.homekit.tag_switches):
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", sw.slug):
                errors.append(
                    f"homekit.tag_switches[{i}].slug must be lowercase letters, digits and hyphens"
                )

    if cfg.notifications.enabled and not cfg.notifications.webhook_url:
        errors.append("notifications.enabled is true but no webhook_url is set")
    if cfg.notifications.quiet_hours is not None:
        if len(cfg.notifications.quiet_hours) != 2:
            errors.append("notifications.quiet_hours must be a two-element [start, end] list")
        else:
            for value in cfg.notifications.quiet_hours:
                try:
                    parse_hhmm(value)
                except ValueError as exc:
                    errors.append(f"notifications.quiet_hours: {exc}")

    for name, value in (("retention.run_at", cfg.retention.run_at),
                        ("backup.run_at", cfg.backup.run_at)):
        try:
            parse_hhmm(value)
        except ValueError as exc:
            errors.append(f"{name}: {exc}")

    if cfg.logging.level.upper() not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        errors.append(f"logging.level: unknown level {cfg.logging.level!r}")
    if cfg.logging.format not in ("text", "json"):
        errors.append("logging.format must be 'text' or 'json'")

    if errors:
        raise ConfigError(
            "invalid configuration:\n" + "\n".join(f"  - {e}" for e in errors)
        )


#: Codes HomeKit itself refuses. Listed so we can complain at startup rather
#: than let the user wonder why pairing fails.
_WEAK_HOMEKIT_PINS = frozenset(
    {
        "000-00-000", "111-11-111", "222-22-222", "333-33-333", "444-44-444",
        "555-55-555", "666-66-666", "777-77-777", "888-88-888", "999-99-999",
        "123-45-678", "876-54-321",
    }
)


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _to_plain(node: Any) -> Any:
    if is_dataclass(node) and not isinstance(node, type):
        return {f.name: _to_plain(getattr(node, f.name)) for f in fields(node)}
    if isinstance(node, list):
        return [_to_plain(item) for item in node]
    if isinstance(node, dict):
        return {k: _to_plain(v) for k, v in node.items()}
    return node


def _redact(data: dict[str, Any], path: tuple[str, ...]) -> None:
    cursor: Any = data
    for part in path[:-1]:
        cursor = cursor.get(part) if isinstance(cursor, dict) else None
        if cursor is None:
            return
    if not isinstance(cursor, dict):
        return
    key = path[-1]
    value = cursor.get(key)
    if value in (None, "", [], {}):
        return
    cursor[key] = "***" if not isinstance(value, (list, dict)) else type(value)()
