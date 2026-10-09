-- ============================================================================
-- 002 — Email-first acquisition
-- Adds: per-contact provenance + verification, Africa-wide locations, custom
-- categories, country compliance policies, email sending accounts (on the
-- existing sender_accounts table), real send tracking (provider ids, delivery,
-- bounces), email events, unsubscribe tokens, resumable discovery checkpoints,
-- campaign codes/compliance/costs. Reuses existing tables wherever possible.
-- ============================================================================

-- ── Prospects: email facts with provenance ─────────────────────────────────
alter table outbound.prospects
  add column email_source text,
  add column email_source_url text,
  add column email_discovered_at timestamptz,
  add column email_status text not null default 'none'
    check (email_status in ('none', 'unverified', 'verified', 'unknown', 'catch_all', 'risky', 'invalid')),
  add column email_verified_at timestamptz,
  add column email_verification jsonb,
  add column phone_source text,
  add column last_researched_at timestamptz,
  add column website_checked_at timestamptz,
  add column bounced boolean not null default false,
  add column unsubscribed boolean not null default false;

update outbound.prospects set email_status = 'unverified', email_discovered_at = coalesce(imported_at, discovered_at), email_source = source
  where email is not null;

create index prospects_ws_email_status_idx on outbound.prospects (workspace_id, email_status) where merged_into is null;
create index prospects_ws_country_idx on outbound.prospects (workspace_id, country);
create index prospects_ws_website_pending_idx on outbound.prospects (workspace_id) where website is not null and website_checked_at is null;

-- Every contact method we hold, with where/when it came from and its verification.
create table outbound.prospect_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone', 'website', 'booking', 'social')),
  value text not null,
  is_primary boolean not null default false,
  is_role boolean not null default false,            -- info@, hello@, bookings@… (business enquiry addresses)
  source text not null,
  source_url text,
  discovered_at timestamptz not null default now(),
  verification_status text check (verification_status in ('unverified', 'verified', 'unknown', 'catch_all', 'risky', 'invalid')),
  verified_at timestamptz,
  verification_provider text,
  verification_raw jsonb,
  created_at timestamptz not null default now(),
  unique (prospect_id, kind, value)
);
create index prospect_contacts_lookup_idx on outbound.prospect_contacts (workspace_id, kind, lower(value));

insert into outbound.prospect_contacts (workspace_id, prospect_id, kind, value, is_primary, source, source_url, discovered_at, verification_status)
  select workspace_id, id, 'email', lower(email), true, source, source_url, coalesce(imported_at, discovered_at), 'unverified'
  from outbound.prospects where email is not null
  on conflict do nothing;

-- ── Locations (Africa-wide, editable without code) ─────────────────────────
create table outbound.locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  country_code text not null,
  country_name text not null,
  region text,
  city text not null,
  key text not null,
  aliases text[] not null default '{}',
  bbox_south double precision not null,
  bbox_west double precision not null,
  bbox_north double precision not null,
  bbox_east double precision not null,
  is_active boolean not null default true,
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, key),
  check (bbox_north > bbox_south and bbox_east > bbox_west)
);
create index locations_ws_country_idx on outbound.locations (workspace_id, country_code);

-- ── Categories (built-ins live in code; custom ones here) ───────────────────
create table outbound.categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  key text not null,
  label text not null,
  group_name text not null default 'other',
  keywords text[] not null default '{}',
  osm_tags text[] not null default '{}',             -- Overpass filters, e.g. ["shop"="dry_cleaning"]
  value_props text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, key),
  check (key ~ '^[a-z][a-z0-9_]{1,40}$')
);

-- ── Country compliance policies ─────────────────────────────────────────────
create table outbound.country_policies (
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  country_code text not null,
  cold_email text not null check (cold_email in ('allowed', 'consent_required', 'blocked')),
  legal_basis text,
  notes text,
  acknowledged_by uuid references outbound.users(id) on delete set null,
  acknowledged_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, country_code)
);

-- ── Sending accounts: reuse sender_accounts, add email-provider fields ───────
alter table outbound.sender_accounts
  add column provider text not null default 'manual' check (provider in ('manual', 'gmail', 'microsoft', 'test_sink')),
  add column email_address text,
  add column from_name text,
  add column secret_ciphertext text,                  -- encrypted OAuth refresh token (never a password)
  add column provider_daily_limit int,
  add column status text not null default 'active' check (status in ('active', 'paused', 'needs_reconnect', 'error')),
  add column paused_reason text,
  add column paused_at timestamptz,
  add column last_error text,
  add column last_error_at timestamptz,
  add column min_interval_seconds int not null default 90 check (min_interval_seconds >= 10),
  add column last_sent_at timestamptz,
  add column dns_checks jsonb,
  add column dns_checked_at timestamptz,
  add column last_synced_at timestamptz;
create unique index sender_accounts_email_uq on outbound.sender_accounts (workspace_id, lower(email_address)) where email_address is not null;

-- ── Messages: real send tracking ────────────────────────────────────────────
alter table outbound.outreach_messages drop constraint outreach_messages_status_check;
alter table outbound.outreach_messages add constraint outreach_messages_status_check check (status in (
  'draft', 'needs_review', 'approved', 'rejected', 'scheduled', 'queued', 'sending', 'sent', 'skipped', 'blocked', 'failed'));
alter table outbound.outreach_messages
  add column to_email text,
  add column provider text,
  add column provider_message_id text,
  add column provider_thread_id text,
  add column rfc_message_id text,
  add column idempotency_key text,
  add column queued_at timestamptz,
  add column send_attempts int not null default 0,
  add column delivery_status text check (delivery_status in ('accepted', 'delivered', 'bounced', 'complained', 'deferred')),
  add column delivered_at timestamptz,
  add column bounced_at timestamptz,
  add column bounce_type text,
  add column unsubscribe_token text,
  add column is_test boolean not null default false,
  add column suggested_followup_at timestamptz;
create unique index outreach_messages_idem_uq on outbound.outreach_messages (idempotency_key) where idempotency_key is not null;
create unique index outreach_messages_unsub_uq on outbound.outreach_messages (unsubscribe_token) where unsubscribe_token is not null;
create index outreach_messages_queue_idx on outbound.outreach_messages (workspace_id, status, queued_at) where status in ('queued', 'sending');
create index outreach_messages_thread_idx on outbound.outreach_messages (sender_account_id, provider_thread_id) where provider_thread_id is not null;

-- Provider-level events (accepted, bounced, complained, replied, unsubscribed…)
create table outbound.email_events (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  message_id uuid references outbound.outreach_messages(id) on delete set null,
  prospect_id uuid references outbound.prospects(id) on delete set null,
  sender_account_id uuid references outbound.sender_accounts(id) on delete set null,
  type text not null check (type in ('accepted', 'delivered', 'bounced', 'complained', 'deferred', 'replied', 'unsubscribed', 'failed', 'test_sent')),
  provider text,
  provider_event_id text,
  detail text,
  raw jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index email_events_provider_uq on outbound.email_events (workspace_id, provider, provider_event_id) where provider_event_id is not null;
create index email_events_ws_type_idx on outbound.email_events (workspace_id, type, occurred_at desc);
create index email_events_account_idx on outbound.email_events (sender_account_id, occurred_at desc);

-- Test sink (development only): captured outbound emails, never delivered.
create table outbound.test_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  sender_account_id uuid references outbound.sender_accounts(id) on delete set null,
  to_email text not null,
  subject text not null,
  raw_mime text not null,
  created_at timestamptz not null default now()
);

-- ── Suppression reasons for email ───────────────────────────────────────────
alter table outbound.dnc_entries drop constraint dnc_entries_reason_check;
alter table outbound.dnc_entries add constraint dnc_entries_reason_check check (reason in (
  'opt_out', 'manual', 'competitor', 'customer', 'invalid', 'closed', 'inappropriate', 'duplicate', 'unsubscribed', 'bounced', 'complaint'));

-- ── Campaigns: identifier, compliance, sending controls, cost ───────────────
alter table outbound.campaigns
  add column code text,
  add column sender_account_id uuid references outbound.sender_accounts(id) on delete set null,
  add column daily_send_cap int,
  add column send_window jsonb,                       -- {"days":[1,2,3,4,5],"start":"09:00","end":"17:00","tz":"Africa/Lagos"}
  add column followup_days int[],                     -- per-campaign delays, e.g. {3,7,14}
  add column compliance jsonb not null default '{}'::jsonb,
  add column cost_amount numeric,
  add column cost_currency text default 'NGN';
update outbound.campaigns set code = left(replace(slug, '-', '_'), 40) where code is null;
create unique index campaigns_ws_code_uq on outbound.campaigns (workspace_id, code) where code is not null;

create table outbound.costs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete cascade,
  label text not null,
  amount numeric not null check (amount >= 0),
  currency text not null default 'NGN',
  incurred_on date not null default current_date,
  created_at timestamptz not null default now()
);

-- ── Resumable discovery ─────────────────────────────────────────────────────
alter table outbound.discovery_runs drop constraint discovery_runs_status_check;
alter table outbound.discovery_runs add constraint discovery_runs_status_check check (status in ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'));
alter table outbound.discovery_runs
  add column checkpoint jsonb not null default '{}'::jsonb,   -- {"done": ["osm:lagos:nail_technician", ...]}
  add column target int,
  add column emails_found int not null default 0;

-- ── RLS + grants for new tables ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['prospect_contacts', 'locations', 'categories', 'country_policies', 'email_events', 'test_outbox', 'costs'] loop
    execute format('alter table outbound.%I enable row level security', t);
    execute format('alter table outbound.%I force row level security', t);
    execute format(
      'create policy workspace_isolation on outbound.%I using (outbound.is_system() or workspace_id = outbound.current_workspace_id()) '
      || 'with check (outbound.is_system() or workspace_id = outbound.current_workspace_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema outbound to ob_app;
grant usage, select on all sequences in schema outbound to ob_app;
