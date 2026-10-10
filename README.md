# Outbound OS

An internal acquisition engine for **Orbit**: find service businesses across Africa (Nigeria first), find their public business email, draft a personal email for each, and turn replies into active Orbit users. **Email is the primary channel**; Instagram, TikTok and WhatsApp remain as assisted channels. A human reviews every message by default.

> North star: **qualified prospects → activated Orbit users**, not messages sent.

It is a **standalone system** — its own app, database, auth and deploy. Orbit is an external product it reports conversions from.

## Quick start (zero config, free)

```bash
cd outbound_system
npm install
npm run db:seed     # optional: owner account + 1,000+ fictional demo prospects
npm run dev         # http://localhost:3100
```

Without `db:seed`, the first visit shows a setup screen to create your workspace and owner account. The seeded owner's credentials are in `.env.local` (`SEED_OWNER_*`).

Everything runs locally on an embedded Postgres (PGlite) in `~/.outbound-os/` (outside the project, so the dev watcher ignores it). No Docker, no API keys, no paid services.

## What it does

| Area | What you get |
|---|---|
| **Email** | Send from your own Gmail/Outlook via OAuth (no passwords stored), composer with edit/regenerate/test/send, paced send queue with per-account caps, warm-up, send windows, automatic safety pause on bounces/complaints, reply/bounce/out-of-office detection, one-click unsubscribe, country compliance rules |
| **Find emails** | Public emails from business websites (robots.txt respected, source URL recorded), DNS verification, optional ZeroBounce. Never guessed |
| **Collection engine** | Multi-source, resumable collection toward 100k African service businesses: Overture Maps Places (open data incl. public business emails), OpenStreetMap country-wide, Common Crawl website discovery, a persistent website-crawl queue and DNS email checks. Live dashboard at Collection Progress; `npm run collect` for unattended runs |
| **Discover** | Resumable (pause/resume/cancel, checkpointed) OpenStreetMap discovery across African cities and custom categories, Instagram (official Graph API: hashtags → mentions → Business Discovery), OpenStreetMap, CSV/Foursquare open data, one-click capture while browsing |
| **Qualify** | Deduplication (merge only on exact identity; fuzzy matches go to review), transparent 0–100 ICP score with a reason for every point, priority, data completeness |
| **Research** | AI brief grounded in cited facts; inferences labelled; unknowns listed |
| **Outreach** | AI or template drafts per prospect, A/B/C/D variants, a safety validator that blocks bad messages with reasons, review queue, keyboard-driven send session, browser extension that pre-fills Instagram/TikTok DMs, daily caps & warm-up per sender account |
| **Follow-ups** | Day 3/7/14 sequence, drafted automatically, stopped by any reply, conversion or opt-out |
| **Inbox** | Paste replies → classified (opt-outs by deterministic rules), AI reply suggestions, do-not-contact enforcement |
| **Attribution** | Tracked links (`/r/<code>`) + signed webhook from Orbit → signup / activated / paid matched to prospects |
| **Learn** | Email funnel (discovered → email found → verified → sent → delivered → replied → signed up → activated → paid), delivery/bounce/reply/unsubscribe rates, cost per activated/paid, results by country, funnel, rates by category/city/channel/variant, experiments with significance tests, insights computed from data |

## What it deliberately does not do

No scraping, no stealth automation, no fake accounts, no automatic sending on platforms that don't permit it. See [docs/integration-feasibility.md](docs/integration-feasibility.md) and [docs/outreach-compliance.md](docs/outreach-compliance.md).

## Docs

- [Setup](docs/setup.md) · [Deployment](docs/deployment.md)
- [Email: connecting Gmail/Outlook, limits, SPF/DKIM/DMARC](docs/email.md) · [Data sources: coverage and costs](docs/data-sources.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md) · [AI system](docs/ai-system.md)
- [Integrations (how to connect Instagram, Orbit, the extension)](docs/integrations.md) · [Feasibility audit](docs/integration-feasibility.md)
- [Outreach compliance](docs/outreach-compliance.md) · [Roadmap](docs/roadmap.md)

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | App + in-process job worker on :3100 |
| `npm test` | Unit + integration + end-to-end workflow tests (real embedded Postgres) |
| `npm run typecheck` | TypeScript |
| `npm run db:migrate` | Apply migrations (production) |
| `npm run db:seed` | Dev owner + demo data (refuses in production) |
| `npm run db:reset` | Delete the embedded dev database |
| `npm run collect` | Long-running collector (`--countries NG,GH --minutes 120`, `--status`). Resumes where it stopped |
| `npm run worker` | Standalone job worker (production with `DATABASE_URL`) |
