create table "locus_instance_settings" (
  "id" boolean primary key default true check ("id"),
  "publicSignupEnabled" boolean not null default true,
  "updatedByUserId" text references "user" ("id") on delete set null,
  "updatedAt" timestamptz not null default current_timestamp
);

insert into "locus_instance_settings" ("id", "publicSignupEnabled")
values (true, true)
on conflict ("id") do nothing;

create table "locus_waitlist_entries" (
  "id" text primary key,
  "email" text not null,
  "name" text not null,
  "status" text not null default 'waiting',
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  check ("status" in ('waiting', 'invited', 'registered'))
);

create unique index "locus_waitlist_email_unique_idx"
  on "locus_waitlist_entries" (lower("email"));
create index "locus_waitlist_status_created_idx"
  on "locus_waitlist_entries" ("status", "createdAt");

create table "locus_managed_credentials" (
  "id" text primary key,
  "provider" text not null,
  "label" text not null,
  "ciphertext" bytea not null,
  "nonce" bytea not null,
  "authTag" bytea not null,
  "keyVersion" integer not null,
  "createdByUserId" text references "user" ("id") on delete set null,
  "revokedByUserId" text references "user" ("id") on delete set null,
  "createdAt" timestamptz not null default current_timestamp,
  "revokedAt" timestamptz,
  check ("provider" in ('openai', 'openrouter'))
);

create index "locus_managed_credentials_active_idx"
  on "locus_managed_credentials" ("provider", "createdAt" desc)
  where "revokedAt" is null;

create table "locus_invites" (
  "id" text primary key,
  "tokenHash" bytea not null unique,
  "email" text,
  "managedCredentialId" text references "locus_managed_credentials" ("id") on delete set null,
  "createdByUserId" text references "user" ("id") on delete set null,
  "createdAt" timestamptz not null default current_timestamp,
  "expiresAt" timestamptz,
  "revokedAt" timestamptz,
  "revokedByUserId" text references "user" ("id") on delete set null,
  "usedAt" timestamptz,
  "usedByUserId" text unique references "user" ("id") on delete set null
);

create index "locus_invites_created_idx"
  on "locus_invites" ("createdAt" desc);
create index "locus_invites_email_idx"
  on "locus_invites" (lower("email"))
  where "email" is not null;

create table "locus_user_managed_credentials" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "provider" text not null,
  "managedCredentialId" text not null references "locus_managed_credentials" ("id") on delete cascade,
  "assignedByInviteId" text references "locus_invites" ("id") on delete set null,
  "createdAt" timestamptz not null default current_timestamp,
  primary key ("ownerUserId", "provider"),
  check ("provider" in ('openai', 'openrouter'))
);

create index "locus_user_managed_credentials_key_idx"
  on "locus_user_managed_credentials" ("managedCredentialId");
