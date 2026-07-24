# Local configuration

Locus starts in `LOCUS_MODE=local`. This mode has no authentication or database dependency and
binds the API to `127.0.0.1` by default so provider credentials are not exposed on the LAN.

## Provider credentials

Keys entered in Settings are saved to provider-specific files under `data/` with owner-only
permissions. These values take precedence over project-directory key files:
`OPENAI_API_KEY.txt`, `OPENROUTER_API_KEY.txt`, `ANTHROPIC_API_KEY.txt`,
`KIMI_API_KEY.txt`, `GLM_API_KEY.txt`, `MINIMAX_API_KEY.txt`,
`DEEPSEEK_API_KEY.txt`, and `QWEN_API_KEY.txt`.

Custom OpenAI-compatible endpoints may use HTTP or HTTPS locally. Their URL and model ID
can be changed in Settings, and a key is optional.

## Data and prompts

- `data/chats.json` stores the complete local workspace as a readable, versioned JSON document.
- `SYSTEM_PROMPT.md` contains the base tutoring instructions for chats and definitions.
- `VISUALIZATION_PROMPT.md` contains the dedicated semantic-design instructions for MetaPost and
  TikZ generation; the server appends the matching compiler contract at request time.
- `SOURCE_REWRITE_PROMPT.md` contains the bounded Markdown-rewrite and annotation-marker contract.
- Custom instructions are stored with the workspace and appended to the tutoring prompt. They are
  intentionally excluded from visualization generation.
- The default model is `gpt-5.6-sol` with `max` reasoning effort; model and effort can be changed
  from a chat composer.

## Server settings

Set these environment variables before starting the server when the defaults are unsuitable:

- `PORT`: API port; defaults to `8787`
- `HOST`: bind address; defaults to `127.0.0.1`
- `DATA_DIR`: persistent workspace and credential directory; defaults to `data/`
- `METAPOST_IMAGE`: custom visualization compiler image name
- `DOCKER_BIN`: custom Docker executable path
- `METAPOST_MAX_CONCURRENCY`: concurrent visualization jobs, from 1 through 16; defaults to 2

The MetaPost and TikZ pipelines require the compiler image built by `npm run metapost:build`.

## PDF import

PDF import runs in a separate persistent service and uses Mistral OCR. Start it before importing:

```bash
export MISTRAL_API_KEY='your-key'
npm run pdf:up
```

The local Compose file stores uploaded PDFs, converted Markdown, extracted images, job state, and
usage records in the `locus_pdf2markdown_data` Docker volume. It accepts multiple queued uploads
and processes four jobs concurrently by default. Change that with
`PDF2MARKDOWN_MAX_CONCURRENT_JOBS`.

The app connects to the local worker at `http://127.0.0.1:8091`. Override
`PDF2MARKDOWN_SERVICE_URL`, `PDF2MARKDOWN_API_TOKEN`, and
`PDF2MARKDOWN_ADMIN_TOKEN` only when running a customized worker configuration. The Mistral key
belongs to the worker and is never sent to the browser.
