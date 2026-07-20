# Locus

Locus is a local-first chat interface for studying difficult technical material. Select a
passage or equation to elaborate on it in a recursive side thread without cluttering the main
conversation.

![Locus chat interface](screenshot.png)

## Features

- Recursive elaboration threads attached directly to selected text and equations
- Inline definitions, quotations, and sandboxed MetaPost or TikZ visualizations
- Markdown, syntax-highlighted code, and KaTeX rendering throughout the interface
- Streaming responses with cancellation, regeneration variants, editable prompts, usage, and cost details
- OpenAI, OpenRouter, and local OpenAI-compatible model providers with BYOK credentials
- Markdown import plus portable JSON import and export
- Categories, sharing, search-friendly URLs, and persistent navigation through nested threads
- Local single-user mode by default, with an optional private multi-user deployment

## Run locally

Requirements: Node.js 20+ and Docker Engine or Docker Desktop.

```bash
npm install
npm run metapost:build
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The development server proxies API
requests to the local API on port 8787.

Configure a provider and API key in **Settings**. Alternatively, place
`OPENAI_API_KEY.txt` or `OPENROUTER_API_KEY.txt` in the project directory. Local
OpenAI-compatible endpoints default to `http://127.0.0.1:1234/v1` and do not require a key.

For a production-style local build:

```bash
npm run build:production
npm run start:production
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787).

Local mode requires no login or database. Chats and settings are stored in `data/chats.json`.

## Documentation

- [Local configuration](docs/LOCAL_CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Hosted deployment](docs/DEPLOYMENT.md)
- [Hosted operations](docs/OPERATIONS.md)

