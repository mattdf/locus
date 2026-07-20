create table "locus_onboarding_emails" (
  "ownerUserId" text primary key references "user" ("id") on delete cascade,
  "status" text not null check ("status" in ('pending', 'sending', 'sent', 'failed')),
  "postmarkMessageId" text,
  "lastError" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  "sentAt" timestamptz
);

create index "locus_onboarding_emails_status_idx" on "locus_onboarding_emails" ("status");
