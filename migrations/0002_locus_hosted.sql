create table "locus_workspace" (
  "ownerUserId" text primary key references "user" ("id") on delete cascade,
  "revision" bigint not null default 0,
  "activeChatId" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table "locus_user_settings" (
  "ownerUserId" text primary key references "user" ("id") on delete cascade,
  "settings" jsonb not null,
  "updatedAt" timestamptz not null default current_timestamp
);

create table "locus_categories" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "id" text not null,
  "name" text not null,
  "position" integer not null,
  "document" jsonb not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  primary key ("ownerUserId", "id")
);

create index "locus_categories_owner_position_idx"
  on "locus_categories" ("ownerUserId", "position");

create table "locus_chats" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "id" text not null,
  "categoryId" text,
  "title" text not null,
  "pinned" boolean not null default false,
  "document" jsonb not null,
  "version" bigint not null default 1,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  primary key ("ownerUserId", "id"),
  foreign key ("ownerUserId", "categoryId")
    references "locus_categories" ("ownerUserId", "id")
    on delete set null ("categoryId")
);

create index "locus_chats_owner_updated_idx"
  on "locus_chats" ("ownerUserId", "updatedAt" desc);
create index "locus_chats_owner_category_idx"
  on "locus_chats" ("ownerUserId", "categoryId");

create table "locus_provider_credentials" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "provider" text not null,
  "ciphertext" bytea not null,
  "nonce" bytea not null,
  "authTag" bytea not null,
  "keyVersion" integer not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  primary key ("ownerUserId", "provider"),
  check ("provider" in ('openai', 'openrouter'))
);

create table "locus_generation_jobs" (
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "id" text not null,
  "provider" text not null,
  "model" text not null,
  "purpose" text not null,
  "status" text not null,
  "partialContent" text not null default '',
  "metrics" jsonb,
  "errorCode" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  "finishedAt" timestamptz,
  "expiresAt" timestamptz not null default (current_timestamp + interval '7 days'),
  primary key ("ownerUserId", "id")
);

create index "locus_generation_jobs_owner_status_idx"
  on "locus_generation_jobs" ("ownerUserId", "status", "createdAt" desc);
create index "locus_generation_jobs_expiry_idx"
  on "locus_generation_jobs" ("expiresAt");

create table "locus_usage_events" (
  "id" bigserial primary key,
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "generationId" text not null,
  "provider" text not null,
  "model" text not null,
  "inputTokens" integer,
  "cachedInputTokens" integer,
  "outputTokens" integer,
  "reasoningTokens" integer,
  "totalTokens" integer,
  "totalCostUsd" numeric(18, 8),
  "createdAt" timestamptz not null default current_timestamp,
  foreign key ("ownerUserId", "generationId")
    references "locus_generation_jobs" ("ownerUserId", "id")
    on delete cascade
);

create index "locus_usage_events_owner_created_idx"
  on "locus_usage_events" ("ownerUserId", "createdAt" desc);
