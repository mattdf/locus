create table "locus_shared_chats" (
  "id" text primary key,
  "ownerUserId" text not null references "user" ("id") on delete cascade,
  "sourceChatId" text,
  "token" text not null unique,
  "title" text not null,
  "snapshot" jsonb not null,
  "createdAt" timestamptz not null default current_timestamp,
  foreign key ("ownerUserId", "sourceChatId")
    references "locus_chats" ("ownerUserId", "id")
    on delete set null ("sourceChatId")
);

create index "locus_shared_chats_owner_created_idx"
  on "locus_shared_chats" ("ownerUserId", "createdAt" desc);

