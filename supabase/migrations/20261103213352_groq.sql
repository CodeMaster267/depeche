-- Groq joins the providers a family can add a key for. Its free tier serves open models
-- (GPT-OSS, Qwen) at no cost but with tight per-model rate limits.
alter table public.provider_keys drop constraint provider_keys_provider_check;
alter table public.provider_keys
  add constraint provider_keys_provider_check
  check (provider in ('openai', 'anthropic', 'google', 'groq', 'xai', 'deepseek'));
