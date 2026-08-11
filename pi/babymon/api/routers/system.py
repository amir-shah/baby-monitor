"""Health, host information, the operational log, metrics and effective config.

``/api/health`` is the only endpoint in the service that is never
authenticated. systemd's watchdog and the HomeKit bridge both poll it, neither
can hold a session, and a health check that can fail for authentication reasons
is a health check that lies. It therefore exposes only whether each subsystem
is up — no measurements, no filenames, nothing about the child.
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import PlainTextResponse

from ... import __version__
from ...models import Child
from ...storage.repo import Repos
from ...timeutil import night_dates, now_ms
from ..auth import require_auth
from ..deps import ConfigDep, IdempotencyKey, ReposDep, RuntimeDep, get_ctx
from ..errors import BadRequest, NotFound
from ..schemas import RecomputeRequest

router = APIRouter(tags=["system"])

#: Components the contract promises in the health payload even when the
#: subsystem behind them was never started, so a client can tell "off" from
#: "missing" without special-casing.
_EXPECTED_COMPONENTS = ("camera", "audio", "env", "db")


@router.get("/health")
def health(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    components: dict[str, Any] = {name: {"ok": False, "detail": "not reporting"}
                                  for name in _EXPECTED_COMPONENTS}
    try:
        for component in ctx.runtime.health():
            components[component.name] = component.to_dict()
    except Exception as exc:
        components["runtime"] = {"ok": False, "detail": f"health check failed: {exc}"}

    db_ok = True
    db_detail = ""
    try:
        ctx.repos.db.scalar("SELECT 1")
    except Exception as exc:
        db_ok = False
        db_detail = str(exc)
    components["db"] = {"ok": db_ok, "detail": db_detail}

    degraded = [name for name, value in components.items() if not value.get("ok")]
    return {
        "status": "ok" if not degraded else "degraded",
        "uptime_s": round(ctx.uptime_s, 1),
        "version": __version__,
        "components": components,
        "degraded": degraded,
        "ts_ms": now_ms(),
    }


@router.get("/system/info", dependencies=[Depends(require_auth)])
def system_info(config: ConfigDep, repos: ReposDep) -> dict[str, Any]:
    uname = platform.uname()
    return {
        "host": {
            "hostname": uname.node,
            "system": uname.system,
            "release": uname.release,
            "machine": uname.machine,
            "model": _pi_model(),
            "cpu_count": os.cpu_count(),
            "load_avg": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
            "uptime_s": _host_uptime_s(),
        },
        "temperatures_c": _temperatures(),
        "disk": _disk(config.paths.data_dir),
        "media": _media_usage(config.paths.media_dir, repos),
        "database": repos.db.stats(),
        "versions": {
            "babymon": __version__,
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
        "config_source": config.source_path,
        "warnings": config.warnings(),
    }


@router.get("/system/log", dependencies=[Depends(require_auth)])
def system_log(
    repos: ReposDep,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    level: Annotated[str | None, Query(max_length=16)] = None,
) -> dict[str, Any]:
    rows = repos.syslog.recent(limit=limit, level=level)
    return {"items": rows, "total": len(rows), "limit": limit, "offset": 0}


@router.get("/config", dependencies=[Depends(require_auth)])
def effective_config(config: ConfigDep) -> dict[str, Any]:
    """The running configuration with every secret redacted.

    The HomeKit bridge reads ``camera.rtsp_url`` from here rather than parsing
    the YAML itself, which is what keeps the two components from drifting apart
    about which stream is the live one.
    """
    return {"config": config.to_dict(redact=True), "warnings": config.warnings()}


@router.get(
    "/metrics", response_class=PlainTextResponse, dependencies=[Depends(require_auth)]
)
def metrics(request: Request, repos: ReposDep) -> str:
    """Prometheus text exposition, format version 0.0.4."""
    ctx = get_ctx(request)
    db_stats = repos.db.stats()
    bus_stats = ctx.runtime.bus.stats

    lines: list[str] = []

    def emit(name: str, kind: str, help_text: str, value: Any, labels: str = "") -> None:
        if value is None:
            return
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} {kind}")
        lines.append(f"{name}{labels} {float(value)}")

    emit("babymon_up", "gauge", "1 when the API is serving.", 1)
    emit("babymon_uptime_seconds", "gauge", "Seconds since the API started.", ctx.uptime_s)
    emit("babymon_db_size_bytes", "gauge", "SQLite file size.", db_stats.get("size_bytes"))
    emit("babymon_db_wal_bytes", "gauge", "Write-ahead log size.", db_stats.get("wal_bytes"))
    emit("babymon_disk_free_bytes", "gauge", "Free space on the data volume.",
         db_stats.get("disk_free_bytes"))
    emit("babymon_bus_subscribers", "gauge", "Live SSE subscribers.",
         bus_stats.get("subscribers"))
    emit("babymon_bus_published_total", "counter", "Messages published on the event bus.",
         bus_stats.get("published"))
    emit("babymon_bus_dropped_total", "counter", "Messages dropped for slow subscribers.",
         bus_stats.get("dropped"))

    lines.append("# HELP babymon_rows Row counts per table.")
    lines.append("# TYPE babymon_rows gauge")
    for table, count in sorted(db_stats.get("rows", {}).items()):
        lines.append(f'babymon_rows{{table="{table}"}} {float(count)}')

    lines.append("# HELP babymon_component_up Per-subsystem health, 1 when healthy.")
    lines.append("# TYPE babymon_component_up gauge")
    try:
        for component in ctx.runtime.health():
            lines.append(
                f'babymon_component_up{{component="{component.name}"}} '
                f"{1.0 if component.ok else 0.0}"
            )
    except Exception:
        lines.append('babymon_component_up{component="runtime"} 0.0')

    return "\n".join(lines) + "\n"


@router.post("/system/recompute", dependencies=[Depends(require_auth)])
def recompute(
    payload: RecomputeRequest,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> dict[str, Any]:
    """Rebuild the night rollups over a date range."""
    child = _child_for(repos, payload.child_id)
    start = payload.from_ or payload.to
    end = payload.to or payload.from_
    if start is None or end is None:
        raise BadRequest(
            "Give at least one of 'from' or 'to' as a YYYY-MM-DD night.",
            code="range_required",
        )
    if end < start:
        start, end = end, start

    keys = list(night_dates(start, end))
    if len(keys) > 400:
        raise BadRequest(
            f"That range covers {len(keys)} nights; recompute at most 400 at a time.",
            code="range_too_large",
            detail={"nights": len(keys)},
        )

    done: list[str] = []
    failed: list[dict[str, str]] = []
    for key in keys:
        try:
            runtime.recompute_night(child.id, key)
            done.append(key)
        except Exception as exc:
            failed.append({"night_of": key, "error": str(exc)})
    return {"child_id": child.id, "recomputed": done, "failed": failed,
            "from": start, "to": end}


def _child_for(repos: Repos, child_id: int | None) -> Child:
    child = repos.children.get(child_id) if child_id is not None else repos.children.default()
    if child is None:
        raise NotFound("No such child.", detail={"child_id": child_id})
    return child


# ---------------------------------------------------------------------------
# Host introspection. All best-effort: none of it is worth an error response.
# ---------------------------------------------------------------------------


def _pi_model() -> str | None:
    try:
        return Path("/proc/device-tree/model").read_text(encoding="utf-8").strip("\x00 \n") or None
    except OSError:
        return None


def _host_uptime_s() -> float | None:
    try:
        with open("/proc/uptime", encoding="utf-8") as fh:
            return float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def _temperatures() -> dict[str, float]:
    """Thermal zones in °C. On a Pi, zone 0 is the SoC and it throttles at 80."""
    out: dict[str, float] = {}
    base = Path("/sys/class/thermal")
    if not base.is_dir():
        return out
    try:
        zones = sorted(base.glob("thermal_zone*"))
    except OSError:
        return out
    for zone in zones:
        try:
            name = (zone / "type").read_text(encoding="utf-8").strip()
            millidegrees = int((zone / "temp").read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            continue
        out[name or zone.name] = round(millidegrees / 1000.0, 1)
    return out


def _disk(path: str) -> dict[str, Any]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return {"path": path, "available": False}
    return {
        "path": path,
        "available": True,
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "used_fraction": round(usage.used / usage.total, 4) if usage.total else None,
    }


def _media_usage(media_dir: str, repos: Repos) -> dict[str, Any]:
    return {"dir": media_dir, "tracked_bytes": repos.media.total_bytes()}
