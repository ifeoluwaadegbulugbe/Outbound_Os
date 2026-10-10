-- ============================================================================
-- 003 — Large-scale collection engine.
-- A persistent registry of collection units (one per source × country ×
-- tile/category/query), a website-crawl queue on prospects, and fields for
-- addresses and crawl provenance. Builds on existing tables.
-- ============================================================================

create table outbound.collection_units (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  source text not null,                       -- adapter key: overture | osm_country | commoncrawl | …
  unit_key text not null,                     -- stable id, e.g. overture:NG:4_6
  country_code text,
  category text,
  params jsonb not null default '{}'::jsonb,
  priority int not null default 50,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'dead', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  found int not null default 0,               -- rows returned by the source
  created int not null default 0,             -- new unique businesses
  merged int not null default 0,              -- matched an existing business (duplicates removed)
  flagged int not null default 0,
  skipped int not null default 0,
  with_email int not null default 0,
  with_website int not null default 0,
  duration_ms int,
  diagnostic text,                            -- e.g. why a unit returned 0 rows
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (workspace_id, source, unit_key)
);
create index collection_units_due_idx on outbound.collection_units (workspace_id, status, priority desc, next_attempt_at);
create index collection_units_source_idx on outbound.collection_units (workspace_id, source, status);

alter table outbound.prospects
  add column address text,
  add column website_crawl_status text check (website_crawl_status in ('pending', 'ok', 'no_email', 'blocked', 'error', 'skipped')),
  add column website_crawl_attempts int not null default 0,
  add column website_next_crawl_at timestamptz,
  add column website_crawl_error text,
  add column name_from_domain boolean not null default false;

-- Crawl queue: websites waiting to be checked, oldest first.
create index prospects_crawl_queue_idx on outbound.prospects (workspace_id, website_next_crawl_at)
  where website is not null and merged_into is null and (website_crawl_status is null or website_crawl_status in ('pending', 'error'));
create index prospects_country_idx on outbound.prospects (workspace_id, country) where merged_into is null;
create index prospects_source_idx on outbound.prospects (workspace_id, source) where merged_into is null;
create index prospects_discovered_idx on outbound.prospects (workspace_id, discovered_at desc);

-- Existing websites already checked by the old finder count as crawled.
update outbound.prospects set website_crawl_status = case when email_source = 'website' then 'ok' else 'no_email' end
  where website_checked_at is not null and website_crawl_status is null;

alter table outbound.collection_units enable row level security;
alter table outbound.collection_units force row level security;
create policy workspace_isolation on outbound.collection_units
  using (outbound.is_system() or workspace_id = outbound.current_workspace_id())
  with check (outbound.is_system() or workspace_id = outbound.current_workspace_id());
grant select, insert, update, delete on outbound.collection_units to ob_app;
