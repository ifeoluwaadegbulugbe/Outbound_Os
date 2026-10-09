-- ============================================================================
-- Orbit Outbound OS — initial schema
-- All tables live in the `outbound` schema. Every workspace-owned table has
-- workspace_id + row-level security, enforced against the non-privileged
-- role `ob_app` that the app switches to inside each request transaction.
-- ============================================================================

create extension if not exists pg_trgm;

-- ── RLS helpers ─────────────────────────────────────────────────────────────
create or replace function outbound.current_workspace_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

create or replace function outbound.is_system() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.system', true), 'off') = 'on'
$$;

create or replace function outbound.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── Tenancy & auth ─────────────────────────────────────────────────────────
create table outbound.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  product_name text not null default 'Orbit',
  product_signup_url text,
  timezone text not null default 'Africa/Lagos',
  -- Global kill switch: when true nothing can be approved for sending.
  outreach_paused boolean not null default false,
  outreach_paused_at timestamptz,
  outreach_paused_by uuid,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table outbound.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  disabled_at timestamptz
);
create unique index users_email_lower_uq on outbound.users (lower(email));

create table outbound.workspace_members (
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  user_id uuid not null references outbound.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on outbound.workspace_members (user_id);

create table outbound.sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references outbound.users(id) on delete cascade,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_agent text
);
create index sessions_user_idx on outbound.sessions (user_id);

create table outbound.login_attempts (
  id bigserial primary key,
  email text not null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index login_attempts_email_idx on outbound.login_attempts (lower(email), created_at desc);

-- ── ICP, campaigns, goals, segments ─────────────────────────────────────────
create table outbound.icp_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  name text not null,
  description text,
  -- Scoring configuration: target categories, cities, weights, thresholds.
  config jsonb not null default '{}'::jsonb,
  -- Optional hard filter (filter tree) that a prospect must pass to qualify.
  rules jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index icp_profiles_ws_idx on outbound.icp_profiles (workspace_id);

create table outbound.followup_sequences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  name text not null,
  -- [{ "day": 3, "angle": "bump", "instructions": "..." }, ...]
  steps jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index followup_sequences_ws_idx on outbound.followup_sequences (workspace_id);

create table outbound.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  target_description text,
  categories text[] not null default '{}',
  country text not null default 'NG',
  cities text[] not null default '{}',
  channels text[] not null default '{}',
  prospect_goal int,
  objective text,
  offer text,
  tone text,
  -- Free-text campaign instructions for the AI, plus structured constraints
  -- ({ maxChars, noEmojis, mentionBookingLinkOnlyIfPresent, ... }).
  instructions text,
  constraints jsonb not null default '{}'::jsonb,
  targeting jsonb,
  icp_profile_id uuid references outbound.icp_profiles(id) on delete set null,
  followup_sequence_id uuid references outbound.followup_sequences(id) on delete set null,
  start_date date,
  end_date date,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index campaigns_ws_status_idx on outbound.campaigns (workspace_id, status);

create table outbound.segments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  name text not null,
  description text,
  natural_language text,
  rules jsonb not null,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index segments_ws_idx on outbound.segments (workspace_id);

create table outbound.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  name text not null,
  metric text not null check (metric in ('discovered', 'qualified', 'contacted', 'replied', 'interested', 'signed_up', 'activated', 'paid')),
  target int not null check (target > 0),
  start_date date not null,
  end_date date not null,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  segment_id uuid references outbound.segments(id) on delete set null,
  icp_profile_id uuid references outbound.icp_profiles(id) on delete set null,
  geography text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index goals_ws_idx on outbound.goals (workspace_id);

create table outbound.saved_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  user_id uuid references outbound.users(id) on delete cascade,
  page text not null,
  name text not null,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index saved_views_ws_page_idx on outbound.saved_views (workspace_id, page);

-- ── Prospects ───────────────────────────────────────────────────────────────
create table outbound.prospects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,

  -- Identity
  business_name text not null,
  normalized_name text not null,
  owner_name text,
  first_name text,
  last_name text,

  -- Business
  category text,
  subcategory text,
  services text[] not null default '{}',
  description text,
  business_size text check (business_size in ('solo', 'small', 'medium', 'large')),
  estimated_business_type text,

  -- Geography
  country text,
  state text,
  city text,
  area text,
  timezone text,
  lat double precision,
  lng double precision,

  -- Social (primary handles denormalized for fast lookup; all profiles in
  -- prospect_social_profiles)
  tiktok_url text,
  tiktok_handle text,
  instagram_url text,
  instagram_handle text,
  linkedin_url text,
  facebook_url text,
  youtube_url text,

  -- Contact
  email text,
  phone text,          -- E.164
  whatsapp text,       -- E.164
  website text,
  website_domain text,
  booking_url text,

  -- Activity
  last_post_date timestamptz,
  posting_frequency real,        -- posts per week
  follower_count int,
  engagement_rate real,
  activity_score int,

  -- Business signals (null = unknown, never assume)
  accepts_bookings boolean,
  has_booking_link boolean,
  accepts_whatsapp_bookings boolean,
  accepts_online_payments boolean,
  has_website boolean,
  has_client_management_system boolean,
  has_invoice_system boolean,
  has_payment_system boolean,
  bio text,
  -- Cited evidence for each extracted signal: { "<signal>": { value, source, quote } }
  signals jsonb not null default '{}'::jsonb,

  -- Relevance (current values; history in prospect_scores)
  icp_score int,
  intent_score int,
  fit_score int,
  priority_score int,
  completeness_score int,
  score_reasons jsonb,
  outreach_priority text check (outreach_priority in ('high', 'medium', 'low')),
  recommended_message_angle text,
  scored_at timestamptz,
  -- First time the prospect reached each funnel stage ("ever" semantics for analytics).
  qualified_at timestamptz,
  replied_at timestamptz,
  interested_at timestamptz,

  -- Outreach
  status text not null default 'NEW' check (status in (
    'NEW', 'RESEARCHING', 'QUALIFIED', 'READY', 'APPROVED', 'CONTACTED', 'REPLIED', 'INTERESTED',
    'NOT_INTERESTED', 'FOLLOW_UP', 'DEMO', 'SIGNED_UP', 'ACTIVATED', 'PAID', 'LOST', 'DO_NOT_CONTACT')),
  first_contacted_at timestamptz,
  last_contacted_at timestamptz,
  contact_count int not null default 0,
  last_channel text,
  next_follow_up_at timestamptz,
  assigned_to uuid references outbound.users(id) on delete set null,

  -- Conversion (in the product being sold — Orbit)
  visited_product boolean not null default false,
  signed_up boolean not null default false,
  activated boolean not null default false,
  paid boolean not null default false,
  subscription_plan text,
  signup_at timestamptz,
  activation_at timestamptz,
  paid_at timestamptz,
  attribution jsonb,

  -- Suppression
  do_not_contact boolean not null default false,
  dnc_reason text,
  dnc_at timestamptz,

  -- Metadata
  source text not null,
  source_url text,
  is_demo boolean not null default false,
  discovered_at timestamptz not null default now(),
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  merged_into uuid references outbound.prospects(id) on delete set null,
  archived_at timestamptz
);

create index prospects_ws_status_idx on outbound.prospects (workspace_id, status) where merged_into is null;
create index prospects_ws_icp_idx on outbound.prospects (workspace_id, icp_score desc nulls last) where merged_into is null;
create index prospects_ws_priority_idx on outbound.prospects (workspace_id, priority_score desc nulls last) where merged_into is null;
create index prospects_ws_category_idx on outbound.prospects (workspace_id, category);
create index prospects_ws_city_idx on outbound.prospects (workspace_id, lower(city));
create index prospects_ws_created_idx on outbound.prospects (workspace_id, created_at desc);
create index prospects_ws_qualified_at_idx on outbound.prospects (workspace_id, qualified_at) where qualified_at is not null;
create index prospects_ws_contacted_at_idx on outbound.prospects (workspace_id, first_contacted_at) where first_contacted_at is not null;
create index prospects_ws_replied_at_idx on outbound.prospects (workspace_id, replied_at) where replied_at is not null;
create index prospects_ws_followup_idx on outbound.prospects (workspace_id, next_follow_up_at) where next_follow_up_at is not null;
create index prospects_email_idx on outbound.prospects (workspace_id, lower(email)) where email is not null;
create index prospects_phone_idx on outbound.prospects (workspace_id, phone) where phone is not null;
create index prospects_whatsapp_idx on outbound.prospects (workspace_id, whatsapp) where whatsapp is not null;
create index prospects_ig_idx on outbound.prospects (workspace_id, lower(instagram_handle)) where instagram_handle is not null;
create index prospects_tt_idx on outbound.prospects (workspace_id, lower(tiktok_handle)) where tiktok_handle is not null;
create index prospects_domain_idx on outbound.prospects (workspace_id, website_domain) where website_domain is not null;
create index prospects_source_url_idx on outbound.prospects (workspace_id, source_url) where source_url is not null;
create index prospects_name_trgm_idx on outbound.prospects using gin (normalized_name gin_trgm_ops);
create index prospects_bizname_trgm_idx on outbound.prospects using gin (business_name gin_trgm_ops);

create table outbound.prospect_social_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'tiktok', 'linkedin', 'facebook', 'youtube', 'x', 'website', 'linktree', 'other')),
  handle text,
  url text,
  followers int,
  following int,
  posts int,
  bio text,
  last_post_at timestamptz,
  posting_frequency real,
  fetched_at timestamptz,
  source text,
  created_at timestamptz not null default now(),
  unique (prospect_id, platform, handle)
);
create index social_profiles_handle_idx on outbound.prospect_social_profiles (workspace_id, platform, lower(handle));

create table outbound.prospect_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  source text not null,
  external_id text,
  source_url text,
  raw jsonb,
  discovered_at timestamptz not null default now()
);
create index prospect_sources_prospect_idx on outbound.prospect_sources (prospect_id);
create unique index prospect_sources_ext_uq on outbound.prospect_sources (workspace_id, source, external_id) where external_id is not null;

create table outbound.prospect_scores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  icp_profile_id uuid references outbound.icp_profiles(id) on delete set null,
  icp_score int not null,
  fit_score int,
  intent_score int,
  priority_score int,
  completeness_score int,
  breakdown jsonb not null,
  scorer_version text not null,
  computed_at timestamptz not null default now()
);
create index prospect_scores_prospect_idx on outbound.prospect_scores (prospect_id, computed_at desc);

create table outbound.prospect_research (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  summary text not null,
  -- [{ "statement": "...", "kind": "fact"|"inference"|"unknown", "basis": ["bio", ...] }]
  statements jsonb not null default '[]'::jsonb,
  why_relevant jsonb not null default '[]'::jsonb,
  recommended_angle text,
  value_props text[] not null default '{}',
  confidence int,
  generator text not null,   -- 'ai:<provider>/<model>' or 'rules'
  created_at timestamptz not null default now()
);
create index prospect_research_prospect_idx on outbound.prospect_research (prospect_id, created_at desc);

create table outbound.prospect_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  user_id uuid references outbound.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index prospect_notes_prospect_idx on outbound.prospect_notes (prospect_id, created_at desc);

create table outbound.campaign_prospects (
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid not null references outbound.campaigns(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (campaign_id, prospect_id)
);
create index campaign_prospects_prospect_idx on outbound.campaign_prospects (prospect_id);

create table outbound.possible_duplicates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_a uuid not null references outbound.prospects(id) on delete cascade,
  prospect_b uuid not null references outbound.prospects(id) on delete cascade,
  confidence int not null,
  reasons jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'merged', 'kept_separate', 'ignored')),
  resolved_by uuid references outbound.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (prospect_a < prospect_b),
  unique (prospect_a, prospect_b)
);
create index possible_duplicates_ws_status_idx on outbound.possible_duplicates (workspace_id, status, confidence desc);

-- Suppression list. Survives prospect deletion/re-import, so an opt-out is
-- honoured even if the same business is discovered again later.
create table outbound.dnc_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone', 'instagram', 'tiktok', 'domain', 'prospect')),
  value text not null,
  reason text not null check (reason in ('opt_out', 'manual', 'competitor', 'customer', 'invalid', 'closed', 'inappropriate', 'duplicate')),
  note text,
  prospect_id uuid references outbound.prospects(id) on delete set null,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, value)
);

-- ── Discovery ───────────────────────────────────────────────────────────────
create table outbound.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  adapter text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  found int not null default 0,
  created int not null default 0,
  merged int not null default 0,
  duplicates_flagged int not null default 0,
  skipped int not null default 0,
  job_id uuid,
  error text,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index discovery_runs_ws_idx on outbound.discovery_runs (workspace_id, created_at desc);

-- Candidate handles found during discovery (e.g. @mentions in captions),
-- waiting to be looked up. Powers the Instagram snowball.
create table outbound.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  platform text not null,
  handle text not null,
  found_via text not null,          -- 'hashtag:#lagosnails', 'mention:@x', 'bio:@y', 'seed'
  depth int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'looked_up', 'not_business', 'not_found', 'rejected', 'error')),
  prospect_id uuid references outbound.prospects(id) on delete set null,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  looked_up_at timestamptz,
  unique (workspace_id, platform, handle)
);
create index discovery_candidates_pending_idx on outbound.discovery_candidates (workspace_id, status, depth, created_at);

-- Instagram allows 30 unique hashtags per rolling 7 days per account.
create table outbound.hashtag_queries (
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  hashtag text not null,
  hashtag_id text,
  first_queried_at timestamptz not null default now(),
  last_queried_at timestamptz not null default now(),
  results int not null default 0,
  primary key (workspace_id, hashtag)
);

-- ── Experiments & variants ──────────────────────────────────────────────────
create table outbound.message_variants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid not null references outbound.campaigns(id) on delete cascade,
  key text not null,                -- 'A', 'B', ...
  name text not null,
  angle text not null,
  instructions text,
  example text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (campaign_id, key)
);

create table outbound.experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  name text not null,
  hypothesis text,
  kind text not null check (kind in ('icp', 'message', 'channel', 'offer')),
  primary_metric text not null default 'reply_rate' check (primary_metric in ('reply_rate', 'interest_rate', 'signup_rate', 'activation_rate', 'paid_rate')),
  status text not null default 'draft' check (status in ('draft', 'running', 'stopped', 'completed')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table outbound.experiment_variants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  experiment_id uuid not null references outbound.experiments(id) on delete cascade,
  key text not null,
  name text not null,
  -- icp: {"category": "nail_technician"}; message: {"angle": "curiosity"} or {"variantId": ...};
  -- channel: {"channel": "instagram"}; offer: {"offer": "Try Orbit free"}
  config jsonb not null default '{}'::jsonb,
  weight int not null default 1,
  unique (experiment_id, key)
);

create table outbound.experiment_assignments (
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  experiment_id uuid not null references outbound.experiments(id) on delete cascade,
  variant_id uuid not null references outbound.experiment_variants(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (experiment_id, prospect_id)
);

-- ── Sender accounts (the human-operated accounts messages go out from) ───────
create table outbound.sender_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  user_id uuid references outbound.users(id) on delete set null,   -- the person operating it
  channel text not null check (channel in ('instagram', 'tiktok', 'whatsapp', 'email', 'linkedin', 'facebook')),
  label text not null,               -- '@orbit.ng', '+234 80…', 'ada@getorbit…'
  handle text,
  daily_cap int not null default 80 check (daily_cap >= 0),
  -- Warm-up: cap ramps from warmup_start_cap by warmup_step every 7 days until daily_cap.
  warmup_enabled boolean not null default true,
  warmup_start_cap int not null default 30,
  warmup_step int not null default 15,
  warmup_started_on date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index sender_accounts_ws_idx on outbound.sender_accounts (workspace_id, channel);

-- ── Outreach ────────────────────────────────────────────────────────────────
create table outbound.outreach_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  channel text not null,
  total int not null default 0,
  generated int not null default 0,
  blocked int not null default 0,
  status text not null default 'queued' check (status in ('queued', 'generating', 'ready', 'failed', 'cancelled')),
  params jsonb not null default '{}'::jsonb,
  job_id uuid,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table outbound.tracked_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  code text not null unique,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  prospect_id uuid references outbound.prospects(id) on delete set null,
  variant_id uuid references outbound.message_variants(id) on delete set null,
  channel text,
  destination_url text not null,
  utm jsonb not null default '{}'::jsonb,
  clicks int not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  created_at timestamptz not null default now()
);
create index tracked_links_prospect_idx on outbound.tracked_links (prospect_id);

create table outbound.link_clicks (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  link_id uuid not null references outbound.tracked_links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  referrer_host text,
  is_bot boolean not null default false
);
create index link_clicks_link_idx on outbound.link_clicks (link_id, clicked_at desc);

create table outbound.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  batch_id uuid references outbound.outreach_batches(id) on delete set null,
  channel text not null,
  kind text not null default 'initial' check (kind in ('initial', 'followup', 'reply')),
  step int not null default 0,
  variant_id uuid references outbound.message_variants(id) on delete set null,
  experiment_variant_id uuid references outbound.experiment_variants(id) on delete set null,
  angle text,
  value_props text[] not null default '{}',
  subject text,
  body text not null,
  original_body text,                -- what the generator produced, for edit tracking
  generator text not null,           -- 'ai:<provider>/<model>' | 'template' | 'human'
  status text not null default 'needs_review' check (status in (
    'draft', 'needs_review', 'approved', 'rejected', 'scheduled', 'sent', 'skipped', 'blocked', 'failed')),
  validation jsonb not null default '{"ok": true, "issues": []}'::jsonb,
  send_mode text check (send_mode in ('automated', 'assisted', 'manual')),
  sender_account_id uuid references outbound.sender_accounts(id) on delete set null,
  tracked_link_id uuid references outbound.tracked_links(id) on delete set null,
  scheduled_for timestamptz,
  approved_by uuid references outbound.users(id) on delete set null,
  approved_at timestamptz,
  sent_by uuid references outbound.users(id) on delete set null,
  sent_at timestamptz,
  edited boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outreach_messages_ws_status_idx on outbound.outreach_messages (workspace_id, status, created_at desc);
create index outreach_messages_prospect_idx on outbound.outreach_messages (prospect_id, created_at desc);
create index outreach_messages_campaign_idx on outbound.outreach_messages (campaign_id, status);
create index outreach_messages_sent_idx on outbound.outreach_messages (workspace_id, sent_at desc) where sent_at is not null;
create index outreach_messages_sender_day_idx on outbound.outreach_messages (sender_account_id, sent_at) where sent_at is not null;
create index outreach_messages_batch_idx on outbound.outreach_messages (batch_id);

-- Append-only event log: activity timeline, analytics and attribution.
create table outbound.outreach_events (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid references outbound.prospects(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  message_id uuid references outbound.outreach_messages(id) on delete set null,
  type text not null,
  channel text,
  data jsonb not null default '{}'::jsonb,
  actor_type text not null default 'system' check (actor_type in ('user', 'system', 'ai', 'webhook')),
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index outreach_events_prospect_idx on outbound.outreach_events (prospect_id, created_at desc);
create index outreach_events_ws_type_idx on outbound.outreach_events (workspace_id, type, created_at desc);
create index outreach_events_campaign_idx on outbound.outreach_events (campaign_id, type);

create table outbound.followups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  sequence_id uuid references outbound.followup_sequences(id) on delete set null,
  step int not null,
  channel text,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'skipped', 'cancelled')),
  message_id uuid references outbound.outreach_messages(id) on delete set null,
  cancel_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index followups_ws_due_idx on outbound.followups (workspace_id, status, due_at);
create index followups_prospect_idx on outbound.followups (prospect_id);

-- ── Conversations ───────────────────────────────────────────────────────────
create table outbound.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid not null references outbound.prospects(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  channel text not null,
  status text not null default 'open' check (status in ('open', 'needs_response', 'waiting', 'closed')),
  intent text,
  intent_confidence int,
  summary text,
  next_action text,
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  unread boolean not null default false,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  unique (prospect_id, channel)
);
create index conversations_ws_status_idx on outbound.conversations (workspace_id, status, last_message_at desc);

create table outbound.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  conversation_id uuid not null references outbound.conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  occurred_at timestamptz not null default now(),
  outreach_message_id uuid references outbound.outreach_messages(id) on delete set null,
  classification jsonb,
  logged_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index conversation_messages_conv_idx on outbound.conversation_messages (conversation_id, occurred_at);
create index conversation_messages_body_trgm_idx on outbound.conversation_messages using gin (body gin_trgm_ops);

-- ── Conversions (events from the product: Orbit) ─────────────────────────────
create table outbound.conversions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  prospect_id uuid references outbound.prospects(id) on delete set null,
  type text not null check (type in ('visit', 'signup', 'activated', 'paid')),
  external_user_id text,
  email text,
  phone text,
  ref_code text,
  utm jsonb not null default '{}'::jsonb,
  plan text,
  amount numeric,
  currency text,
  occurred_at timestamptz not null,
  match_method text not null default 'unmatched' check (match_method in ('ref_code', 'email', 'phone', 'instagram', 'manual', 'unmatched')),
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  variant_id uuid references outbound.message_variants(id) on delete set null,
  channel text,
  source text not null default 'webhook',
  raw jsonb,
  created_at timestamptz not null default now()
);
create unique index conversions_dedupe_uq on outbound.conversions (workspace_id, type, external_user_id) where external_user_id is not null;
create index conversions_prospect_idx on outbound.conversions (prospect_id);
create index conversions_ws_type_idx on outbound.conversions (workspace_id, type, occurred_at desc);
create index conversions_unmatched_idx on outbound.conversions (workspace_id) where prospect_id is null;

-- ── Integrations, jobs, AI, observability ───────────────────────────────────
create table outbound.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  key text not null,
  status text not null default 'needs_setup' check (status in ('connected', 'needs_setup', 'needs_approval', 'disabled', 'error')),
  config jsonb not null default '{}'::jsonb,
  secret_ciphertext text,            -- AES-256-GCM, key from ENCRYPTION_KEY
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  rate_limit_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table outbound.integration_logs (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  integration_key text not null,
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  request jsonb,
  response_status int,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index integration_logs_ws_idx on outbound.integration_logs (workspace_id, integration_key, created_at desc);

create table outbound.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  type text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  progress_current int not null default 0,
  progress_total int,
  progress_label text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  cancel_requested boolean not null default false,
  dedupe_key text,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_claim_idx on outbound.jobs (status, run_at) where status = 'queued';
create index jobs_ws_idx on outbound.jobs (workspace_id, created_at desc);
create unique index jobs_dedupe_uq on outbound.jobs (workspace_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

create table outbound.job_logs (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  job_id uuid not null references outbound.jobs(id) on delete cascade,
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index job_logs_job_idx on outbound.job_logs (job_id, id);

create table outbound.ai_runs (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  task text not null,
  provider text not null,
  model text,
  status text not null check (status in ('ok', 'invalid_output', 'error', 'fallback')),
  attempts int not null default 1,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  error text,
  created_at timestamptz not null default now()
);
create index ai_runs_ws_idx on outbound.ai_runs (workspace_id, created_at desc);

create table outbound.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  user_id uuid references outbound.users(id) on delete cascade,  -- null = everyone in workspace
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_ws_idx on outbound.notifications (workspace_id, created_at desc);

create table outbound.audit_logs (
  id bigserial primary key,
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'system', 'ai', 'webhook')),
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_ws_idx on outbound.audit_logs (workspace_id, created_at desc);
create index audit_logs_entity_idx on outbound.audit_logs (workspace_id, entity_type, entity_id);

create table outbound.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  snapshot_date date not null,
  campaign_id uuid references outbound.campaigns(id) on delete cascade,
  metrics jsonb not null,
  created_at timestamptz not null default now()
);
create unique index analytics_snapshots_uq on outbound.analytics_snapshots
  (workspace_id, snapshot_date, coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table outbound.import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outbound.workspaces(id) on delete cascade,
  campaign_id uuid references outbound.campaigns(id) on delete set null,
  filename text,
  preset text,
  mapping jsonb not null,
  total int not null default 0,
  created int not null default 0,
  merged int not null default 0,
  duplicates_flagged int not null default 0,
  skipped int not null default 0,
  errors jsonb not null default '[]'::jsonb,
  status text not null default 'queued',
  job_id uuid,
  created_by uuid references outbound.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── updated_at triggers ─────────────────────────────────────────────────────
create trigger workspaces_touch before update on outbound.workspaces for each row execute function outbound.touch_updated_at();
create trigger campaigns_touch before update on outbound.campaigns for each row execute function outbound.touch_updated_at();
create trigger segments_touch before update on outbound.segments for each row execute function outbound.touch_updated_at();
create trigger icp_profiles_touch before update on outbound.icp_profiles for each row execute function outbound.touch_updated_at();
create trigger outreach_messages_touch before update on outbound.outreach_messages for each row execute function outbound.touch_updated_at();
create trigger integrations_touch before update on outbound.integrations for each row execute function outbound.touch_updated_at();

create or replace function outbound.touch_prospect() returns trigger
language plpgsql as $$
begin
  new.last_updated_at = now();
  return new;
end $$;
create trigger prospects_touch before update on outbound.prospects for each row execute function outbound.touch_prospect();

-- ── Row-level security ──────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'icp_profiles', 'followup_sequences', 'campaigns', 'segments', 'goals', 'saved_views',
    'prospects', 'prospect_social_profiles', 'prospect_sources', 'prospect_scores', 'prospect_research',
    'prospect_notes', 'campaign_prospects', 'possible_duplicates', 'dnc_entries',
    'discovery_runs', 'discovery_candidates', 'hashtag_queries',
    'message_variants', 'experiments', 'experiment_variants', 'experiment_assignments',
    'sender_accounts', 'outreach_batches', 'tracked_links', 'link_clicks', 'outreach_messages',
    'outreach_events', 'followups', 'conversations', 'conversation_messages', 'conversions',
    'integrations', 'integration_logs', 'jobs', 'job_logs', 'ai_runs', 'notifications',
    'audit_logs', 'analytics_snapshots', 'import_batches', 'workspace_members'
  ] loop
    execute format('alter table outbound.%I enable row level security', t);
    execute format('alter table outbound.%I force row level security', t);
    execute format(
      'create policy workspace_isolation on outbound.%I using (outbound.is_system() or workspace_id = outbound.current_workspace_id()) '
      || 'with check (outbound.is_system() or workspace_id = outbound.current_workspace_id())', t);
  end loop;
end $$;

alter table outbound.workspaces enable row level security;
alter table outbound.workspaces force row level security;
create policy workspace_self on outbound.workspaces
  using (outbound.is_system() or id = outbound.current_workspace_id())
  with check (outbound.is_system() or id = outbound.current_workspace_id());

alter table outbound.users enable row level security;
alter table outbound.users force row level security;
create policy users_visible on outbound.users
  using (outbound.is_system() or exists (
    select 1 from outbound.workspace_members m
    where m.user_id = users.id and m.workspace_id = outbound.current_workspace_id()))
  with check (outbound.is_system());

alter table outbound.sessions enable row level security;
alter table outbound.sessions force row level security;
create policy sessions_system on outbound.sessions using (outbound.is_system()) with check (outbound.is_system());

alter table outbound.login_attempts enable row level security;
alter table outbound.login_attempts force row level security;
create policy login_attempts_system on outbound.login_attempts using (outbound.is_system()) with check (outbound.is_system());

-- ── Application role ────────────────────────────────────────────────────────
-- Non-privileged role the app switches to (SET LOCAL ROLE) for workspace
-- transactions. No BYPASSRLS, so the policies above always apply to it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ob_app') then
    create role ob_app nologin;
  end if;
  begin
    execute format('grant ob_app to %I', current_user);
  exception when others then
    raise notice 'Could not grant ob_app to %: % — grant it manually (see docs/setup.md)', current_user, sqlerrm;
  end;
end $$;

grant usage on schema outbound to ob_app;
grant select, insert, update, delete on all tables in schema outbound to ob_app;
grant usage, select on all sequences in schema outbound to ob_app;
grant execute on all functions in schema outbound to ob_app;
alter default privileges in schema outbound grant select, insert, update, delete on tables to ob_app;
alter default privileges in schema outbound grant usage, select on sequences to ob_app;
