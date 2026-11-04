-- Groq was for testing only and is taken out of Depeche (Hasan, 4 Nov 2026). Any Groq key a family
-- added is deleted, and no new one can be saved. Past spending on Groq stays in usage_events, and
-- old replies keep the Groq model's name in their own rows.
delete from public.provider_keys where provider = 'groq';
alter table public.provider_keys drop constraint provider_keys_provider_check;
alter table public.provider_keys
  add constraint provider_keys_provider_check
  check (provider in ('openai', 'anthropic', 'google', 'xai', 'deepseek'));
