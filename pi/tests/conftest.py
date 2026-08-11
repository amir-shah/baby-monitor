"""Shared fixtures.

Every test gets its own temporary data directory and database, so nothing here
touches a real installation and tests can run in parallel.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest

from babymon.config import Config, load_config
from babymon.storage import Database, Repos, open_database


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "data"
    directory.mkdir()
    return directory


@pytest.fixture()
def config(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setenv("BABYMON_PATHS__DATA_DIR", str(data_dir))
    monkeypatch.setenv("BABYMON_API__AUTH__ENABLED", "false")
    monkeypatch.setenv("BABYMON_SITE__TIMEZONE", "America/Los_Angeles")
    monkeypatch.setenv("BABYMON_CAMERA__SOURCE", "synthetic")
    monkeypatch.setenv("BABYMON_AUDIO__ENABLED", "false")
    monkeypatch.setenv("BABYMON_ENVIRONMENT__SENSOR", "synthetic")
    cfg = load_config(Path(__file__).resolve().parents[2] / "config" / "babymon.example.yaml")
    cfg.paths.ensure()
    return cfg


@pytest.fixture()
def db(config: Config) -> Database:
    database = open_database(config.paths.db)
    yield database
    database.close()


@pytest.fixture()
def repos(db: Database, config: Config) -> Repos:
    repositories = Repos(db)
    repositories.bootstrap(config)
    return repositories


@pytest.fixture()
def child(repos: Repos):
    return repos.children.default()


@pytest.fixture()
def today() -> str:
    return dt.date.today().isoformat()
