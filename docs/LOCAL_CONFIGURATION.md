# Local configuration

Locus starts in `LOCUS_MODE=local`. This mode has no authentication or database dependency and
binds the API to `127.0.0.1` by default so provider credentials are not exposed on the LAN.

## Provider credentials

Keys entered in Settings are saved to provider-specific files under `data/` with owner-only
permissions. These values take precedence over `OPENAI_API_KEY.txt` and
`OPENROUTER_API_KEY.txt` in the project directory.

OpenAI-compatible local endpoints default to `http://127.0.0.1:1234/v1`. Their URL and model ID
can be changed in Settings, and a key is optional.

## Data and prompts

- `data/chats.json` stores the complete local workspace as a readable, versioned JSON document.
- `SYSTEM_PROMPT.md` contains the base instructions and is loaded for every model request.
- Custom instructions are stored with the workspace and appended to the base system prompt.
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

