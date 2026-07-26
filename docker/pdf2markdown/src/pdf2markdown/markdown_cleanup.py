"""Conservative, block-aware cleanup for OCR-generated Markdown.

Mistral OCR returns both page Markdown and page-ordered structural blocks.  The
Markdown is generally the best representation of tables, lists, and images,
while the blocks are a more reliable source of truth for code/equation
classification and paragraph boundaries.  This module combines the two
without asking another model to rewrite the document.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any


_MATH_COMMAND_RE = re.compile(
    r"\\(?:"
    r"begin|end|frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|partial|nabla|"
    r"mathbf|mathrm|mathbb|mathcal|mathit|operatorname|text|left|right|"
    r"alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|"
    r"phi|varphi|psi|omega|cdot|times|otimes|leq|geq|neq|approx|equiv|"
    r"infty|to|mapsto|forall|exists|det|log|ln|exp"
    r")\b"
)
_CODE_KEYWORD_RE = re.compile(
    r"(?m)^\s*(?:"
    r"def|class|async\s+def|function|const|let|var|import|from|export|"
    r"public|private|protected|interface|type|fn|struct|enum|impl|"
    r"SELECT|INSERT|UPDATE|DELETE|CREATE|WITH|package|func|"
    r"if|for|while|switch|try|except|catch"
    r")\b"
)
_FENCE_RE = re.compile(
    r"^\s*(?P<fence>`{3,}|~{3,})(?P<language>[^\n]*)\n"
    r"(?P<body>[\s\S]*?)\n(?P=fence)\s*$"
)
_LANGUAGE_HINTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("python", re.compile(r"(?m)^\s*(?:def|class|from\s+\S+\s+import|import\s+\S+)")),
    ("typescript", re.compile(r"(?m)^\s*(?:interface|type)\s+\w+|:\s*(?:string|number|boolean)\b")),
    ("javascript", re.compile(r"(?m)^\s*(?:const|let|var|function|export|import)\b|=>")),
    ("shell", re.compile(r"(?m)^\s*(?:#!/.*(?:sh|bash)|(?:sudo\s+)?(?:npm|docker|git|curl)\s+)")),
    ("sql", re.compile(r"(?im)^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b")),
    ("json", re.compile(r'^\s*[\[{]\s*"[^"]+"\s*:', re.DOTALL)),
    ("html", re.compile(r"^\s*<!DOCTYPE\s+html|^\s*<[A-Za-z][^>]*>", re.IGNORECASE)),
    ("css", re.compile(r"(?m)^\s*[.#]?[A-Za-z][\w .#:[\]-]*\s*\{")),
    ("rust", re.compile(r"(?m)^\s*(?:fn|struct|enum|impl|use)\b")),
    ("go", re.compile(r"(?m)^\s*(?:package|func|type)\b")),
    ("java", re.compile(r"(?m)^\s*(?:public|private|protected)?\s*(?:class|interface|enum)\b")),
)


@dataclass
class CleanupStats:
    """Per-page accounting for transformations made by the cleanup pass."""

    code_blocks_wrapped: int = 0
    equations_wrapped: int = 0
    heuristic_code_blocks: int = 0
    heuristic_equation_blocks: int = 0
    block_boundaries_restored: int = 0
    unmatched_structural_blocks: int = 0

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class _LocatedBlock:
    start: int
    end: int
    content: str
    block_type: str
    render_as: str | None
    heuristic: bool


def _strip_math_delimiters(value: str) -> str:
    text = value.strip()
    wrappers = (("$$", "$$"), (r"\[", r"\]"), (r"\(", r"\)"))
    for opening, closing in wrappers:
        if text.startswith(opening) and text.endswith(closing):
            return text[len(opening) : -len(closing)].strip()
    if (
        len(text) >= 2
        and text.startswith("$")
        and text.endswith("$")
        and not text.startswith("$$")
        and not text.endswith("$$")
    ):
        return text[1:-1].strip()
    return text


def _strip_code_fence(value: str) -> tuple[str, str]:
    text = value.strip()
    match = _FENCE_RE.match(text)
    if not match:
        return text, ""
    return match.group("body").rstrip(), match.group("language").strip()


def _compact_with_map(value: str, start: int = 0) -> tuple[str, list[int]]:
    compact: list[str] = []
    source_positions: list[int] = []
    for position in range(start, len(value)):
        character = value[position]
        if character.isspace():
            continue
        compact.append(character)
        source_positions.append(position)
    return "".join(compact), source_positions


def _find_span(
    markdown: str,
    content: str,
    cursor: int,
) -> tuple[int, int] | None:
    """Find a block after cursor, tolerating whitespace lost by OCR."""

    candidates = [content.strip()]
    unfenced, _ = _strip_code_fence(content)
    unwrapped_math = _strip_math_delimiters(content)
    for candidate in (unfenced, unwrapped_math):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    page_compact, page_positions = _compact_with_map(markdown, cursor)
    for candidate in candidates:
        exact = markdown.find(candidate, cursor)
        if exact >= 0:
            return exact, exact + len(candidate)
        if not page_compact:
            continue
        candidate_compact = "".join(character for character in candidate if not character.isspace())
        if len(candidate_compact) < 3:
            continue
        compact_start = page_compact.find(candidate_compact)
        if compact_start < 0:
            continue
        compact_end = compact_start + len(candidate_compact) - 1
        return page_positions[compact_start], page_positions[compact_end] + 1
    return None


def _expand_math_wrapper(markdown: str, start: int, end: int) -> tuple[int, int]:
    left = start
    while left > 0 and markdown[left - 1] in " \t":
        left -= 1
    right = end
    while right < len(markdown) and markdown[right] in " \t":
        right += 1

    wrappers = (("$$", "$$"), (r"\[", r"\]"), (r"\(", r"\)"), ("$", "$"))
    for opening, closing in wrappers:
        possible_start = left - len(opening)
        if (
            possible_start >= 0
            and markdown[possible_start:left] == opening
            and markdown[right : right + len(closing)] == closing
        ):
            return possible_start, right + len(closing)
    return start, end


def _expand_code_wrapper(markdown: str, start: int, end: int) -> tuple[int, int]:
    line_start = markdown.rfind("\n", 0, start) + 1
    previous_line_end = max(0, line_start - 1)
    previous_line_start = markdown.rfind("\n", 0, previous_line_end) + 1
    opening_line = markdown[previous_line_start:previous_line_end].strip()
    opening = re.match(r"^(`{3,}|~{3,})", opening_line)
    if not opening:
        return start, end

    line_end = markdown.find("\n", end)
    if line_end < 0:
        line_end = len(markdown)
    current_line = markdown[end:line_end].strip()
    if current_line == opening.group(1):
        return previous_line_start, line_end

    next_line_start = line_end + 1 if line_end < len(markdown) else len(markdown)
    next_line_end = markdown.find("\n", next_line_start)
    if next_line_end < 0:
        next_line_end = len(markdown)
    if markdown[next_line_start:next_line_end].strip() == opening.group(1):
        return previous_line_start, next_line_end
    return start, end


def _looks_like_standalone_math(content: str) -> bool:
    text = content.strip()
    if not text or _strip_math_delimiters(text) != text:
        return False
    # Existing inline math inside prose is already delimited; wrapping the
    # containing paragraph as display math would make the prose invalid.
    if "$" in text or r"\(" in text or r"\[" in text:
        return False
    if not _MATH_COMMAND_RE.search(text):
        return False
    if text.startswith(("http://", "https://")) or "```" in text:
        return False

    commands = len(_MATH_COMMAND_RE.findall(text))
    math_signals = commands * 2
    math_signals += int(bool(re.search(r"[_^]|\{[^{}]*\}|[=<>]", text)))
    math_signals += int(bool(re.search(r"\\begin\{[^}]+\}", text)))
    words = re.findall(r"\b[A-Za-z]{3,}\b", re.sub(r"\\[A-Za-z]+", "", text))
    return math_signals >= 3 and (len(words) <= 14 or len(text) <= 180)


def _looks_like_code(content: str) -> bool:
    text, _ = _strip_code_fence(content)
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 2 or _MATH_COMMAND_RE.search(text):
        return False
    score = 0
    score += 3 * len(_CODE_KEYWORD_RE.findall(text))
    score += len(re.findall(r"[{};]", text))
    score += 2 * len(re.findall(r"(?m)^\s{2,}\S", text))
    score += 2 * len(re.findall(r"(?:==|!=|=>|:=|\+=|-=|&&|\|\|)", text))
    score += len(re.findall(r"(?m)^\s*(?:#include|//|/\*|\*|#\!|--\s)", text))
    sentence_lines = sum(
        1
        for line in lines
        if re.search(r"[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}", line)
        and line.rstrip().endswith((".", "?", "!"))
    )
    return score >= max(4, len(lines)) and sentence_lines <= max(1, len(lines) // 3)


def _guess_language(content: str, supplied: str = "") -> str:
    language = supplied.strip().split(maxsplit=1)[0] if supplied.strip() else ""
    if language and re.fullmatch(r"[A-Za-z0-9_+.#-]+", language):
        return language
    for name, pattern in _LANGUAGE_HINTS:
        if pattern.search(content):
            return name
    return ""


def _render_code(content: str) -> str:
    body, supplied_language = _strip_code_fence(content)
    language = _guess_language(body, supplied_language)
    return f"```{language}\n{body.rstrip()}\n```"


def _render_equation(content: str) -> str:
    body = _strip_math_delimiters(content)
    return f"$$\n{body.strip()}\n$$"


def _classify(block_type: str, content: str) -> tuple[str | None, bool]:
    normalized_type = block_type.lower().strip()
    if normalized_type == "code":
        return "code", False
    if normalized_type == "equation":
        return "equation", False
    if normalized_type in {"text", "aside_text", "caption", "unknown", ""}:
        if _looks_like_standalone_math(content):
            return "equation", True
        if _looks_like_code(content):
            return "code", True
    return None, False


def _locate_blocks(markdown: str, blocks: list[dict[str, Any]]) -> list[_LocatedBlock]:
    located: list[_LocatedBlock] = []
    cursor = 0
    for block in blocks:
        content = str(block.get("content") or "")
        if not content.strip():
            continue
        block_type = str(block.get("type") or "unknown")
        render_as, heuristic = _classify(block_type, content)
        span = _find_span(markdown, content, cursor)
        if span is None:
            if render_as is not None:
                located.append(
                    _LocatedBlock(
                        start=-1,
                        end=-1,
                        content=content,
                        block_type=block_type,
                        render_as=render_as,
                        heuristic=heuristic,
                    )
                )
            continue
        start, end = span
        if render_as == "equation":
            start, end = _expand_math_wrapper(markdown, start, end)
        elif render_as == "code":
            start, end = _expand_code_wrapper(markdown, start, end)
        if start < cursor:
            continue
        located.append(
            _LocatedBlock(
                start=start,
                end=end,
                content=content,
                block_type=block_type,
                render_as=render_as,
                heuristic=heuristic,
            )
        )
        cursor = end
    return located


def normalize_ocr_page_markdown(
    markdown: str,
    blocks: list[dict[str, Any]] | None,
) -> tuple[str, CleanupStats]:
    """Normalize one OCR page while preserving its source content.

    Transformations are limited to spans that can be mapped back to Mistral's
    page Markdown.  An unmatched structural block is reported but never
    appended blindly, which prevents duplicate or reordered document content.
    """

    source = markdown.replace("\r\n", "\n").replace("\r", "\n")
    stats = CleanupStats()
    if not source.strip() or not blocks:
        return source, stats

    all_located = _locate_blocks(source, blocks)
    stats.unmatched_structural_blocks = sum(
        1 for block in all_located if block.start < 0
    )
    located = [block for block in all_located if block.start >= 0]
    if not located:
        return source, stats

    chunks: list[str] = []
    cursor = 0
    previous: _LocatedBlock | None = None
    for block in located:
        if block.start < cursor:
            continue
        gap = source[cursor:block.start]
        if (
            previous is not None
            and gap
            and not gap.strip()
            and "\n\n" not in gap
        ):
            gap = "\n\n"
            stats.block_boundaries_restored += 1
        chunks.append(gap)

        original = source[block.start:block.end]
        replacement = original
        if block.render_as == "code":
            replacement = _render_code(block.content)
            if replacement.strip() != original.strip():
                stats.code_blocks_wrapped += 1
                if block.heuristic:
                    stats.heuristic_code_blocks += 1
        elif block.render_as == "equation":
            replacement = _render_equation(block.content)
            if replacement.strip() != original.strip():
                stats.equations_wrapped += 1
                if block.heuristic:
                    stats.heuristic_equation_blocks += 1
        chunks.append(replacement)
        cursor = block.end
        previous = block

    chunks.append(source[cursor:])
    normalized = "".join(chunks)
    normalized = re.sub(r"\n{4,}", "\n\n\n", normalized)
    return normalized, stats
