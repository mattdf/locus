# Hosted deployment

Locus has two explicit modes. `LOCUS_MODE=local` is the default and needs neither a database nor
authentication. `LOCUS_MODE=hosted` is a private multi-user service backed by PostgreSQL.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- A reverse proxy that terminates HTTPS
- A DNS name for `LOCUS_PUBLIC_ORIGIN`

Copy `.env.hosted.example` to a secret environment file outside version control and replace every
placeholder. Generate independent random values for the PostgreSQL password and Better Auth
secret. `LOCUS_CREDENTIAL_KEYS` is a comma-separated key ring; each item is a base64url-encoded
32-byte key, newest first. `POSTMARK_SERVER_TOKEN` must be the Server API token, not the
account-management token.

```bash
docker compose --env-file /secure/path/locus.env -f compose.hosted.yaml up -d --build
```

The stack contains four roles:

- `postgres`: persistent account, workspace, generation, and credential data
- `migrate`: a one-shot, checksummed migration runner
- `metapost`: a network-internal, non-root compiler with a read-only root filesystem and bounded resources
- `app`: the web/API container; only this service should be routed from the public proxy

Do not publish the PostgreSQL or MetaPost ports. Do not mount the Docker socket into any service.
The reverse proxy should route the configured HTTPS host to `app:8787`, preserve
`X-Forwarded-Proto` and `X-Forwarded-Host`, and overwrite `X-Real-IP` with the connecting client
address. Do not expose `app:8787` directly while trusting a client-supplied IP header.

## Accounts

Hosted mode starts with public email/password signup enabled. Administrators can switch the site
to waitlist mode, issue single-use invite links, assign server-managed model credentials to an
invite, revoke those credentials, and suspend accounts from the administration interface. New
public accounts must follow the Postmark verification link before signing in. A valid single-use
invite acts as verification, so invited accounts can sign in immediately without an email round
trip. Administrator-created accounts are also marked verified immediately. To create an
administrator from the command line, use:

```bash
LOCUS_ADMIN_PASSWORD='use-a-long-unique-password' \
docker compose --env-file /secure/path/locus.env -f compose.hosted.yaml exec app \
node build/server/admin.mjs create-user --email you@example.com --name 'Your Name' --role admin
```

## Security boundaries

- Every hosted data query is scoped by the authenticated Better Auth user ID.
- Hosted mode never reads local JSON or project API-key files.
- Arbitrary OpenAI-compatible endpoint URLs are disabled in hosted mode to prevent server-side
  request forgery. They remain available in local mode.
- Cookies are HTTP-only, secure, and bound to the configured HTTPS origin.
- State-changing application requests require the exact configured origin.
- BYOK credentials use AES-256-GCM with per-record nonces and owner/provider authenticated data.
- Administrator-managed provider keys use the same authenticated encryption, are referenced by
  invited accounts, and are never returned by an application endpoint. Revocation takes effect on
  the next provider request for every assigned account.
- Invite capability tokens are returned only when created and stored as SHA-256 hashes. Each link
  can create at most one account.
- Suspension deletes every session, stops in-flight model generations, and is checked again on
  every protected request.
- The MetaPost service accepts only the server-validated wrapped source over the private Compose
  network and executes compilation without a shell.

MetaPost and TikZ jobs run as a non-root user with no network, no Linux capabilities, a read-only
root filesystem, bounded CPU, memory, process and output limits, and only a disposable job
directory mounted writable. TeX file access is paranoid and shell escape is disabled. MetaPost
labels pass through a bounded LaTeX command allowlist; TikZ bodies reject file and process access,
preambles, macro obfuscation, and unsafe environments before compilation. Set
`METAPOST_MAX_CONCURRENCY` from 1 through 16 to match the host's capacity; the default is 2.

Run one `app` replica for now. Streaming jobs are reconnectable across browser refreshes but live
in application memory; horizontal scaling requires sticky routing or a shared job/event backend.
