"""Persistent, multi-tenant PDF import API backed by Mistral OCR."""

from __future__ import annotations

import asyncio
import base64
import errno
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Callable
from urllib.parse import quote

import fitz
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .mistral_images import upgrade_document_images
from .mistral_ocr import DEFAULT_MODEL, process_pdf, read_api_key
from .persistent_store import (
    PersistentStore,
    QuotaExceededError,
    current_period,
)
from .service import _safe_document_stem, _save_upload, _validate_pdf


LOGGER = logging.getLogger("pdf2markdown.persistent")
VERSION = "2.2.0"
USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
KEY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
PERIOD_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
IMAGE_REFERENCE_PATTERN = re.compile(
    r"(?P<prefix>\]\(|src=[\"'])"
    r"(?P<path>assets(?:-hq)?/[A-Za-z0-9._/-]+)"
)


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


def _optional_cap(name: str) -> int | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < 0:
        raise RuntimeError(f"{name} cannot be negative")
    return value or None


def _boolean(name: str, default: bool) -> bool:
    raw = os.getenv(name, "true" if default else "false").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


def _load_single_api_key() -> str | None:
    direct = os.getenv("MISTRAL_API_KEY", "").strip()
    if direct:
        return direct
    path = os.getenv("MISTRAL_API_KEY_FILE", "").strip()
    return read_api_key(Path(path)) if path else None


@dataclass(frozen=True)
class MistralKey:
    key_id: str
    label: str
    secret: str = field(repr=False)
    fingerprint: str


def _make_key(key_id: str, label: str, secret: str) -> MistralKey:
    if not KEY_ID_PATTERN.fullmatch(key_id):
        raise RuntimeError(f"Invalid Mistral key ID: {key_id!r}")
    if not secret.strip():
        raise RuntimeError(f"Mistral key {key_id!r} is empty")
    return MistralKey(
        key_id=key_id,
        label=label,
        secret=secret.strip(),
        fingerprint=hashlib.sha256(secret.strip().encode("utf-8")).hexdigest()[:16],
    )


def load_mistral_keys() -> dict[str, MistralKey]:
    """Load one embedded key and/or a JSON mapping of named keys."""
    keys: dict[str, MistralKey] = {}
    direct = _load_single_api_key()
    if direct:
        key_id = os.getenv("MISTRAL_API_KEY_ID", "embedded").strip() or "embedded"
        keys[key_id] = _make_key(key_id, "Embedded Mistral key", direct)

    configured = os.getenv("MISTRAL_API_KEYS_JSON", "").strip()
    if configured:
        try:
            values = json.loads(configured)
        except json.JSONDecodeError as exc:
            raise RuntimeError("MISTRAL_API_KEYS_JSON must be valid JSON") from exc
        if not isinstance(values, dict):
            raise RuntimeError("MISTRAL_API_KEYS_JSON must be an object of key_id: key")
        for key_id, secret in values.items():
            if not isinstance(key_id, str) or not isinstance(secret, str):
                raise RuntimeError("MISTRAL_API_KEYS_JSON values must be strings")
            keys[key_id] = _make_key(key_id, f"Mistral key {key_id}", secret)
    return keys


@dataclass(frozen=True)
class PersistentSettings:
    data_root: Path = Path("/data/pdf2markdown")
    work_root: Path = Path("/tmp/pdf2markdown")
    database_path: Path = Path("/data/pdf2markdown/service.db")
    api_token: str | None = field(default=None, repr=False)
    admin_token: str | None = field(default=None, repr=False)
    signing_secret: str | None = field(default=None, repr=False)
    require_auth: bool = True
    model: str = DEFAULT_MODEL
    timeout_seconds: int = 600
    max_upload_bytes: int = 100 * 1024 * 1024
    max_pages: int = 1000
    max_concurrent_jobs: int = 4
    max_queued_jobs: int = 100
    staged_upload_ttl_hours: int = 24
    signed_url_ttl_seconds: int = 3600
    default_user_monthly_page_cap: int | None = None
    default_key_monthly_page_cap: int | None = None
    dpi: int = 360
    padding_points: float = 6.0
    scan_padding_points: float = 0.0
    # Locus renders Markdown without raw HTML for XSS safety, so preserve
    # standard Markdown image syntax instead of emitting <p><img> wrappers.
    center_images: bool = False

    @classmethod
    def from_environment(cls) -> "PersistentSettings":
        data_root = Path(
            os.getenv("PDF2MARKDOWN_DATA_ROOT", "/data/pdf2markdown")
        ).resolve()
        return cls(
            data_root=data_root,
            work_root=Path(
                os.getenv("PDF2MARKDOWN_WORK_ROOT", "/tmp/pdf2markdown")
            ).resolve(),
            database_path=Path(
                os.getenv(
                    "PDF2MARKDOWN_DATABASE_PATH",
                    str(data_root / "service.db"),
                )
            ).resolve(),
            api_token=os.getenv("PDF2MARKDOWN_API_TOKEN", "").strip() or None,
            admin_token=os.getenv("PDF2MARKDOWN_ADMIN_TOKEN", "").strip() or None,
            signing_secret=(
                os.getenv("PDF2MARKDOWN_SIGNING_SECRET", "").strip() or None
            ),
            require_auth=_boolean("PDF2MARKDOWN_REQUIRE_AUTH", True),
            model=os.getenv("MISTRAL_OCR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            timeout_seconds=_positive_int("MISTRAL_TIMEOUT_SECONDS", 600),
            max_upload_bytes=_positive_int("PDF2MARKDOWN_MAX_UPLOAD_MB", 100)
            * 1024
            * 1024,
            max_pages=_positive_int("PDF2MARKDOWN_MAX_PAGES", 1000),
            max_concurrent_jobs=_positive_int(
                "PDF2MARKDOWN_MAX_CONCURRENT_JOBS",
                4,
            ),
            max_queued_jobs=_positive_int("PDF2MARKDOWN_MAX_QUEUED_JOBS", 100),
            staged_upload_ttl_hours=_positive_int(
                "PDF2MARKDOWN_STAGED_UPLOAD_TTL_HOURS",
                24,
            ),
            signed_url_ttl_seconds=_positive_int(
                "PDF2MARKDOWN_SIGNED_URL_TTL_SECONDS",
                3600,
            ),
            default_user_monthly_page_cap=_optional_cap(
                "PDF2MARKDOWN_DEFAULT_USER_MONTHLY_PAGE_CAP"
            ),
            default_key_monthly_page_cap=_optional_cap(
                "PDF2MARKDOWN_DEFAULT_KEY_MONTHLY_PAGE_CAP"
            ),
        )


def _bearer_token(authorization: str | None) -> str:
    scheme, _, supplied = (authorization or "").partition(" ")
    return supplied if scheme.lower() == "bearer" else ""


def _require_matching_token(
    *,
    configured: str | None,
    supplied: str,
    missing_detail: str,
) -> None:
    if not configured:
        raise HTTPException(status_code=503, detail=missing_detail)
    if not supplied or not hmac.compare_digest(configured, supplied):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")


def _validate_user_id(user_id: str | None) -> str:
    value = (user_id or "").strip()
    if not USER_ID_PATTERN.fullmatch(value):
        raise HTTPException(
            status_code=400,
            detail="X-PDF2Markdown-User-ID is missing or invalid",
        )
    return value


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def sign_document_token(
    settings: PersistentSettings,
    *,
    user_id: str,
    document_id: str,
    scope: str,
) -> str:
    if not settings.signing_secret:
        raise RuntimeError("PDF2MARKDOWN_SIGNING_SECRET is required")
    payload = {
        "u": user_id,
        "d": document_id,
        "s": scope,
        "e": int(time.time()) + settings.signed_url_ttl_seconds,
    }
    encoded = _b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        settings.signing_secret.encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded}.{_b64encode(signature)}"


def verify_document_token(
    settings: PersistentSettings,
    token: str,
    *,
    document_id: str,
    scope: str,
) -> str:
    if not settings.signing_secret:
        raise HTTPException(status_code=503, detail="Signed URLs are not configured")
    encoded, separator, supplied_signature = token.partition(".")
    if not separator:
        raise HTTPException(status_code=401, detail="Invalid document access token")
    expected = hmac.new(
        settings.signing_secret.encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).digest()
    try:
        supplied = _b64decode(supplied_signature)
        payload = json.loads(_b64decode(encoded))
    except (ValueError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="Invalid document access token")
    if not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Invalid document access token")
    if (
        payload.get("d") != document_id
        or payload.get("s") != scope
        or int(payload.get("e", 0)) < int(time.time())
    ):
        raise HTTPException(status_code=401, detail="Expired or invalid document token")
    return _validate_user_id(payload.get("u"))


def _safe_resolve(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise HTTPException(status_code=404, detail="Document file not found")
    return candidate


def _metadata_usage(metadata_path: Path, fallback_pages: int) -> tuple[int, int | None, str | None]:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    usage = metadata.get("usage_info") or {}
    raw_pages = usage.get("pages_processed", fallback_pages)
    try:
        pages = max(0, int(raw_pages))
    except (TypeError, ValueError):
        pages = fallback_pages
    raw_size = usage.get("doc_size_bytes")
    try:
        doc_size = int(raw_size) if raw_size is not None else None
    except (TypeError, ValueError):
        doc_size = None
    model = metadata.get("response_model") or metadata.get("requested_model")
    return pages, doc_size, str(model) if model else None


def _slice_pdf_page_range(
    source_path: Path,
    output_path: Path,
    page_start: int,
    page_end: int,
) -> None:
    """Copy an inclusive, one-based page range into a standalone PDF."""
    with fitz.open(source_path) as source:
        if not (1 <= page_start <= page_end <= source.page_count):
            raise ValueError(
                f"Invalid PDF page range {page_start}-{page_end} "
                f"for a {source.page_count}-page document"
            )
        with fitz.open() as selected:
            selected.insert_pdf(
                source,
                from_page=page_start - 1,
                to_page=page_end - 1,
            )
            selected.save(output_path, garbage=4, deflate=True)


Processor = Callable[
    [dict[str, Any], MistralKey, PersistentSettings, PersistentStore],
    str,
]


def process_persistent_job(
    job: dict[str, Any],
    key: MistralKey,
    settings: PersistentSettings,
    store: PersistentStore,
) -> str:
    """Convert one durable job and return the HQ Markdown path relative to its root."""
    document_root = settings.data_root / job["storage_relpath"]
    source_path = document_root / "source.pdf"
    output_root = document_root / "result"
    page_start = int(job.get("page_start") or 1)
    page_end = int(job.get("page_end") or job["page_count"])
    page_number_offset = page_start - 1

    def convert(ocr_pdf_path: Path) -> str:
        raw_markdown = process_pdf(
            pdf_path=ocr_pdf_path,
            output_root=output_root,
            api_key=key.secret,
            model=settings.model,
            timeout=settings.timeout_seconds,
            center_images=settings.center_images,
            page_number_offset=page_number_offset,
        )
        pages, doc_size, model = _metadata_usage(
            raw_markdown.parent / "metadata.json",
            int(job["reserved_pages"]),
        )
        store.record_usage(
            job_id=job["job_id"],
            pages_processed=pages,
            doc_size_bytes=doc_size,
            model=model,
            outcome="ocr_completed",
        )
        try:
            hq_markdown = upgrade_document_images(
                pdf_path=ocr_pdf_path,
                result_dir=raw_markdown.parent,
                dpi=settings.dpi,
                padding_points=settings.padding_points,
                scan_padding_points=settings.scan_padding_points,
                center_images=settings.center_images,
                page_number_offset=page_number_offset,
            )
        except Exception:
            store.record_usage(
                job_id=job["job_id"],
                pages_processed=pages,
                doc_size_bytes=doc_size,
                model=model,
                outcome="ocr_consumed_conversion_failed",
            )
            raise
        return hq_markdown.relative_to(document_root).as_posix()

    if page_start == 1 and page_end == int(job["page_count"]):
        return convert(source_path)

    with tempfile.TemporaryDirectory(prefix="locus-pdf-range-") as temporary_dir:
        selected_path = Path(temporary_dir) / (
            f"pages-{page_start:04d}-{page_end:04d}.pdf"
        )
        _slice_pdf_page_range(source_path, selected_path, page_start, page_end)
        return convert(selected_path)


class JobRunner:
    """Bounded durable queue with exactly N concurrent conversion workers."""

    def __init__(
        self,
        *,
        settings: PersistentSettings,
        store: PersistentStore,
        keys: dict[str, MistralKey],
        processor: Processor,
    ) -> None:
        self.settings = settings
        self.store = store
        self.keys = keys
        self.processor = processor
        self.queue: asyncio.Queue[str] = asyncio.Queue(settings.max_queued_jobs)
        self.tasks: list[asyncio.Task[None]] = []
        self.executor = ThreadPoolExecutor(
            max_workers=settings.max_concurrent_jobs,
            thread_name_prefix="pdf2markdown",
        )

    async def start(self) -> None:
        self.store.mark_interrupted_jobs_failed()
        self.tasks = [
            asyncio.create_task(self._worker(index))
            for index in range(self.settings.max_concurrent_jobs)
        ]
        for job_id in self.store.queued_job_ids():
            await self.queue.put(job_id)

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.executor.shutdown(wait=False, cancel_futures=True)

    def submit(self, job_id: str) -> None:
        try:
            self.queue.put_nowait(job_id)
        except asyncio.QueueFull as exc:
            raise RuntimeError("PDF import queue is full") from exc

    async def _worker(self, worker_index: int) -> None:
        loop = asyncio.get_running_loop()
        while True:
            job_id = await self.queue.get()
            try:
                job = self.store.claim_job(job_id)
                if job is None:
                    continue
                key = self.keys.get(job["api_key_id"])
                if key is None:
                    raise RuntimeError(
                        f"Assigned Mistral key {job['api_key_id']!r} is unavailable"
                    )
                markdown_relpath = await loop.run_in_executor(
                    self.executor,
                    self.processor,
                    job,
                    key,
                    self.settings,
                    self.store,
                )
                self.store.complete_job(job_id, markdown_relpath)
                LOGGER.info("Worker %s completed import %s", worker_index, job_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOGGER.exception("Import %s failed", job_id)
                if self.store.usage_event_for_job(job_id) is None:
                    failed_job = self.store.get_job(job_id)
                    estimated_pages = (
                        int(failed_job["reserved_pages"]) if failed_job else 0
                    )
                    self.store.record_usage(
                        job_id=job_id,
                        pages_processed=0,
                        quota_pages=estimated_pages,
                        usage_estimated=True,
                        doc_size_bytes=None,
                        model=self.settings.model,
                        outcome="api_call_failed_usage_estimated",
                    )
                self.store.fail_job(job_id, str(exc))
            finally:
                self.queue.task_done()


class LimitUpdate(BaseModel):
    monthly_page_cap: int | None = Field(
        default=None,
        ge=0,
        description="Monthly OCR page cap; null or 0 means unlimited",
    )


def _effective_cap(value: int | None) -> int | None:
    return value or None


def create_app(
    *,
    settings: PersistentSettings | None = None,
    mistral_keys: dict[str, MistralKey] | None = None,
    processor: Processor = process_persistent_job,
) -> FastAPI:
    resolved_settings = settings or PersistentSettings.from_environment()
    resolved_keys = mistral_keys if mistral_keys is not None else load_mistral_keys()
    store = PersistentStore(
        resolved_settings.database_path,
        default_user_monthly_page_cap=(
            resolved_settings.default_user_monthly_page_cap
        ),
        default_key_monthly_page_cap=(
            resolved_settings.default_key_monthly_page_cap
        ),
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        resolved_settings.data_root.mkdir(parents=True, exist_ok=True)
        resolved_settings.work_root.mkdir(parents=True, exist_ok=True)
        store.initialize(
            [
                (key.key_id, key.label, key.fingerprint)
                for key in resolved_keys.values()
            ]
        )
        for storage_relpath in store.prune_expired_staged_uploads():
            shutil.rmtree(
                resolved_settings.data_root / storage_relpath,
                ignore_errors=True,
            )
        runner = JobRunner(
            settings=resolved_settings,
            store=store,
            keys=resolved_keys,
            processor=processor,
        )
        application.state.settings = resolved_settings
        application.state.store = store
        application.state.runner = runner
        application.state.mistral_keys = resolved_keys
        await runner.start()
        try:
            yield
        finally:
            await runner.stop()

    application = FastAPI(
        title="Persistent PDF Import Service",
        summary=(
            "Multi-tenant PDF-to-Markdown imports with persistent chats, "
            "parallel jobs, usage metering, and quota controls"
        ),
        version=VERSION,
        lifespan=lifespan,
    )

    def require_user(
        authorization: Annotated[str | None, Header()] = None,
        user_id: Annotated[
            str | None,
            Header(alias="X-PDF2Markdown-User-ID"),
        ] = None,
    ) -> str:
        if resolved_settings.require_auth:
            _require_matching_token(
                configured=resolved_settings.api_token,
                supplied=_bearer_token(authorization),
                missing_detail="PDF2MARKDOWN_API_TOKEN is not configured",
            )
        return _validate_user_id(user_id)

    def require_admin(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        _require_matching_token(
            configured=resolved_settings.admin_token,
            supplied=_bearer_token(authorization),
            missing_detail="PDF2MARKDOWN_ADMIN_TOKEN is not configured",
        )

    def authorize_document(
        *,
        document_id: str,
        scope: str,
        access_token: str | None,
        authorization: str | None,
        user_id: str | None,
    ) -> tuple[str, dict[str, Any]]:
        if access_token:
            resolved_user_id = verify_document_token(
                resolved_settings,
                access_token,
                document_id=document_id,
                scope=scope,
            )
        else:
            if resolved_settings.require_auth:
                _require_matching_token(
                    configured=resolved_settings.api_token,
                    supplied=_bearer_token(authorization),
                    missing_detail="PDF2MARKDOWN_API_TOKEN is not configured",
                )
            resolved_user_id = _validate_user_id(user_id)
        document = store.get_document_for_user(document_id, resolved_user_id)
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return resolved_user_id, document

    def signed_url(
        request: Request,
        *,
        user_id: str,
        document_id: str,
        scope: str,
        suffix: str,
    ) -> str:
        token = sign_document_token(
            resolved_settings,
            user_id=user_id,
            document_id=document_id,
            scope=scope,
        )
        base = str(request.base_url).rstrip("/")
        return (
            f"{base}/v1/documents/{document_id}/{suffix}"
            f"?access_token={quote(token, safe='')}"
        )

    def rendered_markdown(
        request: Request,
        *,
        user_id: str,
        document: dict[str, Any],
    ) -> str:
        markdown_relpath = document.get("markdown_relpath")
        if not markdown_relpath:
            raise HTTPException(status_code=409, detail="Document is not ready")
        document_root = resolved_settings.data_root / document["storage_relpath"]
        markdown_path = _safe_resolve(document_root, markdown_relpath)
        if not markdown_path.is_file():
            raise HTTPException(status_code=404, detail="Markdown result not found")
        asset_token = sign_document_token(
            resolved_settings,
            user_id=user_id,
            document_id=document["document_id"],
            scope="asset",
        )
        base = (
            f"{str(request.base_url).rstrip('/')}/v1/documents/"
            f"{document['document_id']}"
        )

        def replace_image(match: re.Match[str]) -> str:
            path = match.group("path")
            return (
                f"{match.group('prefix')}{base}/{path}"
                f"?access_token={quote(asset_token, safe='')}"
            )

        return IMAGE_REFERENCE_PATTERN.sub(replace_image, markdown_path.read_text("utf-8"))

    def chat_payload(
        request: Request,
        user_id: str,
        chat: dict[str, Any],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": chat["chat_id"],
            "title": chat["title"],
            "status": chat["status"],
            "document_id": chat["document_id"],
            "created_at": chat["created_at"],
            "updated_at": chat["updated_at"],
            "messages": [],
        }
        if chat["status"] == "ready" and chat["document_id"]:
            document = store.get_document_for_user(chat["document_id"], user_id)
            assert document is not None
            payload["messages"] = [
                {
                    "type": "pdf_import",
                    "role": "user",
                    "content_markdown": rendered_markdown(
                        request,
                        user_id=user_id,
                        document=document,
                    ),
                    "source": {
                        "filename": document["source_filename"],
                        "page_count": document["page_count"],
                        "page_start": document.get("page_start") or 1,
                        "page_end": (
                            document.get("page_end")
                            or document["page_count"]
                        ),
                        "url": signed_url(
                            request,
                            user_id=user_id,
                            document_id=document["document_id"],
                            scope="source",
                            suffix="source",
                        ),
                    },
                }
            ]
        return payload

    @application.get("/healthz", tags=["service"])
    def healthz() -> dict[str, str]:
        return {"status": "ok", "version": VERSION}

    @application.get("/readyz", tags=["service"])
    def readyz() -> JSONResponse:
        missing: list[str] = []
        if not resolved_keys:
            missing.append("mistral_api_key")
        if resolved_settings.require_auth and not resolved_settings.api_token:
            missing.append("api_token")
        if not resolved_settings.admin_token:
            missing.append("admin_token")
        if not resolved_settings.signing_secret:
            missing.append("signing_secret")
        return JSONResponse(
            status_code=200 if not missing else 503,
            content={
                "status": "ready" if not missing else "missing_configuration",
                "missing": missing,
                "workers": resolved_settings.max_concurrent_jobs,
            },
        )

    def commit_import(
        request: Request,
        *,
        temporary_pdf: Path,
        source_filename: str,
        title: str | None,
        user_id: str,
        page_start: int | None = None,
        page_end: int | None = None,
    ) -> JSONResponse:
        reservation = None
        scheduled = False
        try:
            try:
                page_count = _validate_pdf(
                    temporary_pdf,
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            selected_page_start = page_start or 1
            selected_page_end = page_end or page_count
            if not (
                1
                <= selected_page_start
                <= selected_page_end
                <= page_count
            ):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Page range must be between 1 and {page_count}, "
                        "with the first page no later than the last"
                    ),
                )
            selected_page_count = (
                selected_page_end - selected_page_start + 1
            )
            if selected_page_count > resolved_settings.max_pages:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Selected range has {selected_page_count} pages; "
                        f"limit is {resolved_settings.max_pages}"
                    ),
                )
            chat_title = (
                (title or "").strip()
                or _safe_document_stem(source_filename).replace("-", " ")
                or "Imported PDF"
            )
            try:
                reservation = store.create_import(
                    user_id=user_id,
                    title=chat_title,
                    source_filename=source_filename,
                    page_count=page_count,
                    page_start=selected_page_start,
                    page_end=selected_page_end,
                    candidate_key_ids=list(resolved_keys),
                )
            except QuotaExceededError as exc:
                raise HTTPException(status_code=429, detail=str(exc)) from exc

            document_root = resolved_settings.data_root / reservation.storage_relpath
            document_root.mkdir(parents=True, exist_ok=False)
            source_path = document_root / "source.pdf"
            try:
                os.replace(temporary_pdf, source_path)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                # /tmp is intentionally a tmpfs in production while durable
                # documents live on a volume, so an atomic rename can cross
                # filesystems. Copy fully before removing the temporary file.
                shutil.copyfile(temporary_pdf, source_path)
                temporary_pdf.unlink()
            try:
                request.app.state.runner.submit(reservation.job_id)
                scheduled = True
            except RuntimeError as exc:
                store.fail_job(reservation.job_id, str(exc))
                raise HTTPException(status_code=503, detail=str(exc)) from exc

            body = {
                "job_id": reservation.job_id,
                "chat_id": reservation.chat_id,
                "document_id": reservation.document_id,
                "status": "queued",
                "page_count": page_count,
                "page_start": selected_page_start,
                "page_end": selected_page_end,
                "processed_page_count": selected_page_count,
                "poll_url": (
                    f"{str(request.base_url).rstrip('/')}/v1/imports/"
                    f"{reservation.job_id}"
                ),
            }
            return JSONResponse(
                status_code=202,
                content=body,
                headers={"Location": body["poll_url"]},
            )
        except Exception:
            if reservation is not None and not scheduled:
                store.fail_job(
                    reservation.job_id,
                    "Upload could not be committed to persistent storage",
                )
            raise

    def remove_expired_staged_uploads() -> None:
        for storage_relpath in store.prune_expired_staged_uploads():
            shutil.rmtree(
                resolved_settings.data_root / storage_relpath,
                ignore_errors=True,
            )

    def stage_import(
        *,
        temporary_pdf: Path,
        source_filename: str,
        user_id: str,
    ) -> dict[str, Any]:
        try:
            page_count = _validate_pdf(temporary_pdf)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        remove_expired_staged_uploads()
        staged = store.create_staged_upload(
            user_id=user_id,
            source_filename=source_filename,
            byte_size=temporary_pdf.stat().st_size,
            page_count=page_count,
            ttl_hours=resolved_settings.staged_upload_ttl_hours,
        )
        staged_root = resolved_settings.data_root / staged["storage_relpath"]
        staged_source = staged_root / "source.pdf"
        try:
            staged_root.mkdir(parents=True, exist_ok=False)
            try:
                os.replace(temporary_pdf, staged_source)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                shutil.copyfile(temporary_pdf, staged_source)
                temporary_pdf.unlink()
        except Exception:
            store.delete_staged_upload(
                staged["upload_id"],
                user_id,
            )
            shutil.rmtree(staged_root, ignore_errors=True)
            raise
        return {
            "upload_id": staged["upload_id"],
            "filename": source_filename,
            "byte_size": staged["byte_size"],
            "page_count": staged["page_count"],
            "expires_at": staged["expires_at"],
        }

    @application.post(
        "/v1/imports/pdf/raw/inspect",
        status_code=201,
        tags=["imports"],
    )
    async def inspect_raw_pdf(
        request: Request,
        user_id: str = Depends(require_user),
        filename: Annotated[
            str,
            Query(min_length=1, max_length=255),
        ] = "document.pdf",
    ) -> dict[str, Any]:
        """Stage one streamed PDF and return metadata without starting OCR."""
        if not resolved_keys:
            raise HTTPException(
                status_code=503,
                detail="No Mistral API key is configured",
            )
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > resolved_settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "PDF exceeds the "
                            f"{resolved_settings.max_upload_bytes // (1024 * 1024)} MB upload limit"
                        ),
                    )
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid Content-Length",
                ) from exc
        if (
            request.headers.get("content-type", "")
            .split(";", 1)[0]
            .strip()
            .lower()
            != "application/pdf"
        ):
            raise HTTPException(
                status_code=415,
                detail="Content-Type must be application/pdf",
            )

        resolved_settings.work_root.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(
            tempfile.mkdtemp(
                prefix="inspect-",
                dir=resolved_settings.work_root,
            )
        )
        temporary_pdf = temp_dir / "source.pdf"
        total = 0
        try:
            with temporary_pdf.open("wb") as stream:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > resolved_settings.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                "PDF exceeds the "
                                f"{resolved_settings.max_upload_bytes // (1024 * 1024)} MB upload limit"
                            ),
                        )
                    stream.write(chunk)
            if total == 0:
                raise HTTPException(
                    status_code=422,
                    detail="Uploaded PDF is empty",
                )
            return stage_import(
                temporary_pdf=temporary_pdf,
                source_filename=Path(filename).name or "document.pdf",
                user_id=user_id,
            )
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @application.post(
        "/v1/imports/pdf/staged/{upload_id}",
        status_code=202,
        tags=["imports"],
    )
    def commit_staged_pdf(
        request: Request,
        upload_id: str,
        user_id: str = Depends(require_user),
        title: Annotated[str | None, Query(max_length=200)] = None,
        page_start: Annotated[int | None, Query(ge=1)] = None,
        page_end: Annotated[int | None, Query(ge=1)] = None,
    ) -> JSONResponse:
        staged = store.claim_staged_upload(upload_id, user_id)
        if staged is None:
            raise HTTPException(
                status_code=404,
                detail="Staged PDF was not found or has expired",
            )
        staged_root = resolved_settings.data_root / staged["storage_relpath"]
        staged_source = staged_root / "source.pdf"
        try:
            response = commit_import(
                request,
                temporary_pdf=staged_source,
                source_filename=staged["source_filename"],
                title=title,
                user_id=user_id,
                page_start=page_start,
                page_end=page_end,
            )
        except Exception:
            if staged_source.is_file():
                store.release_staged_upload(upload_id, user_id)
            else:
                store.delete_staged_upload(
                    upload_id,
                    user_id,
                    status="committing",
                )
                shutil.rmtree(staged_root, ignore_errors=True)
            raise
        store.delete_staged_upload(
            upload_id,
            user_id,
            status="committing",
        )
        shutil.rmtree(staged_root, ignore_errors=True)
        return response

    @application.delete(
        "/v1/imports/pdf/staged/{upload_id}",
        status_code=204,
        tags=["imports"],
    )
    def delete_staged_pdf(
        upload_id: str,
        user_id: str = Depends(require_user),
    ) -> None:
        storage_relpath = store.delete_staged_upload(upload_id, user_id)
        if storage_relpath is None:
            raise HTTPException(
                status_code=404,
                detail="Staged PDF was not found",
            )
        shutil.rmtree(
            resolved_settings.data_root / storage_relpath,
            ignore_errors=True,
        )

    @application.post("/v1/imports/pdf", status_code=202, tags=["imports"])
    async def import_pdf(
        request: Request,
        file: Annotated[UploadFile, File(description="PDF document to import")],
        user_id: str = Depends(require_user),
        title: Annotated[str | None, Form(max_length=200)] = None,
        page_start: Annotated[int | None, Form(ge=1)] = None,
        page_end: Annotated[int | None, Form(ge=1)] = None,
    ) -> JSONResponse:
        if not resolved_keys:
            raise HTTPException(status_code=503, detail="No Mistral API key is configured")
        resolved_settings.work_root.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(
            tempfile.mkdtemp(prefix="upload-", dir=resolved_settings.work_root)
        )
        source_filename = Path(file.filename or "document.pdf").name
        temporary_pdf = temp_dir / "source.pdf"
        try:
            await _save_upload(
                file,
                temporary_pdf,
                resolved_settings.max_upload_bytes,
            )
            return commit_import(
                request,
                temporary_pdf=temporary_pdf,
                source_filename=source_filename,
                title=title,
                user_id=user_id,
                page_start=page_start,
                page_end=page_end,
            )
        finally:
            await file.close()
            shutil.rmtree(temp_dir, ignore_errors=True)

    @application.post("/v1/imports/pdf/raw", status_code=202, tags=["imports"])
    async def import_raw_pdf(
        request: Request,
        user_id: str = Depends(require_user),
        filename: Annotated[str, Query(min_length=1, max_length=255)] = "document.pdf",
        title: Annotated[str | None, Query(max_length=200)] = None,
        page_start: Annotated[int | None, Query(ge=1)] = None,
        page_end: Annotated[int | None, Query(ge=1)] = None,
    ) -> JSONResponse:
        """Accept a streaming PDF body from the trusted Locus application."""
        if not resolved_keys:
            raise HTTPException(status_code=503, detail="No Mistral API key is configured")
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > resolved_settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "PDF exceeds the "
                            f"{resolved_settings.max_upload_bytes // (1024 * 1024)} MB upload limit"
                        ),
                    )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid Content-Length") from exc
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/pdf":
            raise HTTPException(status_code=415, detail="Content-Type must be application/pdf")

        resolved_settings.work_root.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(
            tempfile.mkdtemp(prefix="upload-", dir=resolved_settings.work_root)
        )
        temporary_pdf = temp_dir / "source.pdf"
        total = 0
        try:
            with temporary_pdf.open("wb") as stream:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > resolved_settings.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                "PDF exceeds the "
                                f"{resolved_settings.max_upload_bytes // (1024 * 1024)} MB upload limit"
                            ),
                        )
                    stream.write(chunk)
            if total == 0:
                raise HTTPException(status_code=422, detail="Uploaded PDF is empty")
            return commit_import(
                request,
                temporary_pdf=temporary_pdf,
                source_filename=Path(filename).name or "document.pdf",
                title=title,
                user_id=user_id,
                page_start=page_start,
                page_end=page_end,
            )
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @application.get("/v1/imports/{job_id}", tags=["imports"])
    def get_import(
        job_id: str,
        user_id: str = Depends(require_user),
    ) -> dict[str, Any]:
        job = store.get_job_for_user(job_id, user_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Import job not found")
        return job

    @application.get("/v1/chats/{chat_id}", tags=["chats"])
    def get_chat(
        request: Request,
        chat_id: str,
        user_id: str = Depends(require_user),
    ) -> dict[str, Any]:
        chat = store.get_chat_for_user(chat_id, user_id)
        if chat is None:
            raise HTTPException(status_code=404, detail="Chat not found")
        return chat_payload(request, user_id, chat)

    @application.get(
        "/v1/documents/{document_id}/markdown",
        response_class=PlainTextResponse,
        tags=["documents"],
    )
    def get_markdown(
        request: Request,
        document_id: str,
        raw: Annotated[bool, Query()] = False,
        access_token: Annotated[str | None, Query()] = None,
        authorization: Annotated[str | None, Header()] = None,
        user_id: Annotated[
            str | None,
            Header(alias="X-PDF2Markdown-User-ID"),
        ] = None,
    ) -> PlainTextResponse:
        resolved_user_id, document = authorize_document(
            document_id=document_id,
            scope="markdown",
            access_token=access_token,
            authorization=authorization,
            user_id=user_id,
        )
        if raw:
            markdown_relpath = document.get("markdown_relpath")
            if not markdown_relpath:
                raise HTTPException(status_code=409, detail="Document is not ready")
            document_root = resolved_settings.data_root / document["storage_relpath"]
            markdown_path = _safe_resolve(document_root, markdown_relpath)
            if not markdown_path.is_file():
                raise HTTPException(status_code=404, detail="Markdown result not found")
            return PlainTextResponse(
                markdown_path.read_text("utf-8"),
                media_type="text/markdown; charset=utf-8",
            )
        return PlainTextResponse(
            rendered_markdown(
                request,
                user_id=resolved_user_id,
                document=document,
            ),
            media_type="text/markdown; charset=utf-8",
        )

    @application.get("/v1/documents/{document_id}/source", tags=["documents"])
    def get_source_pdf(
        document_id: str,
        access_token: Annotated[str | None, Query()] = None,
        authorization: Annotated[str | None, Header()] = None,
        user_id: Annotated[
            str | None,
            Header(alias="X-PDF2Markdown-User-ID"),
        ] = None,
    ) -> FileResponse:
        _, document = authorize_document(
            document_id=document_id,
            scope="source",
            access_token=access_token,
            authorization=authorization,
            user_id=user_id,
        )
        source_path = (
            resolved_settings.data_root / document["storage_relpath"] / "source.pdf"
        )
        if not source_path.is_file():
            raise HTTPException(status_code=404, detail="Source PDF not found")
        return FileResponse(
            source_path,
            media_type="application/pdf",
            filename=document["source_filename"],
            content_disposition_type="inline",
        )

    @application.get(
        "/v1/documents/{document_id}/{asset_collection}/{asset_path:path}",
        tags=["documents"],
    )
    def get_document_asset(
        document_id: str,
        asset_collection: str,
        asset_path: str,
        access_token: Annotated[str | None, Query()] = None,
        authorization: Annotated[str | None, Header()] = None,
        user_id: Annotated[
            str | None,
            Header(alias="X-PDF2Markdown-User-ID"),
        ] = None,
    ) -> FileResponse:
        if asset_collection not in {"assets", "assets-hq"}:
            raise HTTPException(status_code=404, detail="Asset not found")
        _, document = authorize_document(
            document_id=document_id,
            scope="asset",
            access_token=access_token,
            authorization=authorization,
            user_id=user_id,
        )
        markdown_relpath = document.get("markdown_relpath")
        if not markdown_relpath:
            raise HTTPException(status_code=409, detail="Document is not ready")
        document_root = resolved_settings.data_root / document["storage_relpath"]
        result_root = _safe_resolve(document_root, markdown_relpath).parent
        asset = _safe_resolve(result_root, f"{asset_collection}/{asset_path}")
        if not asset.is_file():
            raise HTTPException(status_code=404, detail="Asset not found")
        return FileResponse(asset)

    @application.get("/v1/admin/usage", tags=["admin"])
    def admin_usage(
        _: None = Depends(require_admin),
        period: str = Query(default_factory=current_period),
    ) -> dict[str, Any]:
        if not PERIOD_PATTERN.fullmatch(period):
            raise HTTPException(status_code=422, detail="period must be YYYY-MM")
        return store.usage_summary(period)

    @application.get("/v1/admin/users", tags=["admin"])
    def admin_users(
        _: None = Depends(require_admin),
        period: str = Query(default_factory=current_period),
    ) -> list[dict[str, Any]]:
        if not PERIOD_PATTERN.fullmatch(period):
            raise HTTPException(status_code=422, detail="period must be YYYY-MM")
        return store.list_users(period)

    @application.patch("/v1/admin/users/{user_id}/limits", tags=["admin"])
    def update_user_limits(
        user_id: str,
        limits: LimitUpdate,
        _: None = Depends(require_admin),
    ) -> dict[str, Any]:
        validated = _validate_user_id(user_id)
        cap = _effective_cap(limits.monthly_page_cap)
        store.set_user_cap(validated, cap)
        return {"user_id": validated, "monthly_page_cap": cap}

    @application.get("/v1/admin/api-keys", tags=["admin"])
    def admin_api_keys(
        _: None = Depends(require_admin),
        period: str = Query(default_factory=current_period),
    ) -> list[dict[str, Any]]:
        if not PERIOD_PATTERN.fullmatch(period):
            raise HTTPException(status_code=422, detail="period must be YYYY-MM")
        return store.list_api_keys(period)

    @application.patch("/v1/admin/api-keys/{key_id}/limits", tags=["admin"])
    def update_key_limits(
        key_id: str,
        limits: LimitUpdate,
        _: None = Depends(require_admin),
    ) -> dict[str, Any]:
        if not KEY_ID_PATTERN.fullmatch(key_id):
            raise HTTPException(status_code=422, detail="Invalid API key ID")
        cap = _effective_cap(limits.monthly_page_cap)
        if not store.set_key_cap(key_id, cap):
            raise HTTPException(status_code=404, detail="API key not found")
        return {"key_id": key_id, "monthly_page_cap": cap}

    return application


app = create_app()
