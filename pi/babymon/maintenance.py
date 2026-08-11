"""Nightly housekeeping: retention, backups, database upkeep.

Runs once a day, at the day boundary. Everything here is best-effort and
individually guarded — a full disk must not stop the monitor from monitoring,
it must only stop it from writing new clips.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .config import Config
from .storage import Repos
from .timeutil import now_ms

log = logging.getLogger(__name__)

__all__ = ["run_maintenance", "prune", "backup"]

DAY_MS = 86_400_000


def run_maintenance(config: Config, repos: Repos) -> dict[str, int]:
    """Prune, back up and optimise. Returns a summary for the system log."""
    summary: dict[str, int] = {}
    for name, task in (("prune", prune), ("backup", backup), ("optimise", optimise)):
        try:
            summary.update(task(config, repos))
        except Exception:  # noqa: BLE001 - housekeeping is never worth a crash
            log.exception("%s failed", name)
    repos.syslog.add("info", "maintenance", "nightly maintenance finished", **summary)
    return summary


def prune(config: Config, repos: Repos) -> dict[str, int]:
    """Delete data past its retention window, and the files that go with it."""
    retention = config.retention
    now = now_ms()
    summary: dict[str, int] = {}

    if retention.samples_days > 0:
        summary["samples_pruned"] = repos.samples.prune(now - retention.samples_days * DAY_MS)
    if retention.events_days > 0:
        summary["events_pruned"] = repos.events.prune(now - retention.events_days * DAY_MS)
    if retention.system_log_days > 0:
        summary["log_pruned"] = repos.syslog.prune(now - retention.system_log_days * DAY_MS)

    media_dir = Path(config.paths.media_dir)
    removed = 0
    for item in repos.media.expired(now, limit=5000):
        _unlink(media_dir / item.rel_path)
        repos.media.delete(item.id)
        removed += 1

    # A size cap on top of the age cap: a noisy fortnight can blow the disk
    # budget long before anything is old enough to expire.
    if retention.media_max_gb > 0:
        cap = int(retention.media_max_gb * 1024**3)
        total = repos.media.total_bytes()
        while total > cap:
            oldest = repos.media.oldest(limit=200)
            if not oldest:
                break
            for item in oldest:
                _unlink(media_dir / item.rel_path)
                repos.media.delete(item.id)
                total -= item.bytes or 0
                removed += 1
                if total <= cap:
                    break
    summary["media_pruned"] = removed

    _prune_empty_dirs(media_dir)
    if removed:
        log.info("pruned %d media file(s)", removed)
    return summary


def backup(config: Config, repos: Repos) -> dict[str, int]:
    """VACUUM INTO a dated copy, then keep only the most recent few."""
    if not config.backup.enabled:
        return {}
    directory = Path(config.backup.dir)
    directory.mkdir(parents=True, exist_ok=True)
    from .timeutil import from_ms

    stamp = from_ms(now_ms(), config.timezone).strftime("%Y%m%d")
    destination = directory / f"babymon-{stamp}.db"
    repos.db.backup_to(destination)

    backups = sorted(directory.glob("babymon-*.db"), reverse=True)
    removed = 0
    for stale in backups[max(1, config.backup.keep) :]:
        _unlink(stale)
        removed += 1
    log.info("backed up to %s (%d old backup(s) removed)", destination, removed)
    return {"backups_removed": removed}


def optimise(config: Config, repos: Repos) -> dict[str, int]:
    """Checkpoint the WAL and refresh the query planner's statistics."""
    repos.db.checkpoint("TRUNCATE")
    repos.db.optimize()
    return {}


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("could not delete %s: %s", path, exc)


def _prune_empty_dirs(root: Path) -> None:
    """Remove per-night directories left behind once their files are gone."""
    if not root.exists():
        return
    for directory in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if directory.is_dir():
            try:
                next(directory.iterdir())
            except StopIteration:
                directory.rmdir()
            except OSError:
                continue
