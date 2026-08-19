"""Persistent, page-scoped LLM repair for OCR Markdown."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .markdown_pages import format_markdown_page
from .page_furniture import boundary_layout_candidates
from .persistent_store import PersistentStore


PROMPT_VERSION = "pdf-markdown-repair-v4"
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
    context_page_radius: int = 2
    max_concurrency: int = 4


@dataclass(frozen=True)
class PageRepairResult:
    position: int
    page_number: int
    repaired: str
    changed: bool
    furniture: dict[str, Any]
    report: dict[str, Any]
    review_required: bool = False


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


def _context_excerpt(markdown: str, limit: int) -> str:
    """Keep both page edges; running furniture lives at either boundary."""

    if len(markdown) <= limit:
        return markdown
    edge = max(1, limit // 2)
    return (
        markdown[:edge].rstrip()
        + "\n\n[... middle of page omitted ...]\n\n"
        + markdown[-edge:].lstrip()
    )


def _load_ocr_pages(result_root: Path) -> list[dict[str, Any]]:
    response_path = result_root / "response.json"
    if not response_path.is_file():
        return []
    try:
        response = json.loads(response_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    pages = response.get("pages") if isinstance(response, dict) else None
    return pages if isinstance(pages, list) else []


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
    total = len(pages)
    concurrency = max(1, min(settings.max_concurrency, total))
    store.set_job_progress(
        job["job_id"],
        stage="repair",
        current=0,
        total=total,
        message=f"Formatting 0 of {total} pages ({concurrency} at a time)",
    )

    source_markdown = [path.read_text(encoding="utf-8") for _, path in pages]
    ocr_pages = _load_ocr_pages(hq_markdown_path.parent)
    layout_by_position = [
        boundary_layout_candidates(page) if isinstance(page, dict) else []
        for page in ocr_pages
    ]
    def repair_page(position: int) -> PageRepairResult:
        page_number, source_path = pages[position]
        markdown = source_markdown[position]
        source_sha256 = _sha256_text(markdown)
        output_path = repaired_pages_dir / source_path.name
        layout_path = repaired_pages_dir / f"{source_path.stem}.layout.json"
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
            try:
                furniture = json.loads(layout_path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                furniture = {"headers": [], "footers": []}
            if not isinstance(furniture, dict):
                furniture = {"headers": [], "footers": []}
            report = {
                "page": page_number,
                "status": "cached",
                "changed": changed,
                "edit_count": int(cached.get("edit_count") or 0),
                "math_node_count": int(cached.get("math_node_count") or 0),
                "summary": cached.get("summary") or "",
            }
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
                        "contextPages": [
                            {
                                "pageNumber": pages[context_position][0],
                                "markdown": _context_excerpt(
                                    source_markdown[context_position],
                                    settings.neighbour_characters,
                                ),
                                "layoutCandidates": (
                                    layout_by_position[context_position]
                                    if context_position < len(layout_by_position)
                                    else []
                                ),
                            }
                            for context_position in range(
                                max(0, position - settings.context_page_radius),
                                min(total, position + settings.context_page_radius + 1),
                            )
                        ],
                        "layoutCandidates": (
                            layout_by_position[position]
                            if position < len(layout_by_position)
                            else []
                        ),
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
                raw_furniture = result.get("furniture")
                furniture = (
                    raw_furniture
                    if isinstance(raw_furniture, dict)
                    else {"headers": [], "footers": []}
                )
                _atomic_write(output_path, repaired)
                _atomic_write(
                    layout_path,
                    json.dumps(furniture, ensure_ascii=False, indent=2),
                )
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
                report = {
                    "page": page_number,
                    "status": "completed",
                    "changed": changed,
                    "edit_count": int(result.get("editCount") or 0),
                    "math_node_count": int(result.get("mathNodeCount") or 0),
                    "summary": str(result.get("summary") or ""),
                }
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
                furniture = {"headers": [], "footers": []}
                _atomic_write(output_path, repaired)
                _atomic_write(
                    layout_path,
                    json.dumps(furniture, ensure_ascii=False, indent=2),
                )
                report = {
                    "page": page_number,
                    "status": "review_required",
                    "changed": False,
                    "error": str(exc),
                }
                return PageRepairResult(
                    position=position,
                    page_number=page_number,
                    repaired=repaired,
                    changed=False,
                    furniture=furniture,
                    report=report,
                    review_required=True,
                )

        return PageRepairResult(
            position=position,
            page_number=page_number,
            repaired=repaired,
            changed=changed,
            furniture=furniture,
            report=report,
        )

    ordered_results: list[PageRepairResult | None] = [None] * total
    completed = 0
    with ThreadPoolExecutor(
        max_workers=concurrency,
        thread_name_prefix=f"pdf-repair-{str(job['job_id'])[:8]}",
    ) as executor:
        futures = {
            executor.submit(repair_page, position): position
            for position in range(total)
        }
        try:
            for future in as_completed(futures):
                result = future.result()
                ordered_results[result.position] = result
                completed += 1
                store.set_job_progress(
                    job["job_id"],
                    stage="repair",
                    current=completed,
                    total=total,
                    message=(
                        f"Formatting {completed} of {total} pages "
                        f"({concurrency} at a time)"
                        if completed < total
                        else "Assembling repaired Markdown"
                    ),
                )
        except Exception:
            for future in futures:
                future.cancel()
            raise

    results = [result for result in ordered_results if result is not None]
    if len(results) != total:
        raise RuntimeError("PDF formatter did not produce every page")

    report_pages = [result.report for result in results]
    changed_pages = sum(result.changed for result in results)
    failed_pages = sum(result.review_required for result in results)
    model_layout_pages = [
        {
            "page": result.page_number,
            "headers": list(result.furniture.get("headers") or []),
            "footers": list(result.furniture.get("footers") or []),
        }
        for result in results
        if result.furniture.get("headers") or result.furniture.get("footers")
    ]
    combined = [
        format_markdown_page(result.page_number, result.repaired)
        for result in results
    ]

    store.set_job_progress(
        job["job_id"],
        stage="assembling",
        current=total,
        total=total,
        message="Assembling repaired Markdown",
    )
    output_path = hq_markdown_path.parent / f"source-{PROMPT_VERSION}.md"
    _atomic_write(output_path, "\n\n".join(combined))
    _atomic_write(
        hq_markdown_path.parent / f"repair-layout-{PROMPT_VERSION}.json",
        json.dumps(
            {"page_count": total, "pages": model_layout_pages},
            ensure_ascii=False,
            indent=2,
        ),
    )
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
