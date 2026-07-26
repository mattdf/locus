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
        page_height=page_height,
        page_width=page_width,
    )
    footers = _group_rows(
        by_type["footer"],
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
