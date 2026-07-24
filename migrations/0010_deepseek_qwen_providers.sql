alter table "locus_provider_credentials"
  drop constraint if exists "locus_provider_credentials_provider_check";
alter table "locus_provider_credentials"
  add constraint "locus_provider_credentials_provider_check"
  check (
    "provider" in (
      'openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax',
      'deepseek', 'qwen'
    )
  );

alter table "locus_managed_credentials"
  drop constraint if exists "locus_managed_credentials_provider_check";
alter table "locus_managed_credentials"
  add constraint "locus_managed_credentials_provider_check"
  check (
    "provider" in (
      'openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax',
      'deepseek', 'qwen'
    )
  );

alter table "locus_user_managed_credentials"
  drop constraint if exists "locus_user_managed_credentials_provider_check";
alter table "locus_user_managed_credentials"
  add constraint "locus_user_managed_credentials_provider_check"
  check (
    "provider" in (
      'openai', 'openrouter', 'anthropic', 'kimi', 'glm', 'minimax',
      'deepseek', 'qwen'
    )
  );
