"""Schema migrations.

``schema.sql`` creates version 1. Every later change is a function here.

Rules:

* A migration takes a ``sqlite3.Connection`` inside an open transaction and
  must be idempotent enough to survive being re-run after a crash halfway
  through (use ``IF NOT EXISTS`` / check ``PRAGMA table_info`` first).
* Never edit an existing migration once it has shipped; add another.
* ``schema.sql`` stays the *initial* schema. A fresh install runs it and then
  every migration in turn, so the two paths must converge on the same result —
  :func:`babymon.storage.migrations.verify_convergence` checks that in the
  test suite.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator

Migration = tuple[int, str, Callable[[sqlite3.Connection], None]]

_MIGRATIONS: list[Migration] = []


def migration(version: int, name: str) -> Callable[[Callable[[sqlite3.Connection], None]], Callable[[sqlite3.Connection], None]]:
    def decorate(fn: Callable[[sqlite3.Connection], None]) -> Callable[[sqlite3.Connection], None]:
        if any(v == version for v, _, _ in _MIGRATIONS):
            raise RuntimeError(f"duplicate migration version {version}")
        _MIGRATIONS.append((version, name, fn))
        _MIGRATIONS.sort(key=lambda m: m[0])
        return fn

    return decorate


def pending(current_version: int) -> Iterator[Migration]:
    """Migrations that still need applying, in order."""
    for version, name, fn in _MIGRATIONS:
        if version > current_version:
            yield version, name, fn


def latest_version() -> int:
    return max((v for v, _, _ in _MIGRATIONS), default=1)


# ---------------------------------------------------------------------------
# Helpers for writing migrations
# ---------------------------------------------------------------------------


def has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    return any(r[1] == column for r in rows)


def add_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """``ALTER TABLE ADD COLUMN``, skipped if the column is already there."""
    if not has_column(conn, table, column):
        conn.execute(f'ALTER TABLE "{table}" ADD COLUMN {column} {decl}')


def has_table(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

# Version 1 is schema.sql itself; no function for it.
#
# Example of what a future migration looks like:
#
# @migration(2, "add nights.nap_min")
# def _add_nap_min(conn: sqlite3.Connection) -> None:
#     add_column(conn, "nights", "nap_min", "REAL")
