-- ============================================================================
-- 006 — Hosted Postgres compatibility (Supabase, Neon…).
-- Redefines prospect_name_candidates() without function-level custom settings,
-- which non-superuser roles may not declare. Same behaviour as before.
-- ============================================================================

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
