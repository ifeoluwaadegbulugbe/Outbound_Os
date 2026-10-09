# Setup (local)

Requirements: Node.js 20.12+ (tested on 24). Nothing else — the database is embedded.

```bash
cd outbound_system
npm install
cp .env.example .env.local     # optional; every value has a working default
npm run db:seed                # optional: dev owner (SEED_OWNER_* in .env.local) + demo data
npm run dev                    # http://localhost:3100
```

- **First run without seed:** you'll see *Set up your workspace* — create the owner account there.
- **Demo data:** 1,000+ fictional businesses with simulated outreach history so every screen has numbers. Handles end in `.demo`, phones are non-mobile, links never open. Load or remove it in Settings → Demo data.
- **Embedded DB:** lives in `~/.outbound-os/pglite`. Only one process may open it — `db:seed`/`db:reset` refuse while the dev server is running (use the in-app Demo data page instead). `npm run db:reset` wipes it.
- **Background jobs** (discovery, imports, drafting, follow-ups, analytics) run inside the dev server automatically.

## Email (primary channel)

1. **Settings → Email & sender**: your name, business name and postal address (required in every email footer).
2. **Data Sources → Sending accounts**: in development click **Add test mailbox (dev)** to try the whole flow without delivering anything. To send for real, create a free Google or Microsoft OAuth client ([docs/email.md](email.md)), add the keys to `.env.local`, restart, then **Connect Gmail** / **Connect Outlook**.
3. **Settings → Country rules**: review before emailing outside Nigeria.
4. **Discover Businesses**: pick a country, cities and categories, and tick “look for public emails on each website”.
5. **Email Prospects** → select → **Generate email drafts** → **Send Queue** → open the composer → **Send test** → **Send**.

## Optional: free AI

The app works without AI (templates + rules). For AI drafts and briefs, add one of these to `.env.local` and restart:

```bash
# Local and free (Ollama is already installed on this machine):
#   ollama pull llama3.1:8b
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b

# or Groq free tier
GROQ_API_KEY=...
```

## Connect real sources

- **Instagram:** Integrations → Connect Instagram (see `docs/integrations.md` §1).
- **Browser extension:** Integrations → Browser extension (see §4).
- **Orbit signups:** Integrations → Orbit conversion webhook (see §5).

## Tests

```bash
npm test          # 47 tests: domain units, RLS isolation, ingestion, full acceptance workflow
npm run typecheck
```

Tests run against a fresh in-memory Postgres per file, with AI disabled (deterministic).
