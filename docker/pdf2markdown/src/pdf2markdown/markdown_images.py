"""Formatting helpers for images in generated Markdown documents."""

from __future__ import annotations

import re


_MARKDOWN_IMAGE_LINE_RE = re.compile(
    r"(?m)^(?P<indent>[ \t]*)!\[(?P<alt>(?:\\.|[^\]])*)\]"
    r"\((?P<src><[^>\n]+>|[^)\n]+)\)[ \t]*$"
)
_HTML_IMAGE_LINE_RE = re.compile(
    r"(?mi)^(?P<indent>[ \t]*)(?P<tag><img\b[^>\n]*?/?>)[ \t]*$"
)
_HTML_ATTRIBUTE_RE = re.compile(
    r"""(?P<name>src|alt)\s*=\s*(?P<quote>["'])(?P<value>.*?)(?P=quote)""",
    re.IGNORECASE,
)


def center_markdown_images(markdown: str) -> str:
    """Keep images as portable Markdown; the consuming UI controls alignment."""

    def replace_html(match: re.Match[str]) -> str:
        attributes = {
            item.group("name").lower(): item.group("value")
            for item in _HTML_ATTRIBUTE_RE.finditer(match.group("tag"))
        }
        source = attributes.get("src")
        if not source:
            return match.group(0)
        alt = attributes.get("alt", "").replace("[", r"\[").replace("]", r"\]")
        return f'{match.group("indent")}![{alt}]({source})'

    portable = _HTML_IMAGE_LINE_RE.sub(replace_html, markdown)
    return _MARKDOWN_IMAGE_LINE_RE.sub(lambda match: match.group(0), portable)
