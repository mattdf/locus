# Locus

A local-first chat UI for studying difficult technical material without blowing up every conversation into a mess of unorganized follow ups / clarifications. It can also run as a private, multi-user service with isolated accounts.

![Locus recursive learning chat interface](screenshot.png)

## How to use / What this does

- Select any rendered passage or equation and choose **Elaborate**.
- Choose **Visualize** to attach an inline MetaPost artifact: add an optional diagram hint,
  generate and sandbox-compile it to SVG with real LaTeX labels, edit/recompile the source,
  and download either format.
- The focused drawer receives the complete ancestor context, the exact selection, and your
  elaboration request.
- Repeat the same action inside a focused thread to create arbitrarily deep branches.
- Prior elaborations stay attached to their source passage; click anywhere in the marked
  source block to reopen the branch.
- Refresh or navigate back through nested focuses without losing the relevant source
  position, and use the floating message navigator in long conversations.
- Stream model responses into the thread as they are generated.
- Stop an in-flight response explicitly, see elapsed thinking time, and review duration,
  token usage, reasoning tokens, and estimated API cost on completed responses.
- Rename main threads and recursive branches inline from their pencil controls.
- Use `Cmd/Ctrl+B` and `Cmd/Ctrl+I` in any textarea, and choose whether Enter or
  `Cmd/Ctrl+Enter` sends messages.
- Scale chat text independently from browser zoom with the text-size setting.
- Choose OpenAI, OpenRouter, or a local OpenAI-compatible endpoint in Settings. Provider
  keys stay server-side, while OpenRouter and local model IDs are selectable from the chat box.
- Edit `SYSTEM_PROMPT.md` to change the base tutoring prompt, and add optional custom
  instructions from the UI that supplement it.
- Paste Markdown (including LaTeX) into a new study without making a model request.
- Choose a destination category while creating a new study or importing Markdown.
- Select the model and reasoning effort together from the active chat box; configure output
  limits, appearance, API access, custom instructions, and JSON transfers from Settings.
- Organize studies into collapsible, reorderable sidebar categories and move chats between them.
- Export one chat, any category (including Uncategorized), or the full library as JSON; import exports into an
  existing, new, preserved, or uncategorized destination.
- Recover LaTeX from ChatGPT rendered-copy imports where `\[` / `\(` delimiters were
  flattened into plain brackets and parentheses.
- Render LaTeX in chat titles, branch titles, saved elaboration labels, and selected quotes.
- In local mode, store the complete workspace as a readable JSON document in `data/chats.json`.
- In hosted mode, store each account's chats and settings separately in PostgreSQL and encrypt
  its BYOK provider credentials at rest.

## Run it

Requirements: Node.js 20+ and Docker Engine / Docker Desktop.

```bash
npm install
npm run metapost:build
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The web app runs on port 5173 and
proxies API requests to the local server on port 8787. Configure the provider in Settings,
then paste its API key or add `OPENAI_API_KEY.txt` / `OPENROUTER_API_KEY.txt` in this directory.
Local endpoints default to `http://127.0.0.1:1234/v1` and can run without a key.

For a production-style local run:

```bash
npm run build
npm start
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787).

Local mode remains the default: it has no login or database requirement and keeps the original
file-backed data format. To self-host private accounts instead, use `compose.hosted.yaml` and
the instructions in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Day-two operations are documented
in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Architecture

- `src/App.tsx` owns workspace and recursive-thread state.
- `src/components/MarkdownMessage.tsx` renders Markdown, KaTeX, and code; captures selections
  using original TeX source; and reconnects saved anchors to rendered passages.
- `src/lib/tree.ts` contains the small set of tree and context helpers.
- `src/lib/chatTransfer.ts` validates and creates portable chat/category exports.
- `server/openai.ts` builds prompts and streams either the OpenAI Responses API or an
  OpenAI-compatible Chat Completions endpoint.
- `server/providers.ts` owns provider credentials, base URLs, and model discovery.
- `server/workspaces.ts` applies owner-scoped, optimistic PostgreSQL workspace updates in hosted mode.
- `server/credentials.ts` keeps the file-backed local key behavior and adds per-user AES-256-GCM
  credential storage for hosted mode.
- `server/metapost.ts` validates figure bodies and uses either a fresh local compiler container or
  the isolated internal compiler service in `compose.hosted.yaml`.
- `SYSTEM_PROMPT.md` contains the base instructions loaded fresh for every model request.
- `server/storage.ts` persists the local mode's versioned JSON document using atomic replacement.

Threads are stored as a flat map with `parentId` links. That keeps updates cheap while
preserving an ordinary tree: walking parent links produces the exact context path supplied
to the model.

The multi-user design and its security boundaries are documented in
[MULTI_USER_PLAN.md](MULTI_USER_PLAN.md). `LOCUS_MODE=local` and `LOCUS_MODE=hosted` are explicit,
fail-closed modes; hosted mode never falls back to the global local workspace or key files.

## Notes

- The server binds to `127.0.0.1` by default so the API key is not exposed on the LAN.
- Keys pasted in the UI are written to provider-specific gitignored files under `data/`
  with owner-only permissions and take precedence over matching project key files.
- The default model is `gpt-5.6-sol` with `max` reasoning effort. Model and reasoning
  effort stay together in each chat composer.
- Custom instructions are stored locally with the workspace and appended to, rather than
  substituted for, `SYSTEM_PROMPT.md`.
- Set `PORT`, `HOST`, or `DATA_DIR` when starting the server if you need different local
  bindings or a separate persistent-data volume.
- Hosted registration is private and disabled. Administrators create or disable accounts with
  `npm run admin`; the deployment bootstrap creates only the first administrator.
- MetaPost jobs run as a non-root user with no network, no Linux capabilities, a read-only
  root filesystem, CPU/memory/PID/file-size limits, and only a disposable job directory
  mounted writable. `btex ... etex` labels pass through a bounded LaTeX command allowlist;
  TeX file access is paranoid, shell escape is disabled, and arbitrary preambles/macros are
  rejected before a container starts. The image and runtime commands are Linux/Docker portable; set
  `METAPOST_IMAGE` or `DOCKER_BIN` only when your deployment uses different names.
- The API permits two concurrent compiler containers by default. Set
  `METAPOST_MAX_CONCURRENCY` to a value from 1–16 to match the host's capacity.
