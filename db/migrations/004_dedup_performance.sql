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
-- comes from the caller's transaction). SECURITY DEFINER: runs as the owner,
-- which bypasses row-level security on hosted Postgres (Supabase's postgres
-- role has BYPASSRLS) and on superuser setups, so the trigram index is usable.
-- Settings are changed with set_config() inside the body and restored before
-- returning (hosted providers don't allow declaring custom settings on a function).
create or replace function outbound.prospect_name_candidates(p_name text)
returns setof uuid
language plpgsql volatile security definer
set search_path = outbound, public
as $$
declare
  prev_system text := current_setting('app.system', true);
  prev_limit text := current_setting('pg_trgm.similarity_threshold', true);
begin
  perform set_config('app.system', 'on', true);
  perform set_config('pg_trgm.similarity_threshold', '0.45', true);
  return query
    select p.id from outbound.prospects p
    where p.workspace_id = outbound.current_workspace_id()
      and p.merged_into is null
      and p.normalized_name % p_name
      and similarity(p.normalized_name, p_name) > 0.45
    order by similarity(p.normalized_name, p_name) desc
    limit 25;
  perform set_config('app.system', coalesce(nullif(prev_system, ''), 'off'), true);
  perform set_config('pg_trgm.similarity_threshold', coalesce(nullif(prev_limit, ''), '0.3'), true);
end
$$;

revoke all on function outbound.prospect_name_candidates(text) from public;
grant execute on function outbound.prospect_name_candidates(text) to ob_app;
