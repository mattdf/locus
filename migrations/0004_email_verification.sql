-- Accounts created before public signup was enabled were administrator-provisioned
-- and had no verification-email flow. Preserve their access when verification
-- becomes mandatory for new public signups.
update "user" set "emailVerified" = true where "emailVerified" = false;
