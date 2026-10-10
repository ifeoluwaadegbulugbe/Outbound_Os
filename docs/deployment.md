# Deployment

The app is a standard Next.js server plus a Postgres database. It can stay **free**: run it on your own computer, or use free tiers.

## Option A — keep it local (free, simplest)

Set `ALLOW_PGLITE_IN_PRODUCTION=1` in `.env.local`, then `npm run build && npm start` on the machine you work from (or just keep using `npm run dev`). Data stays in `~/.outbound-os/` (outside the project, so the dev watcher ignores it). Back it up by copying `~/.outbound-os` while the app is stopped. Tracked links only work while the machine is reachable — for links that prospects click, use option B or C.

## Option B — single small server (free tiers / ~$0–5)

Any Node host that keeps a process running (a free VM, Render, Railway, Fly.io…):

1. Create a **new, separate** Postgres database (Supabase or Neon free tier). Do not reuse Orbit's project.
2. Set environment variables:
   ```
   DATABASE_URL=postgres://…        # Supabase pooler: add DB_PREPARE=false for port 6543
   ENCRYPTION_KEY=$(openssl rand -base64 32)
   APP_URL=https://outbound.yourdomain.com
   PRODUCT_SIGNUP_URL=https://app.getorbitcrm.com/signup
   CRON_SECRET=<random>
   NODE_ENV=production
   # Email (docs/email.md): OAuth clients for the mailboxes you send from
   GOOGLE_CLIENT_ID=…  GOOGLE_CLIENT_SECRET=…
   MS_CLIENT_ID=…      MS_CLIENT_SECRET=…
   ZEROBOUNCE_API_KEY=…   # optional
   ```
   Register `{APP_URL}/api/email/oauth/gmail/callback` and `{APP_URL}/api/email/oauth/microsoft/callback` as redirect URIs. The dev test mailbox is disabled in production unless `ENABLE_TEST_SINK=true`.
3. `npm ci && npm run db:migrate && npm run build && npm start`.
4. The in-process worker runs automatically (single instance): it runs jobs, sends queued emails every ~30s within each mailbox's limits, and polls connected mailboxes for replies/bounces every ~10 minutes. On serverless hosts call `/api/cron/worker` every minute instead.
5. Visit `/setup` to create the owner account.

**Row-level security role:** the first migration creates `ob_app` and grants it to the connecting user. If your provider forbids role creation, create it once as an admin:
```sql
create role ob_app nologin;
grant ob_app to <your_app_user>;
```
(Setting `DB_RLS_ROLE=` disables role switching — not recommended.)

## Option C — Vercel (serverless)

Vercel has no persistent disk and runs many short-lived instances, so the embedded database can't be used there (you'll see `DATABASE_URL is not set`). The long-running worker doesn't start on Vercel; scheduled work runs through a cron endpoint instead.

1. **Create a Postgres database** (free): [Neon](https://neon.tech) or [Supabase](https://supabase.com). Use a new project, separate from Orbit. Copy two connection strings:
   - the **pooled** one (Neon: "Pooled connection"; Supabase: transaction pooler, port 6543) → for Vercel
   - the **direct** one → for migrations and the one-time data copy
2. **Create the schema and copy your local data** (stop `npm run dev` first):
   ```
   TARGET_DATABASE_URL="<direct connection string>" npm run db:copy -- --dry   # counts only
   TARGET_DATABASE_URL="<direct connection string>" npm run db:copy           # migrations + full copy
   ```
   It runs all migrations on the new database, then copies every table (prospects, campaigns, emails, settings…) keeping ids. It refuses to write into a database that already has data.
3. **Vercel → Project → Settings → Environment Variables** (Production):
   ```
   DATABASE_URL=<pooled connection string>
   DB_PREPARE=false                       # needed for Supabase's transaction pooler (port 6543)
   ENCRYPTION_KEY=<the SAME value as in your .env.local>   # otherwise stored mailbox tokens/keys can't be decrypted
   APP_URL=https://<your-domain-or-vercel-url>
   CRON_SECRET=<long random string>
   PRODUCT_SIGNUP_URL=https://app.getorbitcrm.com/signup
   ENABLE_MOCK_SOURCES=false
   # optional: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, MS_CLIENT_ID / MS_CLIENT_SECRET, ZEROBOUNCE_API_KEY
   ```
   Then redeploy. Update the OAuth redirect URIs to `{APP_URL}/api/email/oauth/{gmail|microsoft}/callback`.
4. **Schedule the worker every minute** (queued emails, reply/bounce sync, follow-ups). Vercel Hobby crons run at most once a day, so use a free external scheduler such as [cron-job.org](https://cron-job.org):
   ```
   GET https://<your-app>/api/cron/worker
   Header: Authorization: Bearer <CRON_SECRET>
   ```
5. **Collection doesn't run on Vercel** (it downloads large map files and runs for hours). Run it from your own machine against the production database when you want more businesses:
   ```
   DATABASE_URL="<direct connection string>" npm run collect -- --countries NG --minutes 120
   ```

Note: Vercel's Hobby plan is for non-commercial use; use Pro for business use.

## Production checklist

- [ ] Separate database; `DATABASE_URL`, `ENCRYPTION_KEY`, `APP_URL`, `CRON_SECRET` set
- [ ] `npm run db:migrate` ran; `/api/health` returns `{"ok":true}`
- [ ] Owner created; teammates added with least-privilege roles
- [ ] Sender accounts and caps configured
- [ ] Webhook secret generated and given to Orbit
- [ ] Demo data **not** loaded (`ENABLE_MOCK_SOURCES=false`)
- [ ] Backups enabled on the database
- [ ] HTTPS only (session cookies are `Secure` in production)
