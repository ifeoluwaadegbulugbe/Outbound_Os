-- ============================================================================
-- 004 — Duplicate-lookup performance under row-level security.
-- With RLS, Postgres only evaluates "leakproof" functions before the policy,
-- so indexes on lower(email) and the trigram % operator were ignored and each
-- lookup scanned the whole prospects table (≈200 ms per insert at 40k rows).
-- Emails and handles are already stored normalized (lower-case), so plain
-- equality indexes work; the name search runs in a workspace-scoped
-- SECURITY DEFINER function where the trigram index can be used.
-- ============================================================================

create index if not exists prospects_email_plain_idx on outbound.prospects (email) where email is not null;
create index if not exists prospects_ig_plain_idx on outbound.prospects (instagram_handle) where instagram_handle is not null;
create index if not exists prospects_tt_plain_idx on outbound.prospects (tiktok_handle) where tiktok_handle is not null;

-- Similar business names in the CURRENT workspace only (current_workspace_id()
-- comes from the caller's transaction); app.system is enabled just inside this
-- function so the policy doesn't block the index scan.
create or replace function outbound.prospect_name_candidates(p_name text)
returns setof uuid
language sql stable security definer
set app.system = 'on'
set pg_trgm.similarity_threshold = '0.45'
set search_path = outbound, public
as $$
  select id from outbound.prospects
  where workspace_id = outbound.current_workspace_id()
    and merged_into is null
    and normalized_name % p_name
    and similarity(normalized_name, p_name) > 0.45
  order by similarity(normalized_name, p_name) desc
  limit 25
$$;

revoke all on function outbound.prospect_name_candidates(text) from public;
grant execute on function outbound.prospect_name_candidates(text) to ob_app;
