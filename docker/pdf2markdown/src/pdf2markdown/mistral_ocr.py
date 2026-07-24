"""Mistral OCR API client and Markdown result exporter."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import mimetypes
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

from .markdown_images import center_markdown_images
from .markdown_pages import format_markdown_page


API_URL = "https://api.mistral.ai/v1/ocr"
DEFAULT_MODEL = "mistral-ocr-4-0"


def read_api_key(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if "=" in value and value.split("=", 1)[0].strip() == "MISTRAL_API_KEY":
        value = value.split("=", 1)[1].strip().strip("\"'")
    if not value:
        raise ValueError(f"API key file is empty: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_request(
    pdf_path: Path,
    model: str,
) -> bytes:
    encoded = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
    request: dict[str, Any] = {
        "model": model,
        "document": {
            "type": "document_url",
            "document_url": f"data:application/pdf;base64,{encoded}",
        },
        "include_image_base64": True,
        "include_blocks": True,
        "confidence_scores_granularity": "page",
    }
    return json.dumps(
        request,
        separators=(",", ":"),
    ).encode("utf-8")


def call_ocr(
    api_key: str,
    body: bytes,
    timeout: int,
) -> tuple[dict[str, Any], dict[str, str]]:
    request = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "pdf2markdown-mistral-ocr/1.0",
        },
    )
    delays = (0, 2, 5, 10)
    for attempt, delay in enumerate(delays, start=1):
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                headers = {key.lower(): value for key, value in response.headers.items()}
                return json.load(response), headers
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:2000]
            if exc.code not in {408, 429, 500, 502, 503, 504} or attempt == len(delays):
                raise RuntimeError(
                    f"Mistral OCR returned HTTP {exc.code}: {detail}"
                ) from exc
        except urllib.error.URLError as exc:
            if attempt == len(delays):
                raise RuntimeError(f"Could not reach Mistral OCR: {exc.reason}") from exc
    raise AssertionError("retry loop exhausted")


def safe_name(value: str) -> str:
    name = Path(value).name
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "image.bin"


def decode_image(data: str, image_id: str) -> tuple[bytes, str]:
    mime_type = ""
    encoded = data
    if data.startswith("data:") and ";base64," in data:
        header, encoded = data.split(",", 1)
        mime_type = header[5:].split(";", 1)[0]
    extension = mimetypes.guess_extension(mime_type) if mime_type else None
    if not extension:
        extension = Path(image_id).suffix or ".bin"
    return base64.b64decode(encoded), extension


def export_result(
    pdf_path: Path,
    output_root: Path,
    requested_model: str,
    response: dict[str, Any],
    elapsed_seconds: float,
    response_headers: dict[str, str],
    center_images: bool = True,
    page_number_offset: int = 0,
) -> Path:
    document_dir = output_root / pdf_path.stem
    pages_dir = document_dir / "pages"
    assets_dir = document_dir / "assets"
    pages_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    sanitized = copy.deepcopy(response)
    combined_pages: list[str] = []
    block_types: Counter[str] = Counter()
    page_confidences: list[float] = []
    image_count = 0

    pages = response.get("pages") or []
    sanitized_pages = sanitized.get("pages") or []
    for position, page in enumerate(pages):
        page_index = int(page.get("index", position))
        page_number = page_index + 1 + page_number_offset
        markdown = page.get("markdown") or ""
        sanitized_page = sanitized_pages[position]

        for image_position, image in enumerate(page.get("images") or []):
            image_id = str(image.get("id") or f"image-{image_position}.bin")
            image_data = image.get("image_base64")
            if not image_data:
                continue
            raw, extension = decode_image(image_data, image_id)
            base_name = safe_name(image_id)
            if not Path(base_name).suffix:
                base_name += extension
            asset_name = f"page-{page_number:04d}-{base_name}"
            asset_path = assets_dir / asset_name
            asset_path.write_bytes(raw)
            relative_asset = f"assets/{asset_name}"
            markdown = markdown.replace(f"]({image_id})", f"]({relative_asset})")
            markdown = markdown.replace(f'src="{image_id}"', f'src="{relative_asset}"')
            markdown = markdown.replace(f"src='{image_id}'", f"src='{relative_asset}'")
            sanitized_image = sanitized_page["images"][image_position]
            sanitized_image.pop("image_base64", None)
            sanitized_image["asset_path"] = relative_asset
            image_count += 1

        for block in page.get("blocks") or []:
            block_types[str(block.get("type") or "unknown")] += 1

        scores = page.get("confidence_scores") or {}
        average = scores.get("average_page_confidence_score")
        if isinstance(average, (int, float)):
            page_confidences.append(float(average))

        if center_images:
            markdown = center_markdown_images(markdown)
        page_path = pages_dir / f"page-{page_number:04d}.md"
        page_path.write_text(markdown.rstrip() + "\n", encoding="utf-8")
        combined_pages.append(format_markdown_page(page_number, markdown))

    combined_path = document_dir / f"{pdf_path.stem}.md"
    combined_path.write_text(
        "\n\n".join(combined_pages).rstrip() + "\n",
        encoding="utf-8",
    )
    (document_dir / "response.json").write_text(
        json.dumps(sanitized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    metadata = {
        "input_file": pdf_path.name,
        "input_bytes": pdf_path.stat().st_size,
        "input_sha256": sha256_file(pdf_path),
        "requested_model": requested_model,
        "response_model": response.get("model"),
        "elapsed_seconds": round(elapsed_seconds, 3),
        "page_count": len(pages),
        "usage_info": response.get("usage_info") or {},
        "image_count": image_count,
        "block_type_counts": dict(sorted(block_types.items())),
        "average_page_confidence": (
            round(sum(page_confidences) / len(page_confidences), 6)
            if page_confidences
            else None
        ),
        "minimum_average_page_confidence": (
            min(page_confidences) if page_confidences else None
        ),
        "center_images": center_images,
        "rate_limit_remaining": {
            key: value
            for key, value in response_headers.items()
            if key.startswith("x-ratelimit-remaining")
        },
    }
    (document_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return combined_path


def process_pdf(
    pdf_path: Path,
    output_root: Path,
    api_key: str,
    model: str = DEFAULT_MODEL,
    timeout: int = 600,
    center_images: bool = True,
    page_number_offset: int = 0,
) -> Path:
    """Run Mistral OCR on a PDF and export its response to a document folder."""
    started = time.monotonic()
    response, headers = call_ocr(
        api_key=api_key,
        body=make_request(pdf_path, model),
        timeout=timeout,
    )
    return export_result(
        pdf_path=pdf_path,
        output_root=output_root,
        requested_model=model,
        response=response,
        elapsed_seconds=time.monotonic() - started,
        response_headers=headers,
        center_images=center_images,
        page_number_offset=page_number_offset,
    )
