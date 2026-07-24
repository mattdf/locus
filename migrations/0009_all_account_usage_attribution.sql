alter table "locus_provider_credentials"
  add column "credentialId" text;

update "locus_provider_credentials"
   set "credentialId" = md5(
     "ownerUserId" || ':' || "provider" || ':' || "createdAt"::text || ':' || random()::text
   )
 where "credentialId" is null;

alter table "locus_provider_credentials"
  alter column "credentialId" set not null;

create unique index "locus_provider_credentials_owner_credential_idx"
  on "locus_provider_credentials" ("ownerUserId", "credentialId");

alter table "locus_custom_providers"
  add column "credentialId" text;

update "locus_custom_providers"
   set "credentialId" = md5(
     "ownerUserId" || ':' || "id" || ':' || "createdAt"::text || ':' || random()::text
   )
 where "ciphertext" is not null and "credentialId" is null;

alter table "locus_generation_jobs"
  add column "credentialKind" text,
  add column "credentialRef" text,
  add column "credentialLabel" text;

alter table "locus_usage_events"
  add column "credentialKind" text,
  add column "credentialRef" text,
  add column "credentialLabel" text;

update "locus_usage_events"
   set "credentialKind" = case
         when "managedCredentialId" is not null then 'managed'
         else 'historical-provider'
       end,
       "credentialRef" = case
         when "managedCredentialId" is not null then 'managed:' || "managedCredentialId"
         else 'historical:' || "provider"
       end,
       "credentialLabel" = case
         when "managedCredentialId" is not null then
           coalesce(
             (select c."label" from "locus_managed_credentials" c
               where c."id" = "locus_usage_events"."managedCredentialId"),
             initcap("provider") || ' managed key'
           )
         else initcap("provider") || ' historical usage'
       end
 where "credentialKind" is null;

alter table "locus_usage_events"
  alter column "credentialKind" set not null,
  alter column "credentialRef" set not null,
  alter column "credentialLabel" set not null;

create index "locus_usage_events_owner_month_credential_idx"
  on "locus_usage_events" ("ownerUserId", "createdAt" desc, "credentialRef");
