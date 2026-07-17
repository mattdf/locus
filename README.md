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
- Paste an OpenAI API key in Settings, or keep using `OPENAI_API_KEY.txt`.
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
proxies API requests to the local server on port 8787. Paste an API key from the sidebar,
or add an `OPENAI_API_KEY.txt` file in this directory.

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
- `server/openai.ts` is the only code that reads the API key and calls the Responses API.
- `SYSTEM_PROMPT.md` contains the base instructions loaded fresh for every model request.
- `server/storage.ts` persists one versioned JSON document using atomic replacement.

Threads are stored as a flat map with `parentId` links. That keeps updates cheap while
preserving an ordinary tree: walking parent links produces the exact context path supplied
to the model.

## Notes

- The server binds to `127.0.0.1` by default so the API key is not exposed on the LAN.
- Keys pasted in the UI are written to the gitignored `data/openai-api-key.txt` with
  owner-only permissions and take precedence over `OPENAI_API_KEY.txt`.
- The default model is `gpt-5.6-sol` with `max` reasoning effort. Model and reasoning
  effort stay together in each chat composer.
- Custom instructions are stored locally with the workspace and appended to, rather than
  substituted for, `SYSTEM_PROMPT.md`.
- Set `PORT` or `HOST` when starting the server if you need different local bindings.
