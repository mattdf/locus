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
  provider-native or OpenAI-compatible streaming request. Feature routes independently select a
  provider connection and model.
- `server/providers.ts` manages provider credentials, base URLs, and model discovery.
- `server/storage.ts` atomically persists the local mode's versioned JSON document.
- `server/workspaces.ts` applies owner-scoped, optimistic PostgreSQL workspace updates in hosted mode.
- `server/credentials.ts` supports file-backed local credentials plus per-user and administrator-
  managed AES-256-GCM credential storage in hosted mode. Decrypted secrets remain inside provider
  request construction and are never serialized to clients.
- `server/access.ts` owns signup policy, waitlist, hashed single-use invites, and managed-credential
  assignment. `server/access-routes.ts` and `server/admin-access-routes.ts` expose the public and
  administrator portions of that policy.
- `server/metapost.ts` and `server/tikz.ts` bound request and artifact sizes and dispatch figure
  bodies to an isolated compiler.
- `server/pdf-imports.ts` authenticates PDF operations, streams uploads to the private OCR worker,
  rewrites extracted-image URLs to same-origin protected routes, and proxies source/image reads
  without exposing worker or Mistral credentials.

## PDF import worker

`docker/pdf2markdown` is an independent persistent API service. Its bounded thread pool processes
multiple Mistral OCR jobs concurrently while a SQLite WAL database records jobs, documents,
reservations, page/call usage, and per-user/per-key caps. Original PDFs, converted Markdown, and
extracted images live under tenant-hashed directories in a durable volume.

The browser stores only stable source metadata in the chat tree. It can therefore resume polling
an accepted job after refresh, replace the placeholder with completed Markdown, and access
document assets through authenticated Locus routes. In hosted mode the worker is reachable only
from the application network.

`LOCUS_MODE=local` and `LOCUS_MODE=hosted` are explicit modes. Hosted mode does not fall back to
the local workspace or project key files. The broader multi-user design is recorded in
[`../MULTI_USER_PLAN_do_not_commit.md`](../MULTI_USER_PLAN_do_not_commit.md).

## Visualization sandbox

MetaPost and TikZ jobs run as a non-root user with no external network access, no Linux
capabilities, a read-only root filesystem, bounded CPU, memory, process and output limits, and
only a disposable job directory mounted writable. TeX file access is paranoid and shell escape
is disabled.

There is deliberately no MetaPost, TeX-command, or TikZ-environment allowlist. The actual compiler
decides whether source is valid. Local compilation uses a fresh Docker container; hosted
compilation uses the network-internal service defined by `compose.hosted.yaml`. Both impose hard
in-container and caller-side wall-clock deadlines in addition to the resource limits above.
