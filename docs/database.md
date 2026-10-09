# Database

Postgres 15+. All objects live in the `outbound` schema (`db/migrations/001_init.sql`). Development and tests use embedded **PGlite** (real Postgres compiled to WASM), so the SQL is identical everywhere.

## Tables

| Group | Tables |
|---|---|
| Tenancy & auth | `workspaces`, `users`, `workspace_members` (roles), `sessions` (hashed tokens), `login_attempts` |
| Targeting | `icp_profiles`, `campaigns`, `segments`, `goals`, `saved_views`, `followup_sequences` |
| Prospects | `prospects` (≈90 columns incl. denormalised current scores and funnel timestamps), `prospect_social_profiles`, `prospect_sources`, `prospect_scores` (history), `prospect_research`, `prospect_notes`, `campaign_prospects`, `possible_duplicates`, `dnc_entries` |
| Discovery | `discovery_runs`, `discovery_candidates` (Instagram snowball queue), `hashtag_queries` (30/7-day budget), `import_batches` |
| Outreach | `sender_accounts` (caps & warm-up), `message_variants`, `outreach_batches`, `outreach_messages`, `outreach_events` (append-only timeline), `followups`, `tracked_links`, `link_clicks` |
| Conversations | `conversations`, `conversation_messages` |
| Learning | `experiments`, `experiment_variants`, `experiment_assignments`, `conversions`, `analytics_snapshots` |
| Operations | `integrations` (encrypted secrets), `integration_logs`, `jobs`, `job_logs`, `ai_runs`, `notifications`, `audit_logs` |

## Notable modelling choices

- **Funnel timestamps** on `prospects` (`qualified_at`, `first_contacted_at`, `replied_at`, `interested_at`, `signup_at`, `activation_at`, `paid_at`) give "ever reached this stage" semantics, so a prospect who replied then went cold still counts as a reply. Analytics never reconstructs this from mutable `status`.
- **Signals with evidence:** `prospects.signals` is `{ signal: { value, source, quote } }` — e.g. `dmBookings: { value: true, source: "bio", quote: "DM to book" }`. Scoring, validation and AI briefs all cite it.
- **Tri-state business flags** (`accepts_bookings`, …): `null` means unknown — never assumed false or true.
- **Suppression is separate from prospects:** `dnc_entries` keyed by kind + value (handle, phone, email, domain) so an opt-out survives deletion, merge and re-import.
- **Merges keep a tombstone:** `merged_into` points at the surviving record; all history moves over.

## Indexes

Lookup: lower(email), phone, whatsapp, lower(instagram_handle), lower(tiktok_handle), website_domain, source_url — all partial, per workspace. Sorting/filtering: `(workspace_id, status)`, ICP and priority (desc nulls last), category, lower(city), created_at, next_follow_up_at, funnel timestamps. Fuzzy search & dedup: GIN `pg_trgm` on `normalized_name` and `business_name`; conversation bodies too. Queue: partial index on queued jobs by `run_at`; uniqueness on active `dedupe_key`.

## Row-level security

Every workspace table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with:

```sql
using (outbound.is_system() or workspace_id = outbound.current_workspace_id())
```

The app runs workspace transactions as role **`ob_app`** (no `BYPASSRLS`) after setting `app.workspace_id`. `withSystem()` (auth, worker bookkeeping, webhook routing) sets `app.system = on` instead. `sessions` and `login_attempts` are system-only. `tests/integration/db.test.ts` proves cross-workspace reads, inserts and updates are refused by Postgres.

## Migrations

`npm run db:migrate` applies new files in `db/migrations` in order inside a transaction, recording them in `outbound.schema_migrations`. Embedded dev databases migrate automatically on boot. Migrations are forward-only; add `002_…sql` for changes.

## Scale

Designed for 30k+ prospects and 100k+ events: server-side filtering and pagination, indexed sorts, aggregate queries in SQL, background jobs for bulk work, short transactions.

## Migration 002: email-first

`db/migrations/002_email_first.sql` builds on the existing tables rather than replacing them:

| Change | Purpose |
|---|---|
| `prospects` + `email_source`, `email_source_url`, `email_discovered_at`, `email_status` (none/unverified/verified/unknown/catch_all/risky/invalid), `email_verified_at`, `email_verification`, `website_checked_at`, `bounced`, `unsubscribed` | Email facts with provenance |
| `prospect_contacts` | Every discovered email/phone with source URL, timestamp and verification result |
| `locations`, `categories` | Editable cities (with bounding boxes) and custom business categories, per workspace |
| `country_policies` | Cold-email rule per country (allowed / consent_required / blocked), legal basis, who acknowledged it |
| `sender_accounts` + `provider`, `email_address`, `secret_ciphertext` (encrypted OAuth token), `provider_daily_limit`, `status`, `min_interval_seconds`, `dns_checks`… | Email mailboxes reuse the sender accounts table |
| `outreach_messages` + `queued`/`sending` statuses, `to_email`, `provider_message_id`, `provider_thread_id`, `rfc_message_id`, `idempotency_key` (unique), `delivery_status`, `bounced_at`, `unsubscribe_token`, `is_test` | Real send tracking; the idempotency key and atomic claim prevent double sends |
| `email_events` | accepted / delivered / bounced / complained / replied / unsubscribed / failed / test_sent |
| `campaigns` + `code`, `sender_account_id`, `daily_send_cap`, `send_window`, `followup_days`, `compliance`, `cost_amount` | Attribution id, sending rules, compliance checklist |
| `costs` | Real spend for cost per activated / paid |
| `discovery_runs` + `paused` status, `checkpoint`, `target`, `emails_found` | Resumable discovery |
| `test_outbox` | Development-only test mailbox (never delivered) |

All new tables have the same workspace row-level security as the rest of the schema.
