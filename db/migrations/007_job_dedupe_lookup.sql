-- ============================================================================
-- 007 — Recurring jobs run once per time slot (enqueue({ once: true })), which
-- checks for any earlier job with the same dedupe key, not just queued/running
-- ones. On serverless the scheduler is called every minute, so without this the
-- hourly/daily jobs ran every minute.
-- ============================================================================

create index if not exists jobs_dedupe_key_idx on outbound.jobs (workspace_id, dedupe_key) where dedupe_key is not null;
