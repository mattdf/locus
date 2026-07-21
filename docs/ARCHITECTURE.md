# Architecture

## Client

- `src/App.tsx` owns workspace and recursive-thread state.
- `src/components/MarkdownMessage.tsx` renders Markdown, KaTeX, and code, captures selections using
  original TeX source, and reconnects saved anchors to rendered passages.
- `src/lib/tree.ts` contains tree traversal and context helpers.
- `src/lib/chatTransfer.ts` validates and creates portable chat and category exports.

Threads are stored as a flat map with `parentId` links. Walking parent links reconstructs the
exact ancestor path supplied to the model while keeping individual updates inexpensive.

## Server

- `server/openai.ts` builds prompts and streams either the OpenAI Responses API or an
  OpenAI-compatible Chat Completions request.
- `server/providers.ts` manages provider credentials, base URLs, and model discovery.
- `server/storage.ts` atomically persists the local mode's versioned JSON document.
- `server/workspaces.ts` applies owner-scoped, optimistic PostgreSQL workspace updates in hosted mode.
- `server/credentials.ts` supports file-backed local credentials plus per-user and administrator-
  managed AES-256-GCM credential storage in hosted mode. Decrypted secrets remain inside provider
  request construction and are never serialized to clients.
- `server/access.ts` owns signup policy, waitlist, hashed single-use invites, and managed-credential
  assignment. `server/access-routes.ts` and `server/admin-access-routes.ts` expose the public and
  administrator portions of that policy.
- `server/metapost.ts` and `server/tikz.ts` validate engine-specific figure bodies and dispatch
  them to an isolated compiler.

`LOCUS_MODE=local` and `LOCUS_MODE=hosted` are explicit modes. Hosted mode does not fall back to
the local workspace or project key files. The broader multi-user design is recorded in
[`../MULTI_USER_PLAN_do_not_commit.md`](../MULTI_USER_PLAN_do_not_commit.md).

## Visualization sandbox

MetaPost and TikZ jobs run as a non-root user with no network, no Linux capabilities, a read-only
root filesystem, bounded CPU, memory, process and output limits, and only a disposable job
directory mounted writable. TeX file access is paranoid and shell escape is disabled.

MetaPost `btex ... etex` labels pass through a bounded LaTeX command allowlist. TikZ bodies reject
file and process access, preambles, macro obfuscation, and unsafe environments before a compiler
container starts. Local compilation uses a fresh Docker container; hosted compilation uses the
network-internal service defined by `compose.hosted.yaml`.
