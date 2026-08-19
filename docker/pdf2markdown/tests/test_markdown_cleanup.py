from __future__ import annotations

import base64
import json
from pathlib import Path

from pdf2markdown import mistral_ocr
from pdf2markdown.markdown_cleanup import normalize_ocr_page_markdown
from pdf2markdown.mistral_ocr import export_result


def test_structural_code_and_equation_blocks_are_normalized() -> None:
    markdown = (
        "Example code:\n"
        "def square(x):\n    return x * x\n"
        "The governing equation follows:\n"
        r"\frac{\partial u}{\partial t} = \nabla^2 u"
    )
    blocks = [
        {"type": "text", "content": "Example code:"},
        {"type": "code", "content": "def square(x):\n    return x * x"},
        {"type": "text", "content": "The governing equation follows:"},
        {
            "type": "equation",
            "content": r"\frac{\partial u}{\partial t} = \nabla^2 u",
        },
    ]

    cleaned, stats = normalize_ocr_page_markdown(markdown, blocks)

    assert "```python\ndef square(x):\n    return x * x\n```" in cleaned
    assert "$$\n\\frac{\\partial u}{\\partial t} = \\nabla^2 u\n$$" in cleaned
    assert "Example code:\n\n```python" in cleaned
    assert stats.code_blocks_wrapped == 1
    assert stats.equations_wrapped == 1
    assert stats.block_boundaries_restored >= 2


def test_existing_fences_are_preserved_without_double_wrapping() -> None:
    markdown = (
        "```typescript\nconst answer: number = 42;\n```\n\n"
        "$$\nE = mc^2\n$$"
    )
    blocks = [
        {
            "type": "code",
            "content": "```typescript\nconst answer: number = 42;\n```",
        },
        {"type": "equation", "content": "$$E = mc^2$$"},
    ]

    cleaned, stats = normalize_ocr_page_markdown(markdown, blocks)

    assert cleaned.count("```typescript") == 1
    assert cleaned.count("$$") == 2
    assert "E = mc^2" in cleaned
    assert stats.code_blocks_wrapped == 0
    assert stats.equations_wrapped == 0


def test_whitespace_insensitive_mapping_restores_code_newlines() -> None:
    markdown = "Implementation:\nconst x = 1; const y = x + 2;\nDone."
    blocks = [
        {"type": "text", "content": "Implementation:"},
        {"type": "code", "content": "const x = 1;\nconst y = x + 2;"},
        {"type": "text", "content": "Done."},
    ]

    cleaned, stats = normalize_ocr_page_markdown(markdown, blocks)

    assert "```javascript\nconst x = 1;\nconst y = x + 2;\n```" in cleaned
    assert stats.code_blocks_wrapped == 1


def test_high_confidence_untyped_math_is_wrapped_but_prose_is_not() -> None:
    markdown = (
        "The command \\text is sometimes mentioned in prose.\n"
        "We use $x_i$ and $y_i$ where $x_i \\in \\mathbb{R}$ in this paragraph.\n"
        r"\sum_{i=1}^{n} x_i = \frac{n(n+1)}{2}"
    )
    blocks = [
        {
            "type": "text",
            "content": "The command \\text is sometimes mentioned in prose.",
        },
        {
            "type": "text",
            "content": (
                "We use $x_i$ and $y_i$ where "
                "$x_i \\in \\mathbb{R}$ in this paragraph."
            ),
        },
        {
            "type": "text",
            "content": r"\sum_{i=1}^{n} x_i = \frac{n(n+1)}{2}",
        },
    ]

    cleaned, stats = normalize_ocr_page_markdown(markdown, blocks)

    assert cleaned.startswith("The command \\text is sometimes mentioned in prose.")
    assert "We use $x_i$ and $y_i$ where $x_i \\in \\mathbb{R}$" in cleaned
    assert "$$\n\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}\n$$" in cleaned
    assert stats.heuristic_equation_blocks == 1


def test_unmatched_structural_content_is_not_appended_or_duplicated() -> None:
    cleaned, stats = normalize_ocr_page_markdown(
        "Visible paragraph.",
        [
            {"type": "text", "content": "Visible paragraph."},
            {"type": "equation", "content": r"\frac{missing}{content}"},
        ],
    )

    assert cleaned == "Visible paragraph."
    assert "missing" not in cleaned
    assert stats.unmatched_structural_blocks == 1


def test_export_records_cleanup_metadata_and_preserves_raw_response(
    tmp_path: Path,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\n")
    response = {
        "model": "mistral-ocr-4-0",
        "pages": [
            {
                "index": 0,
                "markdown": r"\frac{a}{b}=c",
                "blocks": [
                    {"type": "equation", "content": r"\frac{a}{b}=c"}
                ],
                "images": [],
            }
        ],
    }
    progress: list[tuple[str, int, int, str]] = []

    combined_path = export_result(
        pdf_path=pdf_path,
        output_root=tmp_path / "output",
        requested_model="mistral-ocr-4-0",
        response=response,
        elapsed_seconds=1.0,
        response_headers={},
        center_images=False,
        progress_callback=lambda stage, current, total, message: progress.append(
            (stage, current, total, message)
        ),
    )

    assert "$$\n\\frac{a}{b}=c\n$$" in combined_path.read_text(encoding="utf-8")
    document_dir = combined_path.parent
    metadata = json.loads((document_dir / "metadata.json").read_text())
    assert metadata["markdown_cleanup"]["totals"]["equations_wrapped"] == 1
    sanitized = json.loads((document_dir / "response.json").read_text())
    assert sanitized["pages"][0]["markdown"] == r"\frac{a}{b}=c"
    assert progress == [("exporting", 1, 1, "Saving OCR page 1 of 1")]


def test_process_pdf_reports_the_opaque_mistral_wait_and_export_progress(
    tmp_path: Path,
    monkeypatch,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\n")
    response = {
        "model": "mistral-ocr-4-0",
        "pages": [
            {
                "index": 0,
                "markdown": "A page.",
                "blocks": [],
                "images": [],
            }
        ],
    }

    def fake_call_ocr(*, api_key, body, timeout, status_callback=None):
        assert api_key == "secret"
        assert body
        assert timeout == 30
        if status_callback is not None:
            status_callback("Waiting for Mistral OCR")
        return response, {}

    monkeypatch.setattr(mistral_ocr, "call_ocr", fake_call_ocr)
    progress: list[tuple[str, int, int, str]] = []
    mistral_ocr.process_pdf(
        pdf_path=pdf_path,
        output_root=tmp_path / "output",
        api_key="secret",
        timeout=30,
        center_images=False,
        progress_callback=lambda stage, current, total, message: progress.append(
            (stage, current, total, message)
        ),
    )

    assert [event[0] for event in progress] == [
        "preparing",
        "mistral",
        "mistral",
        "exporting",
        "exporting",
    ]
    assert progress[-1] == ("exporting", 1, 1, "Saving OCR page 1 of 1")
