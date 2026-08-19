from __future__ import annotations

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
    calls: list[int] = []

    def fake_repair(_settings: RepairSettings, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append(payload["pageNumber"])
        markdown = payload["markdown"].replace("```ruby\n", "").replace("\n```", "")
        return {
            "markdown": markdown,
            "changed": markdown != payload["markdown"],
            "editCount": int(markdown != payload["markdown"]),
            "mathNodeCount": 0,
            "summary": "Removed a false fence" if markdown != payload["markdown"] else "No changes",
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
    assert calls == [3, 4]
    assert "**Page 3**" in output.read_text(encoding="utf-8")
    assert "```ruby" not in output.read_text(encoding="utf-8")
    assert store.progress[-1]["stage"] == "assembling"

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
