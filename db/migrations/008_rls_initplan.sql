-- ============================================================================
-- 008 — Row-level security performance.
-- Policies called is_system() / current_workspace_id() once per row, so every
-- count over prospects re-read the session settings 80k+ times (≈2–3 s per
-- query on a small hosted Postgres). Wrapping the calls in a scalar subquery
-- makes Postgres evaluate them once per query (an InitPlan); the rule itself is
-- unchanged.
-- ============================================================================

do $$
declare t record;
begin
  for t in select c.relname from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'outbound' and p.polname = 'workspace_isolation'
  loop
    execute format(
      'alter policy workspace_isolation on outbound.%I using ((select outbound.is_system()) or workspace_id = (select outbound.current_workspace_id())) '
      'with check ((select outbound.is_system()) or workspace_id = (select outbound.current_workspace_id()))', t.relname);
  end loop;
end $$;

alter policy workspace_self on outbound.workspaces
  using ((select outbound.is_system()) or id = (select outbound.current_workspace_id()))
  with check ((select outbound.is_system()) or id = (select outbound.current_workspace_id()));

alter policy users_visible on outbound.users
  using ((select outbound.is_system()) or exists (
    select 1 from outbound.workspace_members m where m.user_id = users.id and m.workspace_id = (select outbound.current_workspace_id())))
  with check ((select outbound.is_system()));
