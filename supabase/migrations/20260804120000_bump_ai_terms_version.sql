-- Bump the AI terms version to 2026-08-04, matching AI_TERMS_VERSION in
-- web/src/content/legal/constants.ts (CP4 round-1 legal review).
--
-- Why: the release aggregate delta rewrites the AI terms materially relative
-- to the identifier 2026-08-02's first meaning (named DeepSeek processing,
-- plaintext forwarding, context levels, HMAC identifier, logging/retention,
-- quota/cancellation, DeepSeek cache/storage disclosures). The hosted AI
-- migration has not been applied yet, so no production acceptance record
-- exists and no real user is forced to re-consent; this bump makes the first
-- production acceptance unambiguously refer to the final document.
--
-- create or replace keeps the function signature (name, args, return type),
-- so the RLS policy "Users can accept current ai terms for themselves" and
-- public.has_accepted_current_ai_terms() keep working without being rebuilt,
-- and existing execute grants are preserved.

create or replace function public.current_ai_terms_version()
returns text
language sql
stable
set search_path = ''
as $$
  select '2026-08-04'::text;
$$;
