# Hosted operations

## Account administration

Run commands in the application container with the hosted environment loaded:

```bash
node build/server/admin.mjs list-users

LOCUS_ADMIN_PASSWORD='a-new-long-password' node build/server/admin.mjs \
  create-user --email person@example.com --name 'Person Name'

node build/server/admin.mjs disable-user --email person@example.com
```

Suspending an account revokes its sessions, stops its in-flight model generations, and blocks all
subsequent protected requests immediately. The admin role does not grant a route for reading
another user's workspace or provider credentials.

The in-app administration view also controls public signup versus waitlist mode, waitlist entries,
single-use invite links, and administrator-managed provider keys. Managed key plaintext is accepted
only when the key is created. Later API responses expose only its label, provider, status, and usage
counts. Revoking a managed key immediately removes provider access from every account relying on it.

The PDF OCR section reports monthly Mistral pages and calls by account and embedded key.
Administrators can set or clear monthly page caps independently for each user and key. Cap checks
reserve pages before an OCR job starts, so concurrent jobs cannot overspend the configured
allowance.

## Backups

Back up PostgreSQL, the credential key ring, and the `locus_pdf2markdown_data` volume together. A
database dump without the matching `LOCUS_CREDENTIAL_KEYS` can restore chats but cannot decrypt
saved provider keys. A database dump without the PDF volume retains chat Markdown but loses original
source PDFs and extracted image files.

```bash
docker compose --env-file /secure/path/locus.env -f compose.hosted.yaml exec -T postgres \
  pg_dump --format=custom --no-owner --username=locus locus > locus-$(date +%F).dump
```

Test restores regularly in an isolated stack. Stop the application before a destructive restore,
restore into an empty `locus` database, run `node build/server/migrate-cli.mjs`, and verify `/api/ready`
before reopening traffic.

## Credential-key rotation

1. Generate a new base64url 32-byte key.
2. Prepend it to `LOCUS_CREDENTIAL_KEYS`; keep every existing key in its old relative position.
3. Redeploy and verify existing saved credentials still resolve.
4. Re-saving a user or managed provider credential encrypts it with key version `0`.

Do not remove an old key until every row using its version has been re-encrypted and verified.
The database stores only a key-version number, not a copy of a key.

## Updates and migrations

The `migrate` service serializes migration execution with a PostgreSQL advisory lock and records
a SHA-256 checksum for every applied file. Never edit an applied migration; add a new numbered SQL
file. The application refuses to start when checked-in migrations are not current.

Before an update:

1. Take and verify a database backup.
2. Keep the current credential key ring available.
3. Build and test `compose.hosted.yaml` in an isolated project.
4. Deploy. The app starts only after migrations complete and MetaPost is healthy.

## Monitoring and retention

- `/api/health` reports process liveness.
- `/api/ready` verifies the database schema and MetaPost compiler.
- `/api/pdf-imports/status` reports whether the authenticated app can reach the PDF worker.
- `locus_generation_jobs` checkpoints partial output and marks interrupted jobs on restart.
- `locus_usage_events` records provider/model/token/cost metrics per owner.
- PDF OCR job state and page/call usage live in the durable PDF-worker volume; the administrator
  interface reads the same accounting store through a server-only credential.

Generation rows have an `expiresAt` value but automated deletion is not yet scheduled. Add a
database maintenance job appropriate to the retention policy before operating at substantial
scale.
