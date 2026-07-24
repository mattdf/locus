alter table "locus_managed_credentials"
  add column "monthlyLimitUsd" numeric(18, 8);

alter table "locus_managed_credentials"
  add constraint "locus_managed_credentials_monthly_limit_check"
  check ("monthlyLimitUsd" is null or "monthlyLimitUsd" >= 0);

alter table "locus_invites"
  add column "accountMonthlyLimitUsd" numeric(18, 8);

alter table "locus_invites"
  add constraint "locus_invites_account_monthly_limit_check"
  check ("accountMonthlyLimitUsd" is null or "accountMonthlyLimitUsd" >= 0);

create table "locus_managed_account_limits" (
  "ownerUserId" text primary key references "user" ("id") on delete cascade,
  "monthlyLimitUsd" numeric(18, 8),
  "updatedByUserId" text references "user" ("id") on delete set null,
  "updatedAt" timestamptz not null default current_timestamp,
  check ("monthlyLimitUsd" is null or "monthlyLimitUsd" >= 0)
);

alter table "locus_generation_jobs"
  add column "managedCredentialId" text
    references "locus_managed_credentials" ("id") on delete set null;

alter table "locus_usage_events"
  add column "managedCredentialId" text
    references "locus_managed_credentials" ("id") on delete set null;

create index "locus_usage_events_managed_key_created_idx"
  on "locus_usage_events" ("managedCredentialId", "createdAt" desc)
  where "managedCredentialId" is not null;

create index "locus_usage_events_managed_owner_created_idx"
  on "locus_usage_events" ("ownerUserId", "createdAt" desc)
  where "managedCredentialId" is not null;

create table "locus_managed_usage_reservations" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "generationId" text not null,
  "managedCredentialId" text not null
    references "locus_managed_credentials" ("id") on delete cascade,
  "createdAt" timestamptz not null default current_timestamp,
  "expiresAt" timestamptz not null default (current_timestamp + interval '24 hours'),
  primary key ("ownerUserId", "generationId")
);

create index "locus_managed_usage_reservations_key_idx"
  on "locus_managed_usage_reservations" ("managedCredentialId", "expiresAt");
