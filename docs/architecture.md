# Architecture

## Shape

```
Browser (Next.js App Router UI, server components + small client islands)
   │  server actions / route handlers (every one calls requireUser)
   ▼
Services (src/server/services)  ──►  Domain core (src/server/domain, pure & tested)
   │                                   scoring · dedup · validator · status machine
   │                                   classifier rules · filters · templates · channels
   ▼
DB layer (src/server/db) — sql`` builder, withWorkspace (RLS) / withSystem
   ▼
Postgres (PGlite embedded in dev/tests; any Postgres 15+ in production)

Job worker (src/server/jobs) ── adapters (src/server/adapters) ── external APIs
          └── AI tasks (src/server/ai) ── Ollama / Groq / Gemini / Anthropic (optional)
```

- **Standalone.** Separate from the Orbit app: own database, auth and deploy. Orbit only sends conversion events (webhook) — see `docs/integrations.md`.
- **Multi-tenant from day one.** Every table carries `workspace_id`; Postgres row-level security isolates workspaces. This keeps the door open to selling it as SaaS later.

## Request path

1. `src/proxy.ts` — optimistic redirect to `/login` without a session cookie (not a security boundary).
2. Page / server action calls `requireUser(minRole)` → session from hashed token → role check.
3. `asUser(user, q => …)` opens a transaction, sets `app.workspace_id`, and `SET LOCAL ROLE ob_app` — a role with no `BYPASSRLS`, so **Postgres itself** enforces tenant isolation even if application code forgets a filter.
4. Domain functions decide; services persist; `audit()` and `logEvent()` record what happened in the same transaction.

## Core pipeline

```
SourceAdapter.discover()  →  NormalizedProspect
   → ingest.prepare()      normalise phones (E.164), handles, domains; extract cited signals from bio
   → suppression check     dnc_entries (opt-outs survive re-discovery)
   → entity resolution     exact identifiers + pg_trgm candidates → compareProspects()
        merge (same handle / compatible contact) | flag (possible_duplicates) | create
   → rescoreProspect()     ICP, fit, intent, priority, completeness (+ reasons) → QUALIFIED
   → campaign membership
```

```
generateDraft():  load context (tx) → plan channel/angle/variant → AI or template (no tx) → validate → insert (tx)
review:           edit → revalidate → approve (revalidated again) → status APPROVED
send:             human sends in the platform → markSent(): revalidate, enforce daily cap,
                  CONTACTED, conversation thread, follow-up sequence, events, audit
reply:            logInbound(): rules-first classify (opt-out is authoritative) → status,
                  cancel follow-ups, DNC on opt-out, notify
conversion:       webhook → recordConversion(): ref code → email → phone → IG handle,
                  SIGNED_UP/ACTIVATED/PAID, attribution snapshot, stop sequences
```

## Key design decisions

| Decision | Why |
|---|---|
| Deterministic scoring, dedup, validation, opt-out detection | Explainable, testable, free, and never hallucinates. AI only writes text and refines intent. |
| AI outside DB transactions | A slow model must never hold a DB lock (critical on single-connection PGlite). |
| Never silently merge | Only exact identity (same handle; same phone/email with a compatible name) merges automatically. Everything else is a human decision. |
| Human sends every message | No platform permits automated cold DMs (see feasibility doc). The system makes the human step as fast as possible instead. |
| Postgres job queue (`FOR UPDATE SKIP LOCKED`) | No extra infrastructure; retries with backoff; progress & cancellation visible in the UI; safe with N workers. |
| Raw SQL via a tagged-template builder | Values are always bind parameters; identifiers only from hard-coded allowlists; no ORM magic at 30k+ rows. |
| Server-side pagination (50/page) + indexes | The browser never loads 30k prospects; tables stay fast without virtualisation. |

## Code map

| Path | Contents |
|---|---|
| `src/server/domain` | Pure logic: `scoring`, `dedup`, `validator`, `status`, `classifier`, `filters` (+ `filters-sql`), `templates`, `channels`, `normalize`, `taxonomy`, `funnel` |
| `src/server/services` | `ingest`, `outreach`, `inbox`, `conversions`, `dnc`, `merge`, `research`, `discovery`, `importer`, `metrics`, `insights`, `breakdowns`, `experiments`, `links`, `audit` |
| `src/server/adapters` | `instagram` (Graph API), `osm` (Overpass), `mock` (dev), `http` (rate-limited fetch), `registry` |
| `src/server/ai` | `providers` (Ollama, Groq, Gemini, Anthropic), `run` (validation/retry/fallback/logging), `facts`, `tasks/*` |
| `src/server/jobs` | `queue`, `worker`, `handlers` |
| `src/server/auth` | password hashing, sessions, roles, extension tokens, secret encryption |
| `src/app/(app)` | UI: overview, campaigns, prospects, discover, segments, outreach, inbox, follow-ups, analytics, experiments, integrations, settings, notifications |
| `src/app/api` | `v1/conversions` (webhook), `ext/*` (extension), `export/prospects`, `search`, `jobs/[id]`, `cron/worker`, `health` |
| `src/app/r/[code]` | Tracked-link redirector |
| `extension/` | Chrome/Edge MV3 extension that pre-fills DMs |
| `db/migrations` | SQL migrations |
| `tests/` | unit, integration, end-to-end workflow |
