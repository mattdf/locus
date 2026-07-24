"""Durable job, document, chat, quota, and Mistral-usage storage."""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator, Sequence


class QuotaExceededError(RuntimeError):
    """Raised when a user or upstream-key page cap would be exceeded."""


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def current_period() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


def tenant_storage_key(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


@dataclass(frozen=True)
class ImportReservation:
    job_id: str
    chat_id: str
    document_id: str
    api_key_id: str
    storage_relpath: str


class PersistentStore:
    """Small SQLite repository designed for one service container."""

    def __init__(
        self,
        database_path: Path,
        *,
        default_user_monthly_page_cap: int | None = None,
        default_key_monthly_page_cap: int | None = None,
    ) -> None:
        self.database_path = database_path
        self.default_user_monthly_page_cap = default_user_monthly_page_cap
        self.default_key_monthly_page_cap = default_key_monthly_page_cap

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            self.database_path,
            timeout=30,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(
        self,
        api_keys: Sequence[tuple[str, str, str]],
    ) -> None:
        """Create the schema and synchronize configured key fingerprints."""
        with self.connection() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    monthly_page_cap INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS api_keys (
                    key_id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    monthly_page_cap INTEGER,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chats (
                    chat_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(user_id),
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    document_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS documents (
                    document_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(user_id),
                    chat_id TEXT NOT NULL REFERENCES chats(chat_id),
                    title TEXT NOT NULL,
                    source_filename TEXT NOT NULL,
                    storage_relpath TEXT NOT NULL UNIQUE,
                    page_count INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    markdown_relpath TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(user_id),
                    chat_id TEXT NOT NULL REFERENCES chats(chat_id),
                    document_id TEXT NOT NULL REFERENCES documents(document_id),
                    api_key_id TEXT NOT NULL REFERENCES api_keys(key_id),
                    status TEXT NOT NULL,
                    reserved_pages INTEGER NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS usage_events (
                    usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
                    user_id TEXT NOT NULL REFERENCES users(user_id),
                    api_key_id TEXT NOT NULL REFERENCES api_keys(key_id),
                    period TEXT NOT NULL,
                    pages_processed INTEGER NOT NULL,
                    quota_pages INTEGER NOT NULL,
                    usage_estimated INTEGER NOT NULL DEFAULT 0,
                    doc_size_bytes INTEGER,
                    model TEXT,
                    outcome TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS jobs_user_created_idx
                    ON jobs(user_id, created_at);
                CREATE INDEX IF NOT EXISTS jobs_status_idx
                    ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS usage_user_period_idx
                    ON usage_events(user_id, period);
                CREATE INDEX IF NOT EXISTS usage_key_period_idx
                    ON usage_events(api_key_id, period);
                """
            )
            usage_columns = {
                row["name"]
                for row in connection.execute(
                    "PRAGMA table_info(usage_events)"
                ).fetchall()
            }
            if "quota_pages" not in usage_columns:
                connection.execute(
                    "ALTER TABLE usage_events "
                    "ADD COLUMN quota_pages INTEGER NOT NULL DEFAULT 0"
                )
                connection.execute(
                    "UPDATE usage_events SET quota_pages = pages_processed"
                )
            if "usage_estimated" not in usage_columns:
                connection.execute(
                    "ALTER TABLE usage_events "
                    "ADD COLUMN usage_estimated INTEGER NOT NULL DEFAULT 0"
                )
            now = utc_now()
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("UPDATE api_keys SET active = 0, updated_at = ?", (now,))
                for key_id, label, fingerprint in api_keys:
                    connection.execute(
                        """
                        INSERT INTO api_keys (
                            key_id, label, fingerprint, monthly_page_cap,
                            active, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, 1, ?, ?)
                        ON CONFLICT(key_id) DO UPDATE SET
                            label = excluded.label,
                            fingerprint = excluded.fingerprint,
                            active = 1,
                            updated_at = excluded.updated_at
                        """,
                        (
                            key_id,
                            label,
                            fingerprint,
                            self.default_key_monthly_page_cap,
                            now,
                            now,
                        ),
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    @staticmethod
    def _actual_usage(
        connection: sqlite3.Connection,
        *,
        period: str,
        user_id: str | None = None,
        key_id: str | None = None,
    ) -> int:
        conditions = ["period = ?"]
        parameters: list[Any] = [period]
        if user_id is not None:
            conditions.append("user_id = ?")
            parameters.append(user_id)
        if key_id is not None:
            conditions.append("api_key_id = ?")
            parameters.append(key_id)
        row = connection.execute(
            f"""
            SELECT COALESCE(SUM(quota_pages), 0) AS pages
            FROM usage_events
            WHERE {" AND ".join(conditions)}
            """,
            parameters,
        ).fetchone()
        return int(row["pages"])

    @staticmethod
    def _reserved_usage(
        connection: sqlite3.Connection,
        *,
        period: str,
        user_id: str | None = None,
        key_id: str | None = None,
    ) -> int:
        conditions = [
            "substr(j.created_at, 1, 7) = ?",
            "j.status IN ('queued', 'running')",
            "u.job_id IS NULL",
        ]
        parameters: list[Any] = [period]
        if user_id is not None:
            conditions.append("j.user_id = ?")
            parameters.append(user_id)
        if key_id is not None:
            conditions.append("j.api_key_id = ?")
            parameters.append(key_id)
        row = connection.execute(
            f"""
            SELECT COALESCE(SUM(j.reserved_pages), 0) AS pages
            FROM jobs AS j
            LEFT JOIN usage_events AS u ON u.job_id = j.job_id
            WHERE {" AND ".join(conditions)}
            """,
            parameters,
        ).fetchone()
        return int(row["pages"])

    def create_import(
        self,
        *,
        user_id: str,
        title: str,
        source_filename: str,
        page_count: int,
        candidate_key_ids: Sequence[str],
    ) -> ImportReservation:
        if not candidate_key_ids:
            raise RuntimeError("No Mistral API keys are configured")

        job_id = uuid.uuid4().hex
        chat_id = uuid.uuid4().hex
        document_id = uuid.uuid4().hex
        storage_relpath = (
            f"tenants/{tenant_storage_key(user_id)}/documents/{document_id}"
        )
        period = current_period()
        now = utc_now()

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO users (
                        user_id, monthly_page_cap, created_at, updated_at
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(user_id) DO NOTHING
                    """,
                    (
                        user_id,
                        self.default_user_monthly_page_cap,
                        now,
                        now,
                    ),
                )
                user = connection.execute(
                    "SELECT monthly_page_cap FROM users WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                user_used = self._actual_usage(
                    connection,
                    period=period,
                    user_id=user_id,
                )
                user_reserved = self._reserved_usage(
                    connection,
                    period=period,
                    user_id=user_id,
                )
                user_cap = user["monthly_page_cap"]
                if (
                    user_cap is not None
                    and user_used + user_reserved + page_count > int(user_cap)
                ):
                    raise QuotaExceededError(
                        "User monthly Mistral OCR page cap would be exceeded"
                    )

                available_keys: list[tuple[float, int, str]] = []
                for key_id in candidate_key_ids:
                    key = connection.execute(
                        """
                        SELECT monthly_page_cap
                        FROM api_keys
                        WHERE key_id = ? AND active = 1
                        """,
                        (key_id,),
                    ).fetchone()
                    if key is None:
                        continue
                    used = self._actual_usage(
                        connection,
                        period=period,
                        key_id=key_id,
                    )
                    reserved = self._reserved_usage(
                        connection,
                        period=period,
                        key_id=key_id,
                    )
                    total = used + reserved
                    cap = key["monthly_page_cap"]
                    if cap is not None and total + page_count > int(cap):
                        continue
                    load = total / int(cap) if cap else float(total)
                    available_keys.append((load, total, key_id))

                if not available_keys:
                    raise QuotaExceededError(
                        "All configured Mistral API keys are at their monthly page cap"
                    )
                api_key_id = min(available_keys)[2]

                connection.execute(
                    """
                    INSERT INTO chats (
                        chat_id, user_id, title, status, document_id,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, 'importing', ?, ?, ?)
                    """,
                    (chat_id, user_id, title, document_id, now, now),
                )
                connection.execute(
                    """
                    INSERT INTO documents (
                        document_id, user_id, chat_id, title, source_filename,
                        storage_relpath, page_count, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'importing', ?, ?)
                    """,
                    (
                        document_id,
                        user_id,
                        chat_id,
                        title,
                        source_filename,
                        storage_relpath,
                        page_count,
                        now,
                        now,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO jobs (
                        job_id, user_id, chat_id, document_id, api_key_id,
                        status, reserved_pages, created_at
                    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
                    """,
                    (
                        job_id,
                        user_id,
                        chat_id,
                        document_id,
                        api_key_id,
                        page_count,
                        now,
                    ),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

        return ImportReservation(
            job_id=job_id,
            chat_id=chat_id,
            document_id=document_id,
            api_key_id=api_key_id,
            storage_relpath=storage_relpath,
        )

    def claim_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                changed = connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'running', started_at = ?
                    WHERE job_id = ? AND status = 'queued'
                    """,
                    (utc_now(), job_id),
                ).rowcount
                if not changed:
                    connection.rollback()
                    return None
                job = connection.execute(
                    """
                    SELECT j.*, d.storage_relpath, d.source_filename,
                           d.page_count, d.title
                    FROM jobs AS j
                    JOIN documents AS d ON d.document_id = j.document_id
                    WHERE j.job_id = ?
                    """,
                    (job_id,),
                ).fetchone()
                connection.commit()
                return _row(job)
            except Exception:
                connection.rollback()
                raise

    def record_usage(
        self,
        *,
        job_id: str,
        pages_processed: int,
        quota_pages: int | None = None,
        usage_estimated: bool = False,
        doc_size_bytes: int | None,
        model: str | None,
        outcome: str,
    ) -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                """
                INSERT INTO usage_events (
                    job_id, user_id, api_key_id, period, pages_processed,
                    quota_pages, usage_estimated, doc_size_bytes, model,
                    outcome, created_at, updated_at
                )
                SELECT job_id, user_id, api_key_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
                FROM jobs
                WHERE job_id = ?
                ON CONFLICT(job_id) DO UPDATE SET
                    pages_processed = excluded.pages_processed,
                    quota_pages = excluded.quota_pages,
                    usage_estimated = excluded.usage_estimated,
                    doc_size_bytes = excluded.doc_size_bytes,
                    model = excluded.model,
                    outcome = excluded.outcome,
                    updated_at = excluded.updated_at
                """,
                (
                    current_period(),
                    max(0, pages_processed),
                    max(
                        0,
                        pages_processed if quota_pages is None else quota_pages,
                    ),
                    int(usage_estimated),
                    doc_size_bytes,
                    model,
                    outcome,
                    now,
                    now,
                    job_id,
                ),
            )

    def complete_job(self, job_id: str, markdown_relpath: str) -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                job = connection.execute(
                    "SELECT document_id, chat_id FROM jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
                if job is None:
                    raise KeyError(job_id)
                connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'completed', completed_at = ?, error = NULL
                    WHERE job_id = ?
                    """,
                    (now, job_id),
                )
                connection.execute(
                    """
                    UPDATE documents
                    SET status = 'ready', markdown_relpath = ?, updated_at = ?
                    WHERE document_id = ?
                    """,
                    (markdown_relpath, now, job["document_id"]),
                )
                connection.execute(
                    """
                    UPDATE chats
                    SET status = 'ready', updated_at = ?
                    WHERE chat_id = ?
                    """,
                    (now, job["chat_id"]),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def fail_job(self, job_id: str, error: str) -> None:
        now = utc_now()
        safe_error = error[:2000]
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                job = connection.execute(
                    "SELECT document_id, chat_id FROM jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
                if job is None:
                    connection.rollback()
                    return
                connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'failed', completed_at = ?, error = ?
                    WHERE job_id = ?
                    """,
                    (now, safe_error, job_id),
                )
                connection.execute(
                    """
                    UPDATE documents
                    SET status = 'failed', updated_at = ?
                    WHERE document_id = ?
                    """,
                    (now, job["document_id"]),
                )
                connection.execute(
                    """
                    UPDATE chats
                    SET status = 'failed', updated_at = ?
                    WHERE chat_id = ?
                    """,
                    (now, job["chat_id"]),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def mark_interrupted_jobs_failed(self) -> int:
        """Avoid silently double-billing jobs that died during an OCR call."""
        with self.connection() as connection:
            running = [
                (row["job_id"], int(row["reserved_pages"]))
                for row in connection.execute(
                    """
                    SELECT job_id, reserved_pages
                    FROM jobs
                    WHERE status = 'running'
                    """
                ).fetchall()
            ]
        for job_id, reserved_pages in running:
            if self.usage_event_for_job(job_id) is None:
                self.record_usage(
                    job_id=job_id,
                    pages_processed=0,
                    quota_pages=reserved_pages,
                    usage_estimated=True,
                    doc_size_bytes=None,
                    model=None,
                    outcome="interrupted_api_usage_estimated",
                )
            self.fail_job(
                job_id,
                "Service restarted while the job was running; retry was not automatic "
                "to avoid a duplicate Mistral charge.",
            )
        return len(running)

    def queued_job_ids(self) -> list[str]:
        with self.connection() as connection:
            return [
                row["job_id"]
                for row in connection.execute(
                    "SELECT job_id FROM jobs WHERE status = 'queued' ORDER BY created_at"
                ).fetchall()
            ]

    def get_job_for_user(
        self,
        job_id: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        with self.connection() as connection:
            return _row(
                connection.execute(
                    """
                    SELECT job_id, chat_id, document_id, status, reserved_pages,
                           error, created_at, started_at, completed_at
                    FROM jobs
                    WHERE job_id = ? AND user_id = ?
                    """,
                    (job_id, user_id),
                ).fetchone()
            )

    def get_chat_for_user(
        self,
        chat_id: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        with self.connection() as connection:
            return _row(
                connection.execute(
                    """
                    SELECT c.*, d.source_filename, d.page_count,
                           d.markdown_relpath, d.status AS document_status,
                           d.storage_relpath
                    FROM chats AS c
                    LEFT JOIN documents AS d ON d.document_id = c.document_id
                    WHERE c.chat_id = ? AND c.user_id = ?
                    """,
                    (chat_id, user_id),
                ).fetchone()
            )

    def get_document_for_user(
        self,
        document_id: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        with self.connection() as connection:
            return _row(
                connection.execute(
                    """
                    SELECT *
                    FROM documents
                    WHERE document_id = ? AND user_id = ?
                    """,
                    (document_id, user_id),
                ).fetchone()
            )

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return _row(
                connection.execute(
                    """
                    SELECT j.*, d.storage_relpath, d.source_filename,
                           d.page_count, d.title
                    FROM jobs AS j
                    JOIN documents AS d ON d.document_id = j.document_id
                    WHERE j.job_id = ?
                    """,
                    (job_id,),
                ).fetchone()
            )

    def usage_event_for_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return _row(
                connection.execute(
                    "SELECT * FROM usage_events WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
            )

    def list_users(self, period: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT u.user_id, u.monthly_page_cap, u.created_at, u.updated_at,
                       COALESCE(SUM(e.pages_processed), 0) AS pages_processed,
                       COALESCE(SUM(e.quota_pages), 0) AS quota_pages,
                       COALESCE(SUM(
                           CASE WHEN e.usage_estimated = 1
                                THEN e.quota_pages ELSE 0 END
                       ), 0) AS estimated_pages,
                       COUNT(e.usage_id) AS api_calls
                FROM users AS u
                LEFT JOIN usage_events AS e
                  ON e.user_id = u.user_id AND e.period = ?
                GROUP BY u.user_id
                ORDER BY u.user_id
                """,
                (period,),
            ).fetchall()
            result = [dict(row) for row in rows]
            for item in result:
                item["reserved_pages"] = self._reserved_usage(
                    connection,
                    period=period,
                    user_id=item["user_id"],
                )
            return result

    def list_api_keys(self, period: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT k.key_id, k.label, k.fingerprint, k.monthly_page_cap,
                       k.active, k.created_at, k.updated_at,
                       COALESCE(SUM(e.pages_processed), 0) AS pages_processed,
                       COALESCE(SUM(e.quota_pages), 0) AS quota_pages,
                       COALESCE(SUM(
                           CASE WHEN e.usage_estimated = 1
                                THEN e.quota_pages ELSE 0 END
                       ), 0) AS estimated_pages,
                       COUNT(e.usage_id) AS api_calls
                FROM api_keys AS k
                LEFT JOIN usage_events AS e
                  ON e.api_key_id = k.key_id AND e.period = ?
                GROUP BY k.key_id
                ORDER BY k.key_id
                """,
                (period,),
            ).fetchall()
            result = [dict(row) for row in rows]
            for item in result:
                item["active"] = bool(item["active"])
                item["reserved_pages"] = self._reserved_usage(
                    connection,
                    period=period,
                    key_id=item["key_id"],
                )
            return result

    def usage_summary(self, period: str) -> dict[str, Any]:
        users = self.list_users(period)
        keys = self.list_api_keys(period)
        return {
            "period": period,
            "pages_processed": sum(item["pages_processed"] for item in users),
            "quota_pages": sum(item["quota_pages"] for item in users),
            "estimated_pages": sum(item["estimated_pages"] for item in users),
            "reserved_pages": sum(item["reserved_pages"] for item in users),
            "api_calls": sum(item["api_calls"] for item in users),
            "users": users,
            "api_keys": keys,
        }

    def set_user_cap(self, user_id: str, cap: int | None) -> bool:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                """
                INSERT INTO users (user_id, monthly_page_cap, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    monthly_page_cap = excluded.monthly_page_cap,
                    updated_at = excluded.updated_at
                """,
                (user_id, cap, now, now),
            )
        return True

    def set_key_cap(self, key_id: str, cap: int | None) -> bool:
        with self.connection() as connection:
            changed = connection.execute(
                """
                UPDATE api_keys
                SET monthly_page_cap = ?, updated_at = ?
                WHERE key_id = ?
                """,
                (cap, utc_now(), key_id),
            ).rowcount
            return bool(changed)
