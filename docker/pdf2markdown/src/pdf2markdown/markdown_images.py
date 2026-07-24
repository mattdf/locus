"""Formatting helpers for images in generated Markdown documents."""

from __future__ import annotations

import html
import re


_MARKDOWN_IMAGE_LINE_RE = re.compile(
    r"(?m)^(?P<indent>[ \t]*)!\[(?P<alt>(?:\\.|[^\]])*)\]"
    r"\((?P<src><[^>\n]+>|[^)\n]+)\)[ \t]*$"
)
_HTML_IMAGE_LINE_RE = re.compile(
    r"(?mi)^(?P<indent>[ \t]*)(?P<tag><img\b[^>\n]*?/?>)[ \t]*$"
)


def center_markdown_images(markdown: str) -> str:
    """Center standalone Markdown and HTML images using portable HTML markup."""

    def replace_markdown(match: re.Match[str]) -> str:
        alt = re.sub(r"\\([\\\[\]])", r"\1", match.group("alt"))
        source = match.group("src").strip()
        if source.startswith("<") and source.endswith(">"):
            source = source[1:-1]
        return (
            f'{match.group("indent")}<p align="center"><img '
            f'src="{html.escape(source, quote=True)}" '
            f'alt="{html.escape(alt, quote=True)}" /></p>'
        )

    centered = _MARKDOWN_IMAGE_LINE_RE.sub(replace_markdown, markdown)

    def replace_html(match: re.Match[str]) -> str:
        return (
            f'{match.group("indent")}<p align="center">'
            f'{match.group("tag")}</p>'
        )

    return _HTML_IMAGE_LINE_RE.sub(replace_html, centered)
