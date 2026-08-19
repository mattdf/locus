from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

from pdf2markdown.markdown_repair import (
    PROMPT_VERSION,
    RepairSettings,
    repair_document_markdown,
)


class RepairStore:
    def __init__(self) -> None:
        self.pages: dict[tuple[str, int, str, str], dict[str, Any]] = {}
        self.progress: list[dict[str, Any]] = []

    def set_job_progress(self, job_id: str, **values: Any) -> None:
        self.progress.append({"job_id": job_id, **values})

    def get_repair_page(self, **key: Any) -> dict[str, Any] | None:
        return self.pages.get(
            (
                key["document_id"],
                key["page_number"],
                key["source_sha256"],
                key["prompt_version"],
            )
        )

    def start_repair_page(self, **values: Any) -> None:
        self.pages[
            (
                values["document_id"],
                values["page_number"],
                values["source_sha256"],
                values["prompt_version"],
            )
        ] = {"status": "running"}

    def finish_repair_page(self, **values: Any) -> None:
        self.pages[
            (
                values["document_id"],
                values["page_number"],
                values["source_sha256"],
                values["prompt_version"],
            )
        ] = {"status": "completed", **values}

    def fail_repair_page(self, **values: Any) -> None:
        raise AssertionError(values)


def test_repairs_pages_and_reuses_completed_cache(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    document_root = tmp_path / "document"
    result_dir = document_root / "result" / "book"
    pages_dir = result_dir / "pages-hq"
    pages_dir.mkdir(parents=True)
    (pages_dir / "page-0003.md").write_text("Page three.\n", encoding="utf-8")
    (pages_dir / "page-0004.md").write_text("```ruby\nMath prose.\n```\n", encoding="utf-8")
    hq_path = result_dir / "book-hq.md"
    hq_path.write_text("unused combined source\n", encoding="utf-8")
    calls: list[dict[str, Any]] = []

    def fake_repair(_settings: RepairSettings, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append(payload)
        markdown = payload["markdown"].replace("```ruby\n", "").replace("\n```", "")
        return {
            "markdown": markdown,
            "changed": markdown != payload["markdown"],
            "editCount": int(markdown != payload["markdown"]),
            "mathNodeCount": 0,
            "summary": "Removed a false fence" if markdown != payload["markdown"] else "No changes",
            "furniture": {
                "headers": [
                    {
                        "content": "Page three.",
                        "align": "left",
                        "row": 0,
                        "row_index": 0,
                        "row_size": 1,
                        "block_index": 0,
                    }
                ] if payload["pageNumber"] == 3 else [],
                "footers": [],
            },
            "model": "test-model",
        }

    monkeypatch.setattr(
        "pdf2markdown.markdown_repair._repair_with_retries",
        fake_repair,
    )
    store = RepairStore()
    job = {
        "job_id": "job-one",
        "document_id": "document-one",
        "user_id": "user-one",
    }
    settings = RepairSettings(
        service_url="http://repair.invalid/page",
        admin_token="test-token",
    )
    output = repair_document_markdown(
        job=job,
        document_root=document_root,
        hq_markdown_path=hq_path,
        settings=settings,
        store=store,  # type: ignore[arg-type]
    )
    assert sorted(call["pageNumber"] for call in calls) == [3, 4]
    assert all(len(call["contextPages"]) == 2 for call in calls)
    assert "**Page 3**" in output.read_text(encoding="utf-8")
    assert "```ruby" not in output.read_text(encoding="utf-8")
    assert store.progress[-1]["stage"] == "assembling"
    layout = result_dir / f"repair-layout-{PROMPT_VERSION}.json"
    assert '"page": 3' in layout.read_text(encoding="utf-8")

    calls.clear()
    cached = repair_document_markdown(
        job=job,
        document_root=document_root,
        hq_markdown_path=hq_path,
        settings=settings,
        store=store,  # type: ignore[arg-type]
    )
    assert cached == output
    assert calls == []
    assert all(key[-1] == PROMPT_VERSION for key in store.pages)


def test_repair_sends_two_pages_on_each_side(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    document_root = tmp_path / "document"
    result_dir = document_root / "result" / "book"
    pages_dir = result_dir / "pages-hq"
    pages_dir.mkdir(parents=True)
    for page in range(1, 10):
        (pages_dir / f"page-{page:04d}.md").write_text(
            f"Running title\n\nBody for page {page}.\n",
            encoding="utf-8",
        )
    hq_path = result_dir / "book-hq.md"
    hq_path.write_text("unused\n", encoding="utf-8")
    windows: dict[int, list[int]] = {}

    def fake_repair(_settings: RepairSettings, payload: dict[str, Any]) -> dict[str, Any]:
        windows[payload["pageNumber"]] = [
            page["pageNumber"] for page in payload["contextPages"]
        ]
        return {
            "markdown": payload["markdown"],
            "changed": False,
            "editCount": 0,
            "mathNodeCount": 0,
            "summary": "No changes",
            "furniture": {"headers": [], "footers": []},
            "model": "test-model",
        }

    monkeypatch.setattr(
        "pdf2markdown.markdown_repair._repair_with_retries",
        fake_repair,
    )
    repair_document_markdown(
        job={"job_id": "job", "document_id": "document", "user_id": "user"},
        document_root=document_root,
        hq_markdown_path=hq_path,
        settings=RepairSettings(
            service_url="http://repair.invalid/page",
            admin_token="test-token",
        ),
        store=RepairStore(),  # type: ignore[arg-type]
    )

    assert windows[5] == [3, 4, 5, 6, 7]
    assert windows[1] == [1, 2, 3]
    assert windows[9] == [7, 8, 9]


def test_repairs_pages_concurrently_but_assembles_in_page_order(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    document_root = tmp_path / "document"
    result_dir = document_root / "result" / "book"
    pages_dir = result_dir / "pages-hq"
    pages_dir.mkdir(parents=True)
    for page in range(1, 13):
        (pages_dir / f"page-{page:04d}.md").write_text(
            f"Body for page {page}.\n",
            encoding="utf-8",
        )
    hq_path = result_dir / "book-hq.md"
    hq_path.write_text("unused\n", encoding="utf-8")

    lock = threading.Lock()
    active = 0
    max_active = 0

    def fake_repair(_settings: RepairSettings, payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            # Deliberately vary latency so futures complete out of page order.
            time.sleep(0.004 * (4 - (payload["pageNumber"] % 4)))
            return {
                "markdown": payload["markdown"],
                "changed": False,
                "editCount": 0,
                "mathNodeCount": 0,
                "summary": "No changes",
                "furniture": {"headers": [], "footers": []},
                "model": "test-model",
            }
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "pdf2markdown.markdown_repair._repair_with_retries",
        fake_repair,
    )
    store = RepairStore()
    output = repair_document_markdown(
        job={
            "job_id": "job-concurrent",
            "document_id": "document-concurrent",
            "user_id": "user-one",
        },
        document_root=document_root,
        hq_markdown_path=hq_path,
        settings=RepairSettings(
            service_url="http://repair.invalid/page",
            admin_token="test-token",
            max_concurrency=4,
        ),
        store=store,  # type: ignore[arg-type]
    )

    assert max_active == 4
    rendered = output.read_text(encoding="utf-8")
    positions = [rendered.index(f"**Page {page}**") for page in range(1, 13)]
    assert positions == sorted(positions)
    repair_progress = [
        item["current"]
        for item in store.progress
        if item["stage"] == "repair"
    ]
    assert repair_progress == list(range(13))
