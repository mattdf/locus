alter table "locus_provider_credentials"
  drop constraint if exists "locus_provider_credentials_provider_check";
alter table "locus_provider_credentials"
  add constraint "locus_provider_credentials_provider_check"
  check ("provider" in ('openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax'));

alter table "locus_managed_credentials"
  drop constraint if exists "locus_managed_credentials_provider_check";
alter table "locus_managed_credentials"
  add constraint "locus_managed_credentials_provider_check"
  check ("provider" in ('openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax'));

alter table "locus_user_managed_credentials"
  drop constraint if exists "locus_user_managed_credentials_provider_check";
alter table "locus_user_managed_credentials"
  add constraint "locus_user_managed_credentials_provider_check"
  check ("provider" in ('openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax'));

create table "locus_custom_providers" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "id" text not null,
  "label" text not null,
  "baseUrl" text not null,
  "ciphertext" bytea,
  "nonce" bytea,
  "authTag" bytea,
  "keyVersion" integer,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  primary key ("ownerUserId", "id"),
  check (length("label") between 1 and 120),
  check (length("baseUrl") between 1 and 2000),
  check (("ciphertext" is null and "nonce" is null and "authTag" is null and "keyVersion" is null)
      or ("ciphertext" is not null and "nonce" is not null and "authTag" is not null and "keyVersion" is not null))
);

create index "locus_custom_providers_owner_created_idx"
  on "locus_custom_providers" ("ownerUserId", "createdAt");
