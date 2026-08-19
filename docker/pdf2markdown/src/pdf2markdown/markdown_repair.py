"""Persistent, page-scoped LLM repair for OCR Markdown."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .markdown_pages import format_markdown_page
from .persistent_store import PersistentStore


PROMPT_VERSION = "pdf-markdown-repair-v1"
PAGE_FILE_PATTERN = re.compile(r"^page-(\d+)\.md$")


class RepairServiceError(RuntimeError):
    """An HTTP or contract failure from the private repair service."""

    def __init__(self, message: str, *, status: int = 500, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def fatal(self) -> bool:
        return self.status in {401, 402, 403, 404}


@dataclass(frozen=True)
class RepairSettings:
    service_url: str
    admin_token: str
    timeout_seconds: int = 300
    neighbour_characters: int = 8000


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _post_page(
    settings: RepairSettings,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        settings.service_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {settings.admin_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "locus-pdf-markdown-repair/1.0",
        },
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=settings.timeout_seconds,
        ) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(
                exc.read().decode("utf-8", errors="replace")[:8000]
            )
        except json.JSONDecodeError:
            detail = {}
        raise RepairServiceError(
            str(detail.get("error") or f"Repair service returned HTTP {exc.code}"),
            status=exc.code,
            code=str(detail.get("code") or ""),
        ) from exc
    except urllib.error.URLError as exc:
        raise RepairServiceError(
            f"Could not reach the PDF repair service: {exc.reason}",
            status=503,
        ) from exc
    if not isinstance(result, dict) or not isinstance(result.get("markdown"), str):
        raise RepairServiceError("Repair service returned an invalid response")
    return result


def _repair_with_retries(
    settings: RepairSettings,
    payload: dict[str, Any],
) -> dict[str, Any]:
    delays = (0, 3)
    last_error: RepairServiceError | None = None
    for delay in delays:
        if delay:
            time.sleep(delay)
        try:
            return _post_page(settings, payload)
        except RepairServiceError as exc:
            last_error = exc
            if exc.fatal:
                raise
            if exc.status not in {409, 429, 500, 502, 503, 504}:
                raise
    assert last_error is not None
    raise last_error


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temporary.write_text(content.rstrip() + "\n", encoding="utf-8")
    os.replace(temporary, path)


def repair_document_markdown(
    *,
    job: dict[str, Any],
    document_root: Path,
    hq_markdown_path: Path,
    settings: RepairSettings,
    store: PersistentStore,
) -> Path:
    """Repair every HQ page, resuming safely from the per-page ledger."""
    if not settings.service_url or not settings.admin_token:
        raise RuntimeError("PDF Markdown repair service is not configured")
    source_pages_dir = hq_markdown_path.parent / "pages-hq"
    if not source_pages_dir.is_dir():
        raise FileNotFoundError(f"HQ page Markdown not found: {source_pages_dir}")
    pages: list[tuple[int, Path]] = []
    for path in source_pages_dir.iterdir():
        match = PAGE_FILE_PATTERN.fullmatch(path.name)
        if match and path.is_file():
            pages.append((int(match.group(1)), path))
    pages.sort()
    if not pages:
        raise RuntimeError("OCR produced no Markdown pages")

    repaired_pages_dir = hq_markdown_path.parent / f"pages-repaired-{PROMPT_VERSION}"
    repaired_pages_dir.mkdir(parents=True, exist_ok=True)
    report_pages: list[dict[str, Any]] = []
    combined: list[str] = []
    changed_pages = 0
    failed_pages = 0
    total = len(pages)
    store.set_job_progress(
        job["job_id"],
        stage="repair",
        current=0,
        total=total,
        message=f"Formatting page 1 of {total}",
    )

    source_markdown = [path.read_text(encoding="utf-8") for _, path in pages]
    for position, ((page_number, source_path), markdown) in enumerate(
        zip(pages, source_markdown, strict=True)
    ):
        source_sha256 = _sha256_text(markdown)
        output_path = repaired_pages_dir / source_path.name
        result_relpath = output_path.relative_to(document_root).as_posix()
        cached = store.get_repair_page(
            document_id=job["document_id"],
            page_number=page_number,
            source_sha256=source_sha256,
            prompt_version=PROMPT_VERSION,
        )
        if (
            cached is not None
            and cached.get("status") == "completed"
            and output_path.is_file()
        ):
            repaired = output_path.read_text(encoding="utf-8")
            changed = bool(cached.get("changed"))
            report_pages.append(
                {
                    "page": page_number,
                    "status": "cached",
                    "changed": changed,
                    "edit_count": int(cached.get("edit_count") or 0),
                    "math_node_count": int(cached.get("math_node_count") or 0),
                    "summary": cached.get("summary") or "",
                }
            )
        else:
            store.start_repair_page(
                job_id=job["job_id"],
                document_id=job["document_id"],
                page_number=page_number,
                source_sha256=source_sha256,
                prompt_version=PROMPT_VERSION,
            )
            try:
                result = _repair_with_retries(
                    settings,
                    {
                        "ownerUserId": job["user_id"],
                        "jobId": job["job_id"],
                        "documentId": job["document_id"],
                        "pageNumber": page_number,
                        "sourceSha256": source_sha256,
                        "markdown": markdown,
                        "previousMarkdown": (
                            source_markdown[position - 1][
                                -settings.neighbour_characters :
                            ]
                            if position > 0
                            else ""
                        ),
                        "nextMarkdown": (
                            source_markdown[position + 1][
                                : settings.neighbour_characters
                            ]
                            if position + 1 < total
                            else ""
                        ),
                    },
                )
                repaired = str(result["markdown"])
                changed = bool(result.get("changed"))
                _atomic_write(output_path, repaired)
                store.finish_repair_page(
                    document_id=job["document_id"],
                    page_number=page_number,
                    source_sha256=source_sha256,
                    prompt_version=PROMPT_VERSION,
                    model=str(result.get("model") or "unknown"),
                    changed=changed,
                    edit_count=int(result.get("editCount") or 0),
                    math_node_count=int(result.get("mathNodeCount") or 0),
                    result_relpath=result_relpath,
                    summary=str(result.get("summary") or ""),
                )
                report_pages.append(
                    {
                        "page": page_number,
                        "status": "completed",
                        "changed": changed,
                        "edit_count": int(result.get("editCount") or 0),
                        "math_node_count": int(result.get("mathNodeCount") or 0),
                        "summary": str(result.get("summary") or ""),
                    }
                )
            except RepairServiceError as exc:
                store.fail_repair_page(
                    document_id=job["document_id"],
                    page_number=page_number,
                    source_sha256=source_sha256,
                    prompt_version=PROMPT_VERSION,
                    error=str(exc),
                )
                if exc.fatal:
                    raise
                # A model/validation miss must not discard otherwise usable OCR.
                # Publish the immutable HQ page and record it for review.
                repaired = markdown
                changed = False
                _atomic_write(output_path, repaired)
                failed_pages += 1
                report_pages.append(
                    {
                        "page": page_number,
                        "status": "review_required",
                        "changed": False,
                        "error": str(exc),
                    }
                )

        if changed:
            changed_pages += 1
        combined.append(format_markdown_page(page_number, repaired))
        store.set_job_progress(
            job["job_id"],
            stage="repair",
            current=position + 1,
            total=total,
            message=(
                f"Formatting page {position + 2} of {total}"
                if position + 1 < total
                else "Assembling repaired Markdown"
            ),
        )

    store.set_job_progress(
        job["job_id"],
        stage="assembling",
        current=total,
        total=total,
        message="Assembling repaired Markdown",
    )
    output_path = hq_markdown_path.parent / f"source-{PROMPT_VERSION}.md"
    _atomic_write(output_path, "\n\n".join(combined))
    report = {
        "prompt_version": PROMPT_VERSION,
        "source_markdown": hq_markdown_path.name,
        "page_count": total,
        "changed_page_count": changed_pages,
        "review_required_page_count": failed_pages,
        "pages": report_pages,
    }
    _atomic_write(
        hq_markdown_path.parent / f"repair-report-{PROMPT_VERSION}.json",
        json.dumps(report, ensure_ascii=False, indent=2),
    )
    return output_path
