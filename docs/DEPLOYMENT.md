# Hosted deployment

Locus has two explicit modes. `LOCUS_MODE=local` is the default and needs neither a database nor
authentication. `LOCUS_MODE=hosted` is a private multi-user service backed by PostgreSQL.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- A reverse proxy that terminates HTTPS
- A DNS name for `LOCUS_PUBLIC_ORIGIN`
- Node.js 20+ on the deployment workstation when using the included orchestration scripts

Copy `.env.hosted.example` to a secret environment file outside version control and replace every
placeholder. Generate independent random values for the PostgreSQL password and Better Auth
secret. `LOCUS_CREDENTIAL_KEYS` is a comma-separated key ring; each item is a base64url-encoded
32-byte key, newest first.

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
address. The included Coolify/Traefik target does this; do not expose `app:8787` directly while
trusting a client-supplied IP header.

## First account

Public signup is intentionally disabled. After migrations complete, create an account from a
trusted administrative shell:

```bash
LOCUS_ADMIN_PASSWORD='use-a-long-unique-password' \
docker compose --env-file /secure/path/locus.env -f compose.hosted.yaml exec app \
node build/server/admin.mjs create-user --email you@example.com --name 'Your Name' --role admin
```

The repository-specific Coolify workflow automates this once with a random bootstrap token. It
stores the generated login in ignored `secret/INITIAL_ADMIN.txt`, provisions the account over
HTTPS only while the user table is empty, and then clears the bootstrap token in Coolify.

## Coolify and Gandi workflow

Copy `deploy/coolify.example.json` to the ignored `secret/DEPLOYMENT_TARGET.json` and configure
the private repository, Coolify resource identifiers, domain, and DNS target there. API
credentials also remain under the ignored `secret/` directory. The scripts refuse to deploy a
public repository. They are plain Node.js and do not depend on macOS shell utilities:

```bash
npm run deploy:dns         # idempotently configure Gandi A/CNAME records
npm run deploy:coolify     # create/update the Coolify application and queue deployment
npm run deploy:bootstrap   # wait for readiness and provision the first administrator
npm run deploy:production  # all three steps in order
```

`secret/DEPLOYMENT_ENV.txt` is generated once with mode `0600`. Back it up securely: losing
`LOCUS_CREDENTIAL_KEYS` makes saved BYOK credentials unrecoverable, while losing the database
secret prevents PostgreSQL access.

## Security boundaries

- Every hosted data query is scoped by the authenticated Better Auth user ID.
- Hosted mode never reads local JSON or project API-key files.
- Arbitrary OpenAI-compatible endpoint URLs are disabled in hosted mode to prevent server-side
  request forgery. They remain available in local mode.
- Cookies are HTTP-only, secure, and bound to the configured HTTPS origin.
- State-changing application requests require the exact configured origin.
- BYOK credentials use AES-256-GCM with per-record nonces and owner/provider authenticated data.
- The MetaPost service accepts only the server-validated wrapped source over the private Compose
  network and executes compilation without a shell.

Run one `app` replica for now. Streaming jobs are reconnectable across browser refreshes but live
in application memory; horizontal scaling requires sticky routing or a shared job/event backend.
