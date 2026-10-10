-- ============================================================================
-- 005 — Instagram email enrichment via the official Graph API (Business
-- Discovery). Marks when a prospect's public Instagram business profile was
-- read, so each handle is looked up once (re-checked after 90 days).
-- ============================================================================
alter table outbound.prospects add column instagram_checked_at timestamptz;
create index prospects_ig_enrich_idx on outbound.prospects (workspace_id)
  where instagram_handle is not null and email is null and instagram_checked_at is null and merged_into is null;
