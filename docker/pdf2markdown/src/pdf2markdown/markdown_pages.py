"""Visible page markers for combined Markdown documents."""

from __future__ import annotations


def format_markdown_page(page_number: int, markdown: str) -> str:
    """Prefix one page with a visible rule, label, and stable HTML anchor."""
    if page_number < 1:
        raise ValueError("Page numbers must be positive")
    marker = (
        f'<hr>\n\n<p id="page-{page_number}" align="center">'
        f"<strong>Page {page_number}</strong></p>"
    )
    content = markdown.strip()
    return f"{marker}\n\n{content}" if content else marker
