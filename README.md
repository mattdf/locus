# Locus

A local-first chat UI for studying difficult technical material without blowing up every conversation into a mess of unorganized follow ups / clarifications.

![Locus recursive learning chat interface](screenshot.png)

## How to use / What this does

- Select any rendered passage or equation and choose **Elaborate**.
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
- Store the complete workspace as a readable local JSON document in `data/chats.json`.

## Run it

Requirement: Node.js 20+.

```bash
npm install
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

## Architecture

- `src/App.tsx` owns workspace and recursive-thread state.
- `src/components/MarkdownMessage.tsx` renders Markdown, KaTeX, and code; captures selections
  using original TeX source; and reconnects saved anchors to rendered passages.
- `src/lib/tree.ts` contains the small set of tree and context helpers.
- `src/lib/chatTransfer.ts` validates and creates portable chat/category exports.
- `server/openai.ts` builds prompts and streams either the OpenAI Responses API or an
  OpenAI-compatible Chat Completions endpoint.
- `server/providers.ts` owns provider credentials, base URLs, and model discovery.
- `SYSTEM_PROMPT.md` contains the base instructions loaded fresh for every model request.
- `server/storage.ts` persists one versioned JSON document using atomic replacement.

Threads are stored as a flat map with `parentId` links. That keeps updates cheap while
preserving an ordinary tree: walking parent links produces the exact context path supplied
to the model.

## Notes

- The server binds to `127.0.0.1` by default so the API key is not exposed on the LAN.
- Keys pasted in the UI are written to provider-specific gitignored files under `data/`
  with owner-only permissions and take precedence over matching project key files.
- The default model is `gpt-5.6-sol` with `max` reasoning effort. Model and reasoning
  effort stay together in each chat composer.
- Custom instructions are stored locally with the workspace and appended to, rather than
  substituted for, `SYSTEM_PROMPT.md`.
- Set `PORT` or `HOST` when starting the server if you need different local bindings.
