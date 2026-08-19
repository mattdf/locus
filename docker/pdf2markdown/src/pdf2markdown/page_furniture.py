"""Extract semantic running headers and footers from Mistral OCR blocks."""

from __future__ import annotations

import re
from typing import Any


FURNITURE_TYPES = {"header", "footer"}


def _normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _content_is_present(markdown: str, content: str) -> bool:
    if content.strip() in markdown:
        return True
    return _normalized_text(content) in _normalized_text(markdown)


def _markdown_blocks(markdown: str) -> list[str]:
    return [block.strip() for block in re.split(r"\n[ \t]*\n", markdown) if block.strip()]


def _content_block_index(markdown: str, content: str) -> int | None:
    target = _normalized_text(content)
    for index, block in enumerate(_markdown_blocks(markdown)):
        if block == content.strip() or _normalized_text(block) == target:
            return index
    return None


def _alignment(block: dict[str, Any], page_width: float) -> str:
    left = float(block.get("top_left_x") or 0)
    right = float(block.get("bottom_right_x") or left)
    center = (left + right) / 2
    if page_width <= 0:
        return "center"
    if center <= page_width * 0.36:
        return "left"
    if center >= page_width * 0.64:
        return "right"
    return "center"


def _group_rows(
    blocks: list[dict[str, Any]],
    *,
    markdown: str,
    page_height: float,
    page_width: float,
) -> list[dict[str, Any]]:
    ordered = sorted(
        blocks,
        key=lambda block: (
            float(block.get("top_left_y") or 0),
            float(block.get("top_left_x") or 0),
        ),
    )
    tolerance = max(12.0, page_height * 0.025)
    rows: list[list[dict[str, Any]]] = []
    row_centers: list[float] = []
    for block in ordered:
        top = float(block.get("top_left_y") or 0)
        bottom = float(block.get("bottom_right_y") or top)
        center = (top + bottom) / 2
        if rows and abs(center - row_centers[-1]) <= tolerance:
            rows[-1].append(block)
            count = len(rows[-1])
            row_centers[-1] = (row_centers[-1] * (count - 1) + center) / count
        else:
            rows.append([block])
            row_centers.append(center)

    result: list[dict[str, Any]] = []
    for row_index, row in enumerate(rows):
        row.sort(key=lambda block: float(block.get("top_left_x") or 0))
        for item_index, block in enumerate(row):
            result.append(
                {
                    "content": str(block.get("content") or "").strip(),
                    "align": _alignment(block, page_width),
                    "row": row_index,
                    "row_index": item_index,
                    "row_size": len(row),
                    "block_index": _content_block_index(
                        markdown,
                        str(block.get("content") or ""),
                    ),
                }
            )
    return result


def page_furniture(
    page: dict[str, Any],
    *,
    page_number: int,
) -> dict[str, Any] | None:
    """Return only header/footer blocks that are present in the page Markdown."""

    markdown = str(page.get("markdown") or "")
    dimensions = page.get("dimensions") or {}
    page_width = float(dimensions.get("width") or 0)
    page_height = float(dimensions.get("height") or 0)
    by_type: dict[str, list[dict[str, Any]]] = {
        "header": [],
        "footer": [],
    }
    for block in page.get("blocks") or []:
        block_type = str(block.get("type") or "").lower().strip()
        content = str(block.get("content") or "")
        if (
            block_type in FURNITURE_TYPES
            and content.strip()
            and _content_is_present(markdown, content)
        ):
            by_type[block_type].append(block)

    headers = _group_rows(
        by_type["header"],
        markdown=markdown,
        page_height=page_height,
        page_width=page_width,
    )
    footers = _group_rows(
        by_type["footer"],
        markdown=markdown,
        page_height=page_height,
        page_width=page_width,
    )
    if not headers and not footers:
        return None
    return {
        "page": page_number,
        "headers": headers,
        "footers": footers,
    }


def boundary_layout_candidates(page: dict[str, Any]) -> list[dict[str, Any]]:
    """Return compact OCR geometry for blocks near the top/bottom page edges."""

    dimensions = page.get("dimensions") or {}
    page_width = float(dimensions.get("width") or 0)
    page_height = float(dimensions.get("height") or 0)
    if page_height <= 0:
        return []
    candidates: list[dict[str, Any]] = []
    for block in page.get("blocks") or []:
        content = str(block.get("content") or "").strip()
        if not content:
            continue
        top = float(block.get("top_left_y") or 0)
        bottom = float(block.get("bottom_right_y") or top)
        center = (top + bottom) / 2
        if center <= page_height * 0.20:
            region = "top"
        elif center >= page_height * 0.80:
            region = "bottom"
        else:
            continue
        candidates.append(
            {
                "content": content[:2000],
                "type": str(block.get("type") or "unknown")[:80],
                "align": _alignment(block, page_width),
                "verticalRegion": region,
                "top": round(top / page_height, 5),
                "bottom": round(bottom / page_height, 5),
            }
        )
    return candidates[:24]


def merge_document_furniture(
    ocr: dict[str, Any],
    model: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge model-classified furniture with OCR-native semantic blocks."""

    if not model:
        return ocr
    pages: dict[int, dict[str, Any]] = {
        int(page["page"]): {
            "page": int(page["page"]),
            "headers": list(page.get("headers") or []),
            "footers": list(page.get("footers") or []),
        }
        for page in ocr.get("pages") or []
    }
    for classified in model.get("pages") or []:
        page_number = int(classified.get("page") or 0)
        if page_number < 1:
            continue
        target = pages.setdefault(
            page_number,
            {"page": page_number, "headers": [], "footers": []},
        )
        for key in ("headers", "footers"):
            existing = {
                _normalized_text(str(item.get("content") or ""))
                for item in target[key]
            }
            for item in classified.get(key) or []:
                normalized = _normalized_text(str(item.get("content") or ""))
                if not normalized or normalized in existing:
                    continue
                target[key].append(item)
                existing.add(normalized)
            target[key].sort(
                key=lambda item: (
                    int(item.get("block_index"))
                    if item.get("block_index") is not None
                    else 1_000_000,
                    int(item.get("row") or 0),
                    int(item.get("row_index") or 0),
                )
            )
    return {
        "page_count": int(ocr.get("page_count") or model.get("page_count") or 0),
        "pages": [pages[number] for number in sorted(pages)],
    }


def document_furniture(
    response: dict[str, Any],
    *,
    page_number_offset: int = 0,
) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    source_pages = response.get("pages") or []
    for position, page in enumerate(source_pages):
        page_index = int(page.get("index", position))
        item = page_furniture(
            page,
            page_number=page_index + 1 + page_number_offset,
        )
        if item is not None:
            pages.append(item)
    return {
        "page_count": len(source_pages),
        "pages": pages,
    }
