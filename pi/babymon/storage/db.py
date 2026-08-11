"""SQLite connection management and migrations.

Design notes, since a 24/7 embedded logger has some sharp edges:

* **WAL mode.** A reader (the API answering a dashboard request) must never
  block the writer (the sensing loop writing a sample every 15 s), and vice
  versa. WAL is what makes that true.
* **One connection per thread.** ``sqlite3`` connections are not safe to share
  across threads, so :class:`Database` keeps a thread-local connection and
  hands out the right one. The API runs in a thread pool; the sensing loop has
  its own thread. Both go through here.
* **``synchronous=NORMAL``.** With WAL this is durable against process crashes
  (only a power cut can lose the last transactions), and it removes an fsync
  from every commit — which matters a great deal when the database lives on an
  SD card.
* **Timestamps are integers.** No ``TEXT`` dates, no local time. See
  :mod:`babymon.timeutil`.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..timeutil import now_ms

log = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

#: Bumped whenever a migration is added. ``user_version`` in the database is
#: compared against this on open.
SCHEMA_VERSION = 1


class Database:
    """Owns the SQLite file and hands out per-thread connections."""

    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        timeout_s: float = 15.0,
        read_only: bool = False,
    ) -> None:
        self.path = Path(path)
        self.timeout_s = timeout_s
        self.read_only = read_only
        self._local = threading.local()
        self._all_conns: list[sqlite3.Connection] = []
        self._lock = threading.Lock()
        self._closed = False
        if not read_only:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    # -- connections -------------------------------------------------------

    @property
    def conn(self) -> sqlite3.Connection:
        """The calling thread's connection, opened on first use."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
            with self._lock:
                if self._closed:
                    conn.close()
                    raise RuntimeError("database is closed")
                self._all_conns.append(conn)
        return conn

    def _connect(self) -> sqlite3.Connection:
        if self.read_only:
            uri = f"file:{self.path}?mode=ro"
            conn = sqlite3.connect(uri, uri=True, timeout=self.timeout_s, check_same_thread=False)
        else:
            conn = sqlite3.connect(
                str(self.path),
                timeout=self.timeout_s,
                check_same_thread=False,
                isolation_level=None,  # explicit transactions; see transaction()
            )
        conn.row_factory = sqlite3.Row
        self._apply_pragmas(conn)
        return conn

    def _apply_pragmas(self, conn: sqlite3.Connection) -> None:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(f"PRAGMA busy_timeout = {int(self.timeout_s * 1000)}")
        if self.read_only:
            return
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        # Keep the WAL from growing without bound on a machine that is never
        # idle; 4 MB is roughly 1000 pages.
        conn.execute("PRAGMA journal_size_limit = 4194304")
        conn.execute("PRAGMA wal_autocheckpoint = 1000")
        conn.execute("PRAGMA temp_store = MEMORY")
        # 16 MB page cache. Generous for a Pi but small next to the media
        # buffers, and it keeps the analytics queries off the disk.
        conn.execute("PRAGMA cache_size = -16000")
        conn.execute("PRAGMA mmap_size = 67108864")

    def close(self) -> None:
        with self._lock:
            self._closed = True
            conns, self._all_conns = self._all_conns, []
        for conn in conns:
            # Best effort: a connection that is already broken cannot be made
            # any more closed, and shutdown must not raise.
            with contextlib.suppress(sqlite3.Error):
                conn.close()
        self._local = threading.local()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transactions ------------------------------------------------------

    @contextmanager
    def transaction(self, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
        """A single write transaction, committed on success, rolled back on error.

        ``BEGIN IMMEDIATE`` takes the write lock up front. Without it, a
        transaction that reads and then writes can fail with SQLITE_BUSY partway
        through and has to be retried from the beginning — which is exactly the
        bug that shows up once a month at 3am and never in testing.
        """
        conn = self.conn
        if conn.in_transaction:
            # Nested: join the enclosing transaction rather than committing
            # halfway through it.
            yield conn
            return
        conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")

    # -- convenience -------------------------------------------------------

    def execute(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, params)

    def executemany(self, sql: str, rows: Sequence[Sequence[Any]]) -> sqlite3.Cursor:
        return self.conn.executemany(sql, rows)

    def query(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> list[sqlite3.Row]:
        return self.conn.execute(sql, params).fetchall()

    def query_one(
        self, sql: str, params: Sequence[Any] | dict[str, Any] = ()
    ) -> sqlite3.Row | None:
        return self.conn.execute(sql, params).fetchone()

    def scalar(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> Any:
        row = self.query_one(sql, params)
        return None if row is None else row[0]

    # -- schema ------------------------------------------------------------

    def migrate(self) -> int:
        """Bring the database up to :data:`SCHEMA_VERSION`. Returns the version."""
        if self.read_only:
            raise RuntimeError("cannot migrate a read-only database")
        conn = self.conn
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise RuntimeError(
                f"database at {self.path} has schema version {current}, but this "
                f"build only understands up to {SCHEMA_VERSION}. Downgrading is not "
                "supported; restore a backup or point paths.db elsewhere."
            )
        if current == SCHEMA_VERSION:
            return current

        from . import migrations

        if current == 0:
            log.info("creating database schema at %s", self.path)
            # executescript() implicitly commits before it runs, so it cannot
            # be wrapped in our own transaction. The script is written entirely
            # with IF NOT EXISTS, so a crash partway through is recoverable by
            # simply running it again.
            conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            current = 1
            conn.execute(f"PRAGMA user_version = {current}")

        for version, name, apply in migrations.pending(current):
            log.info("applying migration %d (%s)", version, name)
            with self.transaction():
                apply(conn)
            conn.execute(f"PRAGMA user_version = {version}")
            current = version

        # A migration may have added tables that the base schema's PRAGMA
        # foreign_keys could not check while it was mid-flight.
        broken = conn.execute("PRAGMA foreign_key_check").fetchall()
        if broken:
            log.warning("foreign key violations after migration: %d row(s)", len(broken))
        return current

    def version(self) -> int:
        return int(self.conn.execute("PRAGMA user_version").fetchone()[0])

    # -- maintenance -------------------------------------------------------

    def checkpoint(self, mode: str = "PASSIVE") -> None:
        """Fold the WAL back into the main database file."""
        if mode not in ("PASSIVE", "FULL", "RESTART", "TRUNCATE"):
            raise ValueError(f"unknown checkpoint mode {mode!r}")
        self.conn.execute(f"PRAGMA wal_checkpoint({mode})")

    def optimize(self) -> None:
        """Refresh the query planner's statistics. Cheap; run it nightly."""
        self.conn.execute("PRAGMA optimize")

    def backup_to(self, dest: str | os.PathLike[str]) -> Path:
        """Write a consistent copy of the database, safe to run while live.

        ``VACUUM INTO`` produces a compacted single file with no WAL alongside
        it, which is exactly what you want to copy off the Pi.
        """
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        self.conn.execute("VACUUM INTO ?", (str(dest),))
        return dest

    def integrity_check(self) -> list[str]:
        rows = self.conn.execute("PRAGMA integrity_check").fetchall()
        results = [r[0] for r in rows]
        return [] if results == ["ok"] else results

    def stats(self) -> dict[str, Any]:
        """Size and row counts, for the System page and ``/api/metrics``."""
        page_size = self.scalar("PRAGMA page_size") or 0
        page_count = self.scalar("PRAGMA page_count") or 0
        freelist = self.scalar("PRAGMA freelist_count") or 0
        tables = [
            r[0]
            for r in self.query(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        counts: dict[str, int] = {}
        for table in tables:
            try:
                counts[table] = int(self.scalar(f'SELECT COUNT(*) FROM "{table}"') or 0)
            except sqlite3.Error:  # pragma: no cover
                counts[table] = -1
        wal = self.path.with_name(self.path.name + "-wal")
        usage = shutil.disk_usage(self.path.parent) if self.path.parent.exists() else None
        return {
            "path": str(self.path),
            "schema_version": self.version(),
            "size_bytes": page_size * page_count,
            "free_bytes": page_size * freelist,
            "wal_bytes": wal.stat().st_size if wal.exists() else 0,
            "rows": counts,
            "disk_total_bytes": usage.total if usage else None,
            "disk_free_bytes": usage.free if usage else None,
        }


# ---------------------------------------------------------------------------


def open_database(path: str | os.PathLike[str], *, migrate: bool = True) -> Database:
    """Open (creating if needed) and migrate a database."""
    db = Database(path)
    if migrate:
        db.migrate()
    return db


def utcnow_ms() -> int:
    """Re-exported so storage code does not have to reach into timeutil."""
    return now_ms()
