# Locus private multi-user hosting plan

Status: first private-account implementation completed in July 2026. This document remains the
architecture and security checklist for hosted mode; later-stage items are called out below.

Implemented in the first hosted release: explicit dual modes, PostgreSQL auth and owner-scoped
workspace storage, invite-only account administration, encrypted per-user BYOK credentials,
owner-scoped reconnectable generation jobs, optimistic workspace revisions, migrations,
containerized MetaPost compilation without a Docker socket, HTTPS deployment configuration,
health checks, and one-time initial administrator provisioning.

Still planned: email-based password recovery, optional quotas, PostgreSQL row-level-security as
defense in depth, normalized resource endpoints in place of the current delta sync endpoint,
and multi-instance generation coordination. The current hosted deployment intentionally runs a
single application replica because live generation streams are process-resident.

## Goal

Add an optional hosted mode in which multiple people can create private accounts and use
Locus without seeing, changing, streaming, stopping, exporting, or otherwise discovering
another account's data.

The existing local experience must remain the default: no database, login, or external
service should be required for `npm run dev`, `npm start`, or ordinary local use.

## Scope

The first hosted release includes:

- Invite-only private accounts with login, logout, session revocation, and account recovery.
- Strict per-user isolation for chats, branches, categories, settings, credentials,
  generations, usage, imports, and exports.
- PostgreSQL persistence, optimistic concurrency, migrations, backups, and account deletion.
- Per-user provider credentials, with an optional administrator-funded provider key.
- Reconnectable and explicitly abortable generation jobs owned by the requesting user.
- Per-user concurrency limits, request limits, usage records, and optional spending quotas.
- A production deployment path with HTTPS, secure cookies, health checks, and secret
  management.

The first release does not include shared chats, public links, organizations, team billing,
simultaneous collaborative editing, comments, or role-based access within a chat. Those
features require a separate authorization model and should not be smuggled into the private
account work.

## Current assumptions that must change

The present server is intentionally single-user:

- `/api/state` reads and replaces one global `data/chats.json` document.
- Provider credentials are global files and their management routes have no account owner.
- Generation IDs live in a process-wide map and stream/abort routes have no ownership check.
- Most changes cause the browser to save the complete workspace after a short debounce.
- A user-configurable local endpoint causes the server to make requests to an arbitrary URL.

None of those routes may be exposed directly to untrusted network clients.

## Deployment modes

Introduce one explicit mode switch:

```text
LOCUS_MODE=local   # default
LOCUS_MODE=hosted
```

### Local mode

- Uses the existing atomic JSON-file storage and provider key files.
- Requires no account or database.
- Binds to `127.0.0.1` by default.
- Allows local OpenAI-compatible endpoints.
- Preserves current behavior and data compatibility.

### Hosted mode

- Refuses to start without database, session, encryption, and public-origin configuration.
- Requires authentication for every non-health API route.
- Uses PostgreSQL and never reads or writes the local workspace/key files.
- Uses secure, HTTP-only, same-site cookies and an explicit trusted origin.
- Disables arbitrary local/private-network model endpoints.
- May bind to `0.0.0.0` behind an HTTPS reverse proxy.

Hosted behavior must fail closed. Missing configuration must produce a startup error, not a
fallback to the global local workspace.

## Architecture boundaries

Extract infrastructure behind small interfaces before adding authentication:

```ts
interface WorkspaceRepository {
  load(userId: string): Promise<WorkspaceSnapshot>;
  saveSettings(userId: string, settings: WorkspaceSettings, version: number): Promise<number>;
  saveCategories(userId: string, categories: ChatCategory[], version: number): Promise<number>;
  saveChat(userId: string, chat: ChatTree, version: number): Promise<number>;
  deleteChat(userId: string, chatId: string, version: number): Promise<void>;
}

interface CredentialStore {
  status(userId: string, provider: ProviderId): Promise<CredentialStatus>;
  set(userId: string, provider: ProviderId, secret: string): Promise<void>;
  clear(userId: string, provider: ProviderId): Promise<void>;
  resolve(userId: string, provider: ProviderId): Promise<string | null>;
}

interface GenerationRepository {
  create(userId: string, input: GenerationInput): Promise<GenerationJob>;
  get(userId: string, requestId: string): Promise<GenerationJob | null>;
  update(userId: string, job: GenerationJob): Promise<void>;
}
```

Use file-backed implementations in local mode and database-backed implementations in hosted
mode. Route handlers must receive an authenticated request context and must never accept a
`userId` from request JSON or query parameters.

## Database design

Keep the recursive chat tree as JSONB initially. It already has a stable portable structure,
and private accounts do not require normalizing every message. Split the current monolithic
workspace into independently versioned resources so streaming or editing one chat does not
rewrite every chat owned by the account.

Suggested tables:

```text
users
  id uuid primary key
  email unique
  display_name
  status             # invited, active, disabled
  created_at
  updated_at

auth_*               # sessions, authenticators/accounts, verification/reset tokens

user_settings
  user_id primary key references users
  settings jsonb
  version bigint
  updated_at

categories
  id uuid primary key
  owner_user_id references users
  name
  position integer
  created_at
  updated_at

chats
  id uuid primary key
  owner_user_id references users
  category_id nullable
  title
  pinned boolean
  tree jsonb
  version bigint
  created_at
  updated_at

provider_credentials
  user_id references users
  provider
  ciphertext
  nonce
  key_version
  created_at
  updated_at
  primary key (user_id, provider)

generation_jobs
  id uuid primary key
  owner_user_id references users
  provider
  model
  status
  partial_content text
  metrics jsonb
  error_code nullable
  created_at
  updated_at
  finished_at nullable
  expires_at

usage_events
  id uuid primary key
  owner_user_id references users
  generation_id references generation_jobs
  provider
  model
  input_tokens
  output_tokens
  reasoning_tokens
  total_cost_usd nullable
  created_at
```

Enforce category ownership when moving a chat. Prefer a composite ownership constraint where
practical; otherwise validate it in a transaction. Every query must include the authenticated
owner ID even when IDs are UUIDs. PostgreSQL row-level security can be added as defense in
depth, but it does not replace application-level ownership checks and tests.

Use normal migration files checked into the repository. Production startup should verify that
the schema is current but should not silently apply destructive migrations.

## Authentication and accounts

Use a maintained authentication library rather than implementing password/session crypto in
Locus. Select the concrete library at implementation time after checking its current security
and maintenance status. Required behavior:

- Invite-only registration for the first release.
- Unique, normalized email addresses.
- Strong password hashing if passwords are used; alternatively use a configured OIDC or
  passwordless provider.
- Server-side revocable sessions stored in PostgreSQL.
- Rotated session IDs after login and privilege changes.
- Secure, HTTP-only, same-site cookies with a narrow path/domain.
- CSRF protection for state-changing cookie-authenticated requests.
- Expiring, single-use invite, verification, and recovery tokens stored as hashes.
- Login throttling and generic error messages that do not enumerate accounts.
- Account disablement that immediately invalidates sessions and blocks generations.

Start with an administrator CLI for inviting/disabling users rather than building a large admin
UI. Add a small account menu to the web UI for identity, logout, session management, data
export, and account deletion.

## Authorization rules

Centralize authorization instead of scattering ad hoc comparisons across handlers.

Required invariants:

- A workspace response contains only the authenticated user's resources.
- Chat/category IDs owned by another user behave as not found.
- Generation create, reconnect, stream, abort, and status operations require job ownership.
- Provider status/set/clear/model operations use only that user's credentials and policy.
- Imports always create resources owned by the current user with new IDs.
- Exports include only resources owned by the current user.
- Account deletion cannot name or affect another user.
- Admin capabilities are separate from ordinary account data access; an administrator should
  not automatically receive a chat-reading endpoint.

Client-generated UUIDs are identifiers, not authorization secrets.

## Persistence and concurrency

Replace the whole-workspace `PUT /api/state` behavior in hosted mode with resource-oriented,
versioned writes. A possible API shape is:

```text
GET    /api/workspace
PUT    /api/settings                 If-Match: <version>
PUT    /api/categories               If-Match: <version>
PUT    /api/chats/:chatId             If-Match: <version>
DELETE /api/chats/:chatId             If-Match: <version>
```

Return a new version/ETag after every successful mutation. Return `409 Conflict` or
`412 Precondition Failed` for stale writes. The UI must not silently replace newer server data.
It should offer reload/retry and preserve the unsaved local edit for copying or reconciliation.

Batch streamed assistant deltas in memory and checkpoint them at a controlled interval rather
than writing on every token. Always persist the final content and generation metrics. Use a
browser `BroadcastChannel` to reduce conflicts between tabs belonging to the same account, but
keep server-side version checks as the source of truth.

## Provider credentials and spending

Support two explicit hosted credential policies:

1. **Per-user/BYOK:** encrypt each provider key with authenticated encryption using a master
   key supplied by the deployment secret manager. Store ciphertext, nonce, and key version;
   never return plaintext to the browser or logs.
2. **Administrator-funded:** read a provider key only from the process secret environment.
   Hide key editing from users and enforce per-user limits before starting requests.

Allow a deployment to enable one or both policies and define which takes precedence. Credential
status endpoints return only configured/source metadata. Key rotation must support decrypting an
old key version while re-encrypting with the current one.

Record provider, model, token counts, estimated/reported cost, and owner for every generation.
Add per-user limits for concurrent jobs, requests per minute, daily/monthly tokens, and optional
cost budget. Limit checks must be server-side and transactional enough to prevent easy parallel
request bypasses.

## OpenAI-compatible endpoints and SSRF

Do not expose the current arbitrary local base-URL field in hosted mode. `localhost` on a hosted
server refers to the server itself, and accepting arbitrary destinations would permit probing
internal services.

The first hosted release should either:

- disable the local provider completely; or
- allow only administrator-defined endpoint profiles whose hosts are configured at deployment.

If user-defined remote compatible endpoints are added later, implement URL allowlisting,
protocol restrictions, DNS resolution checks, private/link-local/loopback address blocking,
redirect validation, response-size/time limits, and DNS-rebinding defenses before enabling it.
A user-side tunnel/agent is a separate feature.

## Generation lifecycle

Associate every generation with its authenticated owner before starting the upstream request.
Persist enough job state to reconnect after a page refresh and to audit usage.

For the first hosted deployment, one application instance may continue running upstream jobs in
memory, provided that:

- ownership is checked on every generation route;
- partial content is checkpointed;
- an application restart marks orphaned running jobs as interrupted;
- completed/failed/stopped jobs have a retention policy; and
- the deployment documents that an upstream request cannot resume after a process restart.

Before running multiple application instances, move job coordination and event distribution to
a shared queue/pub-sub system, or otherwise guarantee that reconnect/abort reaches the owning
worker. Do not rely on load-balancer stickiness as the permanent design.

## Security baseline

Before internet exposure:

- Set a strict trusted origin and reject unexpected `Host`, `Origin`, and forwarded-host data.
- Terminate TLS and set secure cookie, HSTS, content-security, frame, MIME, and referrer headers.
- Add CSRF defenses and rate limits to authentication and state-changing routes.
- Retain the existing body/context limits and add per-route limits where smaller values suffice.
- Redact credentials, cookies, prompts, chat content, and raw provider responses from logs.
- Use parameterized database queries and a restricted database role.
- Keep database, session, and encryption secrets out of the repository and image.
- Disable directory listing, source maps in production unless access-controlled, and verbose
  error responses.
- Define retention for sessions, generation jobs, usage records, reset tokens, and audit events.
- Back up PostgreSQL, encrypt backups, test restoration, and document deletion propagation.
- Add dependency/security scanning and a repeatable patch process.
- Review account export and deletion for privacy compliance appropriate to the deployment.

## Client changes

- Add signed-out, sign-in, recovery, invitation, and disabled-account states.
- Add an account menu with logout, session management, export-all, and delete-account actions.
- Hydrate the workspace only after session resolution.
- Stop rendering cached data immediately on `401` and return to the sign-in screen.
- Split persistence into settings, categories, and per-chat saves with versions.
- Display conflict/retry/offline states separately from the existing saved indicator.
- Keep URL chat/thread navigation, but treat inaccessible IDs as not found without revealing
  whether another user owns them.
- Make credential UI reflect hosted policy: BYOK editing, administrator-funded status, or both.
- Hide arbitrary local-endpoint controls in hosted mode.

Avoid placing sensitive workspace data in `localStorage`. In-memory state is the default; any
future offline cache must be explicitly designed, scoped by account, encrypted where warranted,
and cleared on logout.

## Migration from an existing local workspace

Provide an explicit one-time command, not an automatic startup import:

```text
npm run migrate:hosted -- --owner user@example.com --source data/chats.json
```

The migration should:

1. Require an existing hosted user and an empty destination unless `--merge` is supplied.
2. Validate and normalize the workspace using the same import logic as the application.
3. Preserve chat/category/tree IDs when there is no collision.
4. Run in a database transaction and produce a dry-run report.
5. Back up the source file and never delete it.
6. Exclude plaintext credential files; users must re-enter keys or the administrator must
   configure a shared key separately.
7. Produce counts and checksums so the imported result can be verified.

Existing JSON chat exports remain a supported user-controlled migration path.

## Deployment deliverables

- Multi-stage production container image running as a non-root user.
- PostgreSQL migration and administrator CLI commands.
- Example environment file containing names only, never secrets.
- Readiness check that verifies database connectivity and schema version.
- Liveness check that does not expose private configuration.
- Graceful shutdown that stops accepting new generations and checkpoints current jobs.
- Reverse-proxy example with HTTPS and correct forwarded-header trust.
- Backup/restore and key-rotation runbooks.
- Structured logs with request IDs and user IDs, but no chat or credential content.
- Documented single-instance limitation until shared job coordination is implemented.

## Implementation phases

### Phase 0: characterize and protect local behavior

- Add tests for workspace normalization, JSON persistence, generation reconnect/abort, provider
  credentials, imports/exports, and recursive trees.
- Record representative local workspace fixtures, including large LaTeX chats and revisions.
- Add `LOCUS_MODE=local` without changing default behavior.

Exit criterion: existing local tests and browser flows pass unchanged.

### Phase 1: extract storage and credential boundaries

- Introduce repository interfaces and move file logic behind local implementations.
- Remove direct storage/key-file dependencies from route handlers.
- Add a request-scoped application service layer that accepts an owner identity.

Exit criterion: local mode still operates entirely on files through the new interfaces.

### Phase 2: PostgreSQL and resource persistence

- Choose the database/query migration tooling and check in the schema.
- Implement database repositories, resource versions, transactions, and cleanup jobs.
- Change hosted persistence from whole-workspace saves to per-resource saves.
- Add conflict handling and multi-tab coordination in the client.

Exit criterion: two synthetic owners can independently create/edit identical IDs without any
cross-account result, and stale writes cannot silently overwrite newer data.

### Phase 3: authentication and route authorization

- Integrate the selected authentication library and database session store.
- Add invite, login, logout, recovery, session revocation, and account-disable flows.
- Require authentication and ownership checks on all hosted API routes.
- Add the account UI and administrator CLI.

Exit criterion: an automated two-user IDOR test suite cannot read, mutate, export, stream, or
abort the other user's resources.

### Phase 4: hosted provider policy and encrypted credentials

- Add BYOK encryption/key versioning and optional administrator-funded credentials.
- Scope provider status, key management, model access, and generations to the account.
- Disable arbitrary local endpoints and enforce endpoint policy server-side.
- Add quotas, concurrency limits, and usage events.

Exit criterion: plaintext keys never appear in responses/database/logs, and quota tests cover
parallel requests and failure paths.

### Phase 5: durable generation ownership

- Persist generation metadata, partial content checkpoints, terminal metrics, and retention.
- Protect create/reconnect/stream/abort/status routes by owner.
- Reconcile interrupted jobs at startup and implement graceful shutdown.
- Add shared job coordination before enabling multiple application instances.

Exit criterion: refresh reconnect works, abort affects only the caller's job, and restart
behavior is deterministic and visible to the user.

### Phase 6: migration, account lifecycle, and operations

- Implement dry-run local-workspace migration.
- Add account export and deletion with credential/session cleanup.
- Add container, health checks, backups, restore test, rotation runbook, and deployment docs.

Exit criterion: a local workspace migrates with matching counts/checksums, and a deleted account
cannot authenticate or leave active credentials/generations behind.

### Phase 7: security review and staged launch

- Run unit, integration, browser, concurrency, authorization, and abuse tests.
- Perform a focused review of session handling, IDOR, CSRF, SSRF, credential encryption,
  logging, quotas, and account deletion.
- Launch first to a private staging deployment with test accounts, then an invite-only
  production deployment.

Exit criterion: every release criterion below is demonstrated in staging and the backup restore
has been exercised.

## Test strategy

At minimum, automate:

- Repository contract tests shared by file and database implementations.
- Two-user isolation tests for every resource and generation endpoint.
- Authentication/session/CSRF tests, including disabled and expired accounts.
- Optimistic-concurrency and simultaneous-tab tests.
- Credential encrypt/decrypt/rotate/redaction tests.
- SSRF tests covering loopback, private, link-local, IPv6, redirects, and DNS changes if remote
  endpoint configuration is ever permitted.
- Rate-limit, concurrent-generation, and budget-boundary tests.
- Migration dry-run, rollback, collision, malformed-input, and checksum tests.
- Browser tests for sign-in, logout, private workspace hydration, refresh/reconnect, abort,
  import/export, account deletion, and inaccessible bookmarked URLs.
- Regression tests for the complete local mode.

Tests should create two users by default; a single-user passing test does not prove tenant
isolation.

## Release criteria

Hosted mode is ready only when:

- No hosted data or credential route is reachable without an authenticated session.
- Cross-user IDs return not found and cannot affect another account in automated tests.
- Every state-changing resource write is versioned or otherwise concurrency-safe.
- Generation stream/reconnect/abort ownership is enforced server-side.
- Provider keys are deployment secrets or encrypted per-user records and never returned.
- Arbitrary server-side endpoint URLs are disabled or pass the documented SSRF controls.
- Per-user rate, concurrency, and configured budget limits are enforced.
- Account export, disablement, session revocation, and deletion work end to end.
- PostgreSQL backup restore and credential-master-key rotation have been tested.
- The production deployment uses HTTPS and passes the security-header/cookie review.
- Local mode remains zero-auth, file-backed, and compatible with existing workspaces.
- Operational limitations, retention periods, and incident/recovery procedures are documented.

## Decisions to lock before implementation

1. Authentication mechanism: password, passwordless email, OIDC, or a supported combination.
2. Invitation and recovery email delivery provider.
3. Database/query/migration library.
4. BYOK only, administrator-funded only, or both.
5. Initial quotas and whether users can configure personal budget warnings.
6. Single-instance first release or shared job coordination from day one.
7. Retention periods for generation jobs, usage events, audit events, and deleted-account backups.
8. Hosting target and secret/backup management facilities.

These choices should change adapters and deployment configuration, not the chat-tree domain
model or local-mode behavior.
