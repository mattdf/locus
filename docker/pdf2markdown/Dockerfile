# syntax=docker/dockerfile:1.7

FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="PDF to Markdown Service" \
      org.opencontainers.image.description="Mistral OCR 4 PDF conversion with high-quality figure recovery"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PDF2MARKDOWN_WORK_ROOT=/tmp/pdf2markdown \
    PDF2MARKDOWN_DATA_ROOT=/data/pdf2markdown

WORKDIR /app

RUN groupadd --system --gid 10001 pdf2markdown \
    && useradd --system --uid 10001 --gid pdf2markdown --home-dir /app pdf2markdown \
    && mkdir -p /data/pdf2markdown \
    && chown -R pdf2markdown:pdf2markdown /data

COPY pyproject.toml README.md ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install ".[service]" \
    && python -c "from pdf2markdown.persistent_service import app; assert app"

USER pdf2markdown

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=3)"]

CMD ["uvicorn", "pdf2markdown.persistent_service:app", "--host", "0.0.0.0", "--port", "8000"]
