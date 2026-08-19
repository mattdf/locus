alter table "locus_usage_events"
  add column "purpose" text not null default 'chat';

create index "locus_usage_events_owner_purpose_month_idx"
  on "locus_usage_events" ("ownerUserId", "purpose", "createdAt" desc);

create table "locus_pdf_repair_policies" (
  "ownerUserId" text primary key references "user" ("id") on delete cascade,
  "managedEnabled" boolean not null default true,
  "monthlyLimitUsd" numeric(18, 8),
  "updatedByUserId" text references "user" ("id") on delete set null,
  "updatedAt" timestamptz not null default current_timestamp,
  check ("monthlyLimitUsd" is null or "monthlyLimitUsd" >= 0)
);
