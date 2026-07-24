"""HTTP service for Mistral OCR PDF-to-Markdown conversion."""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import fitz
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from .mistral_images import upgrade_document_images
from .mistral_ocr import DEFAULT_MODEL, process_pdf, read_api_key


LOGGER = logging.getLogger("pdf2markdown.service")
VERSION = "1.0.0"


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


def _load_api_key() -> str | None:
    direct = os.getenv("MISTRAL_API_KEY", "").strip()
    if direct:
        return direct
    key_file = os.getenv("MISTRAL_API_KEY_FILE", "").strip()
    if key_file:
        try:
            return read_api_key(Path(key_file))
        except OSError as exc:
            raise RuntimeError(f"Could not read MISTRAL_API_KEY_FILE: {exc}") from exc
    return None


@dataclass(frozen=True)
class ServiceSettings:
    api_key: str | None = field(default=None, repr=False)
    api_token: str | None = field(default=None, repr=False)
    model: str = DEFAULT_MODEL
    timeout_seconds: int = 600
    max_upload_bytes: int = 100 * 1024 * 1024
    max_pages: int = 1000
    max_concurrent_jobs: int = 2
    work_root: Path = Path("/tmp/pdf2markdown")

    @classmethod
    def from_environment(cls) -> "ServiceSettings":
        upload_mb = _positive_int("PDF2MARKDOWN_MAX_UPLOAD_MB", 100)
        return cls(
            api_key=_load_api_key(),
            api_token=os.getenv("PDF2MARKDOWN_API_TOKEN", "").strip() or None,
            model=os.getenv("MISTRAL_OCR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            timeout_seconds=_positive_int("MISTRAL_TIMEOUT_SECONDS", 600),
            max_upload_bytes=upload_mb * 1024 * 1024,
            max_pages=_positive_int("PDF2MARKDOWN_MAX_PAGES", 1000),
            max_concurrent_jobs=_positive_int("PDF2MARKDOWN_MAX_CONCURRENT_JOBS", 2),
            work_root=Path(
                os.getenv("PDF2MARKDOWN_WORK_ROOT", "/tmp/pdf2markdown")
            ).resolve(),
        )


@lru_cache(maxsize=1)
def get_settings() -> ServiceSettings:
    return ServiceSettings.from_environment()


class JobLimiter:
    """A lazily resized process-local concurrency limit."""

    def __init__(self) -> None:
        self._limit: int | None = None
        self._semaphore: asyncio.Semaphore | None = None

    def semaphore(self, limit: int) -> asyncio.Semaphore:
        if self._semaphore is None or self._limit != limit:
            self._limit = limit
            self._semaphore = asyncio.Semaphore(limit)
        return self._semaphore


JOB_LIMITER = JobLimiter()


def _safe_document_stem(filename: str | None) -> str:
    stem = Path(filename or "document.pdf").stem
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.")
    return cleaned[:120] or "document"


async def _save_upload(upload: UploadFile, destination: Path, max_bytes: int) -> int:
    total = 0
    with destination.open("wb") as stream:
        while chunk := await upload.read(1024 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"PDF exceeds the {max_bytes // (1024 * 1024)} MB upload limit",
                )
            stream.write(chunk)
    if total == 0:
        raise HTTPException(status_code=422, detail="Uploaded PDF is empty")
    return total


def _validate_pdf(pdf_path: Path, max_pages: int | None = None) -> int:
    with pdf_path.open("rb") as stream:
        header = stream.read(1024)
    if b"%PDF-" not in header:
        raise ValueError("Uploaded file does not contain a PDF header")
    try:
        with fitz.open(pdf_path) as document:
            if document.needs_pass:
                raise ValueError("Password-protected PDFs are not supported")
            page_count = document.page_count
    except fitz.FileDataError as exc:
        raise ValueError("Uploaded file is not a valid PDF") from exc
    if page_count <= 0:
        raise ValueError("PDF has no pages")
    if max_pages is not None and page_count > max_pages:
        raise ValueError(f"PDF has {page_count} pages; limit is {max_pages}")
    return page_count


def _convert_job(
    pdf_path: Path,
    output_root: Path,
    settings: ServiceSettings,
    dpi: int,
    padding_points: float,
    scan_padding_points: float,
    center_images: bool,
) -> Path:
    if not settings.api_key:
        raise RuntimeError("MISTRAL_API_KEY or MISTRAL_API_KEY_FILE is required")
    raw_markdown = process_pdf(
        pdf_path=pdf_path,
        output_root=output_root,
        api_key=settings.api_key,
        model=settings.model,
        timeout=settings.timeout_seconds,
        center_images=center_images,
    )
    return upgrade_document_images(
        pdf_path=pdf_path,
        result_dir=raw_markdown.parent,
        dpi=dpi,
        padding_points=padding_points,
        scan_padding_points=scan_padding_points,
        center_images=center_images,
    )


def _make_archive(document_dir: Path, job_dir: Path) -> Path:
    archive_base = job_dir / f"{document_dir.name}-pdf2markdown"
    archive_path = shutil.make_archive(
        str(archive_base),
        "zip",
        root_dir=document_dir.parent,
        base_dir=document_dir.name,
    )
    return Path(archive_path)


async def require_service_token(
    settings: Annotated[ServiceSettings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if not settings.api_token:
        return
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        supplied,
        settings.api_token,
    ):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")


app = FastAPI(
    title="PDF to Markdown Service",
    summary="Mistral OCR 4 with native and scanned-image recovery",
    version=VERSION,
)


@app.get("/healthz", tags=["service"])
def healthz() -> dict[str, str]:
    return {"status": "ok", "version": VERSION}


@app.get("/readyz", tags=["service"])
def readyz(
    settings: Annotated[ServiceSettings, Depends(get_settings)],
) -> JSONResponse:
    ready = bool(settings.api_key)
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "missing_mistral_api_key"},
    )


@app.post(
    "/v1/convert",
    response_class=FileResponse,
    tags=["conversion"],
    responses={
        200: {"content": {"application/zip": {}}},
        401: {"description": "Bearer token rejected"},
        413: {"description": "Upload exceeds configured size limit"},
        422: {"description": "Invalid or unsupported PDF"},
        502: {"description": "Mistral OCR request failed"},
        503: {"description": "Service is missing its Mistral API key"},
    },
)
async def convert_pdf(
    file: Annotated[UploadFile, File(description="PDF document to convert")],
    settings: Annotated[ServiceSettings, Depends(get_settings)],
    _: Annotated[None, Depends(require_service_token)],
    dpi: Annotated[int, Form(ge=72, le=600)] = 360,
    padding_points: Annotated[float, Form(ge=0, le=72)] = 6.0,
    scan_padding_points: Annotated[float, Form(ge=0, le=72)] = 0.0,
    center_images: Annotated[bool, Form()] = True,
) -> FileResponse:
    if not settings.api_key:
        raise HTTPException(
            status_code=503,
            detail="MISTRAL_API_KEY or MISTRAL_API_KEY_FILE is required",
        )

    settings.work_root.mkdir(parents=True, exist_ok=True)
    job_dir = Path(tempfile.mkdtemp(prefix="job-", dir=settings.work_root))
    stem = _safe_document_stem(file.filename)
    pdf_path = job_dir / f"{stem}.pdf"
    output_root = job_dir / "output"
    try:
        await _save_upload(file, pdf_path, settings.max_upload_bytes)
        try:
            _validate_pdf(pdf_path, settings.max_pages)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        semaphore = JOB_LIMITER.semaphore(settings.max_concurrent_jobs)
        async with semaphore:
            try:
                hq_markdown = await run_in_threadpool(
                    _convert_job,
                    pdf_path,
                    output_root,
                    settings,
                    dpi,
                    padding_points,
                    scan_padding_points,
                    center_images,
                )
            except RuntimeError as exc:
                LOGGER.warning("Conversion failed for %s: %s", stem, exc)
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        archive_path = await run_in_threadpool(
            _make_archive,
            hq_markdown.parent,
            job_dir,
        )
        return FileResponse(
            archive_path,
            media_type="application/zip",
            filename=archive_path.name,
            background=BackgroundTask(shutil.rmtree, job_dir, ignore_errors=True),
        )
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
