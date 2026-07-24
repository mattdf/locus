"""Replace Mistral OCR preview crops with native or high-resolution PDF assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
from dataclasses import asdict, dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable

import fitz
from PIL import Image

from .markdown_images import center_markdown_images
from .markdown_pages import format_markdown_page


@dataclass(frozen=True)
class RecoveryRecord:
    page: int
    image_id: str
    method: str
    old_path: str
    old_width: int | None
    old_height: int | None
    new_path: str
    new_width: int
    new_height: int
    pdf_bbox: tuple[float, float, float, float]
    render_bbox: tuple[float, float, float, float]
    source_xref: int | None
    source_smask: int | None


def _drawing_union(page: fitz.Page, predicted: fitz.Rect) -> fitz.Rect | None:
    """Expand a predicted figure box through nearby connected vector drawings."""
    all_rectangles = [drawing["rect"] for drawing in page.get_drawings()]
    rectangles = [
        rectangle for rectangle in all_rectangles if rectangle.intersects(predicted)
    ]
    if len(rectangles) < 5:
        return None
    result = fitz.Rect(rectangles[0])
    for rectangle in rectangles[1:]:
        result.include_rect(rectangle)
    for _ in range(3):
        neighborhood = _expanded_rect(result, page.rect, 26.0)
        connected = [
            rectangle
            for rectangle in all_rectangles
            if rectangle.intersects(neighborhood)
        ]
        expanded = fitz.Rect(result)
        for rectangle in connected:
            expanded.include_rect(rectangle)
        if expanded == result:
            break
        result = expanded
    if result.get_area() > page.rect.get_area() * 0.82:
        return None
    return result


def _safe_stem(value: str) -> str:
    stem = Path(value).stem
    return re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-") or "image"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ocr_bbox_to_pdf_rect(
    bbox: Iterable[float],
    page_width: float,
    page_height: float,
    ocr_width: float,
    ocr_height: float,
) -> fitz.Rect:
    """Map an OCR pixel bbox into the source PDF page coordinate space."""
    left, top, right, bottom = bbox
    if ocr_width <= 0 or ocr_height <= 0:
        raise ValueError("OCR page dimensions must be positive")
    rect = fitz.Rect(
        left * page_width / ocr_width,
        top * page_height / ocr_height,
        right * page_width / ocr_width,
        bottom * page_height / ocr_height,
    )
    if rect.is_empty or rect.is_infinite:
        raise ValueError(f"Invalid OCR image bbox: {tuple(bbox)}")
    return rect


def _intersection_fraction(first: fitz.Rect, second: fitz.Rect) -> float:
    intersection = first & second
    if intersection.is_empty:
        return 0.0
    denominator = min(first.get_area(), second.get_area())
    return intersection.get_area() / denominator if denominator else 0.0


def _page_coverage(info: dict[str, Any], page_rect: fitz.Rect) -> float:
    image_rect = fitz.Rect(info["bbox"])
    intersection = image_rect & page_rect
    page_area = page_rect.get_area()
    if intersection.is_empty or page_area <= 0:
        return 0.0
    return intersection.get_area() / page_area


def is_page_scan_image(
    info: dict[str, Any],
    page_rect: fitz.Rect,
    minimum_page_coverage: float = 0.9,
) -> bool:
    """Return whether an embedded raster covers nearly the entire PDF page."""
    return (
        int(info.get("xref", 0)) > 0
        and int(info.get("width", 0)) > 0
        and int(info.get("height", 0)) > 0
        and _page_coverage(info, page_rect) >= minimum_page_coverage
    )


def choose_embedded_image(
    predicted: fitz.Rect,
    image_infos: Iterable[dict[str, Any]],
    minimum_overlap: float = 0.75,
    page_rect: fitz.Rect | None = None,
    maximum_page_coverage: float = 0.9,
) -> dict[str, Any] | None:
    """Choose a real figure image substantially covered by an OCR bbox.

    When the page bounds are known, page-covering scan rasters are excluded.
    Otherwise, any small OCR figure region inside a scanned page would appear
    to overlap the full-page raster perfectly.
    """
    scored: list[tuple[float, dict[str, Any]]] = []
    for info in image_infos:
        if int(info.get("xref", 0)) <= 0:
            continue
        if page_rect is not None and is_page_scan_image(
            info,
            page_rect,
            minimum_page_coverage=maximum_page_coverage,
        ):
            continue
        score = _intersection_fraction(predicted, fitz.Rect(info["bbox"]))
        if score >= minimum_overlap:
            scored.append((score, info))
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def choose_page_scan(
    image_infos: Iterable[dict[str, Any]],
    page_rect: fitz.Rect,
    minimum_page_coverage: float = 0.9,
) -> dict[str, Any] | None:
    """Choose the highest-resolution raster that covers nearly a whole page."""
    candidates = [
        info
        for info in image_infos
        if is_page_scan_image(info, page_rect, minimum_page_coverage)
    ]
    if not candidates:
        return None

    def resolution_score(info: dict[str, Any]) -> tuple[float, int]:
        image_rect = fitz.Rect(info["bbox"])
        displayed_area = max(image_rect.get_area(), 1.0)
        pixel_count = int(info["width"]) * int(info["height"])
        return pixel_count / displayed_area, pixel_count

    return max(candidates, key=resolution_score)


def _has_direct_crop_transform(info: dict[str, Any]) -> bool:
    """Return whether the source raster is placed without rotation or skew."""
    values = info.get("transform")
    if not isinstance(values, (tuple, list)) or len(values) != 6:
        return False
    a, b, c, d, _, _ = (float(value) for value in values)
    tolerance = max(abs(a), abs(d), 1.0) * 1e-6
    return a > 0 and d > 0 and abs(b) <= tolerance and abs(c) <= tolerance


def pdf_rect_to_image_box(
    rect: fitz.Rect,
    image_info: dict[str, Any],
) -> tuple[int, int, int, int]:
    """Map a PDF rectangle to pixel coordinates in an axis-aligned raster."""
    if not _has_direct_crop_transform(image_info):
        raise ValueError("Page scan is rotated, mirrored, or skewed")

    width = int(image_info.get("width", 0))
    height = int(image_info.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("Page scan dimensions must be positive")

    transform = fitz.Matrix(*image_info["transform"])
    inverse = ~transform
    top_left = fitz.Point(rect.x0, rect.y0) * inverse
    bottom_right = fitz.Point(rect.x1, rect.y1) * inverse
    epsilon = 1e-5
    left = math.floor(max(0.0, min(1.0, top_left.x)) * width + epsilon)
    top = math.floor(max(0.0, min(1.0, top_left.y)) * height + epsilon)
    right = math.ceil(max(0.0, min(1.0, bottom_right.x)) * width - epsilon)
    bottom = math.ceil(max(0.0, min(1.0, bottom_right.y)) * height - epsilon)
    box = (left, top, right, bottom)
    if right <= left or bottom <= top:
        raise ValueError(f"Mapped page-scan crop is empty: {box}")
    return box


def _image_dimensions(path: Path) -> tuple[int | None, int | None]:
    if not path.is_file():
        return None, None
    with Image.open(path) as image:
        return image.size


def _extract_embedded_image(
    document: fitz.Document,
    xref: int,
    smask: int,
    output_stem: Path,
) -> tuple[Path, int, int]:
    if smask > 0:
        base = fitz.Pixmap(document, xref)
        mask = fitz.Pixmap(document, smask)
        pixmap = fitz.Pixmap(base, mask)
        path = output_stem.with_suffix(".png")
        path.write_bytes(pixmap.tobytes("png"))
        return path, pixmap.width, pixmap.height

    extracted = document.extract_image(xref)
    extension = str(extracted.get("ext") or "png").lower()
    if extension == "jpeg":
        extension = "jpg"
    data = extracted["image"]
    if extension not in {"png", "jpg", "webp"}:
        pixmap = fitz.Pixmap(document, xref)
        extension = "png"
        data = pixmap.tobytes("png")
    path = output_stem.with_suffix(f".{extension}")
    path.write_bytes(data)
    with Image.open(path) as image:
        width, height = image.size
    return path, width, height


def _crop_page_scan(
    document: fitz.Document,
    image_info: dict[str, Any],
    smask: int,
    rect: fitz.Rect,
    page_rect: fitz.Rect,
    output_path: Path,
    padding: float,
) -> tuple[int, int, fitz.Rect]:
    """Crop an OCR figure region directly from a page-covering source raster."""
    source_xref = int(image_info["xref"])
    source_rect = fitz.Rect(image_info["bbox"])
    crop_bounds = source_rect & page_rect
    if crop_bounds.is_empty:
        raise ValueError("Page scan does not intersect the PDF page")
    crop_rect = _expanded_rect(rect, crop_bounds, padding)

    base = fitz.Pixmap(document, source_xref)
    pixmap = base
    if smask > 0:
        mask = fitz.Pixmap(document, smask)
        pixmap = fitz.Pixmap(base, mask)

    crop_info = dict(image_info)
    crop_info["width"] = pixmap.width
    crop_info["height"] = pixmap.height
    pixel_box = pdf_rect_to_image_box(crop_rect, crop_info)
    with Image.open(BytesIO(pixmap.tobytes("png"))) as image:
        cropped = image.crop(pixel_box)
        if "A" in cropped.getbands():
            rgba = cropped.convert("RGBA")
            flattened = Image.new("RGB", rgba.size, "white")
            flattened.paste(rgba, mask=rgba.getchannel("A"))
            cropped = flattened
        cropped.save(output_path, format="PNG", optimize=True)
        width, height = cropped.size
    return width, height, crop_rect


def _expanded_rect(rect: fitz.Rect, page_rect: fitz.Rect, padding: float) -> fitz.Rect:
    expanded = fitz.Rect(
        rect.x0 - padding,
        rect.y0 - padding,
        rect.x1 + padding,
        rect.y1 + padding,
    )
    return expanded & page_rect


def _render_pdf_region(
    page: fitz.Page,
    rect: fitz.Rect,
    output_path: Path,
    dpi: int,
    padding: float,
    expand_vector_geometry: bool,
) -> tuple[int, int, fitz.Rect]:
    render_rect = fitz.Rect(rect)
    if expand_vector_geometry:
        drawing_rect = _drawing_union(page, rect)
        if drawing_rect is not None:
            # OCR's top edge reliably separates a figure from a preceding
            # section title. Expand the other edges to connected PDF drawing
            # geometry without pulling a clipped duplicate heading into the
            # image (Attention page 13 is a representative case).
            render_rect.x0 = min(render_rect.x0, drawing_rect.x0)
            render_rect.x1 = max(render_rect.x1, drawing_rect.x1)
            render_rect.y1 = max(render_rect.y1, drawing_rect.y1)
    clip = _expanded_rect(render_rect, page.rect, padding)
    caption_tops = [
        float(block[1])
        for block in page.get_text("blocks", sort=True)
        if float(block[1]) >= rect.y1 - 3.0
        and re.match(r"^Figure\s+\d+\s*:", " ".join(str(block[4]).split()))
    ]
    if caption_tops:
        clip.y1 = min(clip.y1, min(caption_tops) - 2.0)
    pixmap = page.get_pixmap(dpi=dpi, clip=clip, alpha=False, annots=False)
    output_path.write_bytes(pixmap.tobytes("png"))
    return pixmap.width, pixmap.height, clip


def _replace_image_path(markdown: str, old_path: str, new_path: str) -> str:
    markdown = markdown.replace(f"]({old_path})", f"]({new_path})")
    markdown = markdown.replace(f'src="{old_path}"', f'src="{new_path}"')
    markdown = markdown.replace(f"src='{old_path}'", f"src='{new_path}'")
    return markdown


def upgrade_document_images(
    pdf_path: Path,
    result_dir: Path,
    dpi: int = 360,
    padding_points: float = 6.0,
    scan_padding_points: float = 0.0,
    center_images: bool = True,
) -> Path:
    """Create high-quality assets and an HQ Markdown variant for one OCR result."""
    pdf_path = pdf_path.resolve()
    result_dir = result_dir.resolve()
    response_path = result_dir / "response.json"
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if not response_path.is_file():
        raise FileNotFoundError(f"Mistral response not found: {response_path}")
    if dpi < 72:
        raise ValueError("DPI must be at least 72")
    if padding_points < 0 or scan_padding_points < 0:
        raise ValueError("Padding must not be negative")

    response = json.loads(response_path.read_text(encoding="utf-8"))
    assets_dir = result_dir / "assets-hq"
    pages_dir = result_dir / "pages-hq"
    shutil.rmtree(assets_dir, ignore_errors=True)
    shutil.rmtree(pages_dir, ignore_errors=True)
    assets_dir.mkdir(parents=True)
    pages_dir.mkdir(parents=True)

    document = fitz.open(pdf_path)
    records: list[RecoveryRecord] = []
    combined_pages: list[str] = []
    try:
        for position, page_data in enumerate(response.get("pages") or []):
            page_index = int(page_data.get("index", position))
            page_number = page_index + 1
            page = document.load_page(page_index)
            dimensions = page_data.get("dimensions") or {}
            ocr_width = float(dimensions.get("width") or 0)
            ocr_height = float(dimensions.get("height") or 0)
            source_page_path = result_dir / "pages" / f"page-{page_number:04d}.md"
            if not source_page_path.is_file():
                raise FileNotFoundError(f"OCR page Markdown not found: {source_page_path}")
            markdown = source_page_path.read_text(encoding="utf-8")
            image_infos = page.get_image_info(xrefs=True)
            page_images = page_data.get("images") or []
            smasks = {
                int(item[0]): int(item[1])
                for item in page.get_images(full=True)
                if int(item[0]) > 0
            }

            for image_position, image_data in enumerate(page_images):
                image_id = str(image_data.get("id") or f"image-{image_position}")
                old_path = str(
                    image_data.get("asset_path")
                    or f"assets/page-{page_number:04d}-{image_id}"
                )
                bbox = (
                    float(image_data["top_left_x"]),
                    float(image_data["top_left_y"]),
                    float(image_data["bottom_right_x"]),
                    float(image_data["bottom_right_y"]),
                )
                predicted = ocr_bbox_to_pdf_rect(
                    bbox,
                    page.rect.width,
                    page.rect.height,
                    ocr_width,
                    ocr_height,
                )
                filename_stem = f"page-{page_number:04d}-{_safe_stem(image_id)}"
                output_stem = assets_dir / filename_stem
                embedded = choose_embedded_image(
                    predicted,
                    image_infos,
                    page_rect=page.rect,
                )
                page_scan = choose_page_scan(image_infos, page.rect)
                source_xref: int | None = None
                source_smask: int | None = None
                if embedded is not None:
                    source_xref = int(embedded["xref"])
                    source_smask = smasks.get(source_xref, 0)
                    output_path, width, height = _extract_embedded_image(
                        document,
                        source_xref,
                        source_smask,
                        output_stem,
                    )
                    method = "embedded-image-lossless"
                    render_rect = fitz.Rect(embedded["bbox"])
                elif page_scan is not None and _has_direct_crop_transform(page_scan):
                    source_xref = int(page_scan["xref"])
                    source_smask = smasks.get(source_xref, 0)
                    output_path = output_stem.with_suffix(".png")
                    width, height, render_rect = _crop_page_scan(
                        document,
                        page_scan,
                        source_smask,
                        predicted,
                        page.rect,
                        output_path,
                        scan_padding_points,
                    )
                    method = "page-scan-raster-crop"
                else:
                    output_path = output_stem.with_suffix(".png")
                    width, height, render_rect = _render_pdf_region(
                        page,
                        predicted,
                        output_path,
                        dpi,
                        padding_points,
                        expand_vector_geometry=len(page_images) == 1,
                    )
                    method = f"pdf-region-render-{dpi}dpi"

                new_path = f"assets-hq/{output_path.name}"
                markdown = _replace_image_path(markdown, old_path, new_path)
                old_width, old_height = _image_dimensions(result_dir / old_path)
                records.append(
                    RecoveryRecord(
                        page=page_number,
                        image_id=image_id,
                        method=method,
                        old_path=old_path,
                        old_width=old_width,
                        old_height=old_height,
                        new_path=new_path,
                        new_width=width,
                        new_height=height,
                        pdf_bbox=tuple(round(value, 3) for value in predicted),
                        render_bbox=tuple(round(value, 3) for value in render_rect),
                        source_xref=source_xref,
                        source_smask=source_smask,
                    )
                )

            if center_images:
                markdown = center_markdown_images(markdown)
            page_output = pages_dir / f"page-{page_number:04d}.md"
            page_output.write_text(markdown.rstrip() + "\n", encoding="utf-8")
            combined_pages.append(format_markdown_page(page_number, markdown))
    finally:
        document.close()

    output_path = result_dir / f"{pdf_path.stem}-hq.md"
    output_path.write_text("\n\n".join(combined_pages).rstrip() + "\n", encoding="utf-8")
    report = {
        "schema_version": 2,
        "source_pdf": str(pdf_path),
        "source_sha256": _sha256(pdf_path),
        "ocr_response": str(response_path),
        "render_dpi": dpi,
        "padding_points": padding_points,
        "scan_padding_points": scan_padding_points,
        "center_images": center_images,
        "asset_count": len(records),
        "lossless_embedded_count": sum(
            record.method == "embedded-image-lossless" for record in records
        ),
        "page_scan_crop_count": sum(
            record.method == "page-scan-raster-crop" for record in records
        ),
        "rendered_pdf_region_count": sum(
            record.method.startswith("pdf-region-render") for record in records
        ),
        "assets": [asdict(record) for record in records],
    }
    (result_dir / "image-upgrade-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="Original source PDF")
    parser.add_argument("result_dir", type=Path, help="Mistral OCR result directory")
    parser.add_argument("--dpi", type=int, default=360, help="PDF render DPI (default: 360)")
    parser.add_argument(
        "--padding-points",
        type=float,
        default=6.0,
        help="Padding around rendered PDF regions in points (default: 6.0)",
    )
    parser.add_argument(
        "--scan-padding-points",
        type=float,
        default=0.0,
        help="Padding around direct page-scan crops in points (default: 0)",
    )
    parser.add_argument(
        "--no-center-images",
        action="store_true",
        help="Keep images left-aligned instead of centering them",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_path = upgrade_document_images(
        args.pdf,
        args.result_dir,
        dpi=args.dpi,
        padding_points=args.padding_points,
        scan_padding_points=args.scan_padding_points,
        center_images=not args.no_center_images,
    )
    print(f"Saved {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
