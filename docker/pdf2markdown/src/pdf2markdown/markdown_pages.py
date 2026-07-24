"""Visible page markers for combined Markdown documents."""

from __future__ import annotations


def format_markdown_page(page_number: int, markdown: str) -> str:
    """Prefix one page with portable Markdown-only page furniture."""
    if page_number < 1:
        raise ValueError("Page numbers must be positive")
    marker = f"---\n\n**Page {page_number}**"
    content = markdown.strip()
    return f"{marker}\n\n{content}" if content else marker
