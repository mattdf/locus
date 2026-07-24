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
- OpenAI, OpenRouter, Claude, Kimi, GLM, MiniMax, DeepSeek, Qwen, and multiple custom OpenAI-compatible providers with BYOK credentials
- Independent provider/model routing for chat, definitions, visualizations, and rewrites
- Hosted access controls with public signup, waitlists, invite links, managed API access, and account suspension
- PDF import with equation-aware Mistral OCR, rendered extracted images, and retained source documents
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
`OPENAI_API_KEY.txt`, `OPENROUTER_API_KEY.txt`, `DEEPSEEK_API_KEY.txt`, or
`QWEN_API_KEY.txt` in the project directory. Local
Custom OpenAI-compatible endpoints can use HTTP or HTTPS locally and may omit a key when the server does not require one.

PDF import additionally requires a Mistral API key and its persistent worker:

```bash
export MISTRAL_API_KEY='your-key'
npm run pdf:up
```

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
