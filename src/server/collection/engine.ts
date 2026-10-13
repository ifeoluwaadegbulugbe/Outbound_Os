import { sql, json, withWorkspace, withSystem, type Q } from "../db";
import { ingestMany } from "../services/ingest";
import { getIcpConfig } from "../services/scoring-service";
import { findEmailsOnWebsite, type Fetcher } from "../email/finder";
import { verifyBasic, type Resolver } from "../email/verify";
import { safeFetch, recordSourceEmail } from "../email/enrich";
import { normalizeName, normalizeUrl } from "../domain/normalize";
import { COLLECTION_COUNTRIES, COUNTRY_BY_CC } from "./countries";
import { COLLECTION_SOURCES, type CollectionSource, type UnitSpec } from "./sources";

/**
 * The collection engine. Three persistent queues, all resumable after a
 * restart because their state lives in Postgres:
 *  1. collection_units — discovery work per source (tile / category / index page)
 *  2. the website-crawl queue — prospects.website_crawl_status / website_next_crawl_at
 *  3. the email-check queue — prospects with email_status 'unverified'
 * Units are claimed atomically (no two workers run the same unit), retried with
 * exponential backoff, and dead-lettered after maxAttempts. Each source has a
 * minimum interval between units. Nothing here sends email.
 */

export interface CollectionSettings {
  active: boolean;
  paused: boolean;
  target: number;
  countries: string[];
  sources: string[];
  autoExpand: boolean;
  crawl: boolean;
  /** Minimum share of all businesses for one country (default Nigeria 35%). Other countries' units wait while it's below. */
  countryShare: { cc: string; share: number } | null;
}

export const DEFAULT_COLLECTION: CollectionSettings = {
  active: false, paused: false, target: 100_000, countries: ["NG"], sources: ["overture", "overture_ext", "overture_names", "osm_country", "commoncrawl"], autoExpand: true, crawl: true,
  countryShare: { cc: "NG", share: 0.35 },
};

export async function getCollectionSettings(q: Q, workspaceId: string): Promise<CollectionSettings> {
  const s = await q.value<Record<string, unknown> | null>(sql`select settings->'collection' from workspaces where id = ${workspaceId}`);
  return { ...DEFAULT_COLLECTION, ...(s ?? {}) } as CollectionSettings;
}

export async function saveCollectionSettings(q: Q, workspaceId: string, patch: Partial<CollectionSettings>): Promise<CollectionSettings> {
  const cur = await getCollectionSettings(q, workspaceId);
  const next = { ...cur, ...patch };
  await q.exec(sql`update workspaces set settings = jsonb_set(settings, '{collection}', ${json(next)}) where id = ${workspaceId}`);
  return next;
}

/** Create units for countries × sources. Idempotent: existing units are left as they are. */
export async function planCollection(q: Q, workspaceId: string, countries: string[], sources: string[], registry = COLLECTION_SOURCES): Promise<number> {
  let added = 0;
  for (const cc of countries) {
    const c = COUNTRY_BY_CC.get(cc);
    if (!c) continue;
    for (const key of sources) {
      const src = registry[key];
      if (!src) continue;
      added += await insertUnits(q, workspaceId, src.plan(c));
    }
  }
  return added;
}

async function insertUnits(q: Q, workspaceId: string, units: UnitSpec[]): Promise<number> {
  let n = 0;
  for (const u of units) {
    const r = await q.maybe(sql`insert into collection_units (workspace_id, source, unit_key, country_code, category, params, priority)
      values (${workspaceId}, ${u.source}, ${u.unit_key}, ${u.country_code}, ${u.category ?? null}, ${json(u.params)}, ${u.priority})
      on conflict (workspace_id, source, unit_key) do nothing returning id`);
    if (r) n++;
  }
  return n;
}

export function backoffMs(attempts: number): number {
  return Math.min(6 * 3_600_000, 2 ** Math.max(0, attempts - 1) * 60_000);
}

type Claimed = { id: string; source: string; unit_key: string; params: Record<string, unknown>; country_code: string | null; attempts: number };

/** Atomically claim the next due unit, skipping sources still inside their minimum interval. */
export async function claimUnit(q: Q, workspaceId: string, allowed: string[], registry = COLLECTION_SOURCES, now = new Date(), onlyCountry: string | null = null): Promise<Claimed | null> {
  // Units left "running" by a crashed worker go back to the queue.
  await q.exec(sql`update collection_units set status = 'pending', locked_at = null where status = 'running' and locked_at < ${new Date(now.getTime() - 30 * 60_000)}`);
  const last = await q.many<{ source: string; at: Date }>(sql`select source, max(started_at) as at from collection_units where started_at is not null group by source`);
  const lastBy = new Map(last.map((r) => [r.source, new Date(r.at).getTime()]));
  const ready = allowed.filter((s) => registry[s] && (now.getTime() - (lastBy.get(s) ?? 0)) >= registry[s].minIntervalMs);
  if (!ready.length) return null;
  const candidates = await q.many<{ id: string }>(sql`
    select id from collection_units
    where status in ('pending','failed') and next_attempt_at <= ${now} and source = any(${`{${ready.join(",")}}`}::text[])
      ${onlyCountry ? sql`and country_code = ${onlyCountry}` : sql``}
    order by priority desc, attempts, created_at limit 5`);
  for (const c of candidates) {
    const r = await q.maybe<Claimed>(sql`update collection_units set status = 'running', locked_at = ${now}, started_at = ${now}, attempts = attempts + 1
      where id = ${c.id} and status in ('pending','failed') returning id, source, unit_key, params, country_code, attempts`);
    if (r) return r;
  }
  return null;
}

export interface TickResult { units: number; created: number; merged: number; failed: number; emails: number }

/** Run discovery units until the time budget is used. */
export async function runCollectTick(workspaceId: string, opts: { budgetMs?: number; maxUnits?: number; registry?: Record<string, CollectionSource>; log?: (m: string) => void; sources?: string[]; isOnline?: () => Promise<boolean> } = {}): Promise<TickResult> {
  const registry = opts.registry ?? COLLECTION_SOURCES;
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId }, fn);
  const settings = await run((q) => getCollectionSettings(q, workspaceId));
  const res: TickResult = { units: 0, created: 0, merged: 0, failed: 0, emails: 0 };
  if (settings.paused) return res;
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  const icp = await run((q) => getIcpConfig(q));
  while (Date.now() < deadline && res.units < (opts.maxUnits ?? 1000)) {
    // A per-source loop passes `sources`, so a slow, rate-limited source never holds up a fast one.
    const allowed = opts.sources ? settings.sources.filter((x) => opts.sources!.includes(x)) : settings.sources;
    if (!allowed.length) break;
    const onlyCountry = await run((q) => shareHold(q, settings));
    const unit = await run((q) => claimUnit(q, workspaceId, allowed, registry, new Date(), onlyCountry));
    if (!unit) {
      if (settings.autoExpand && (await maybeExpand(workspaceId, settings, registry))) continue;
      break;
    }
    const src = registry[unit.source];
    const started = Date.now();
    try {
      const out = await src.run(unit, { workspaceId });
      const counts = { created: 0, merged: 0, flagged: 0, skipped: 0 };
      // Save immediately, in small transactions, so a crash loses at most one batch.
      for (let i = 0; i < out.items.length; i += 100) {
        const r = await run(async (q) => {
          // Serialize ingestion per workspace so two sources can't both insert the same new business.
          await q.exec(sql`select pg_advisory_xact_lock(hashtext(${`ingest:${workspaceId}`}))`);
          return ingestMany(q, { workspaceId, actorType: "system" }, out.items.slice(i, i + 100), { icp });
        });
        // A record this source already gave us (e.g. a resumed unit) is a refresh, not a duplicate business.
        const refreshed = r.results.filter((x) => x.outcome === "merged" && x.reason === "Already discovered from this source").length;
        counts.created += r.counts.created;
        counts.merged += r.counts.merged - refreshed;
        counts.flagged += r.counts.flagged;
        counts.skipped += r.counts.skipped + r.counts.suppressed + refreshed;
        await maybeAnalyze(workspaceId, r.counts.created + r.counts.flagged);
      }
      const withEmail = out.items.filter((x) => x.email).length;
      const withWebsite = out.items.filter((x) => x.website).length;
      await run(async (q) => {
        if (out.spawn?.length) await insertUnits(q, workspaceId, out.spawn);
        await q.exec(sql`update collection_units set status = 'done', locked_at = null, finished_at = now(), found = ${out.items.length},
          created = ${counts.created + counts.flagged}, merged = ${counts.merged}, flagged = ${counts.flagged}, skipped = ${counts.skipped},
          with_email = ${withEmail}, with_website = ${withWebsite}, duration_ms = ${Date.now() - started}, diagnostic = ${out.diagnostic ?? null}, last_error = null
          where id = ${unit.id}`);
      });
      res.units++;
      res.created += counts.created + counts.flagged;
      res.merged += counts.merged;
      res.emails += withEmail;
      opts.log?.(`${unit.unit_key}: ${out.items.length} found, ${counts.created + counts.flagged} new, ${counts.merged} duplicates, ${withEmail} with email (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      // Our own connection is down: this isn't the source's fault. Don't spend an attempt; requeue and pause.
      if (/resolve hostname|ENOTFOUND|EAI_AGAIN|getaddrinfo|Timeout was reached|fetch failed|ECONNRESET|ENETUNREACH/i.test(msg) && !(await (opts.isOnline ?? networkUp)())) {
        await run((q) => q.exec(sql`update collection_units set status = 'pending', locked_at = null, attempts = greatest(attempts - 1, 0),
          next_attempt_at = now() + interval '2 minutes', last_error = ${`Network unreachable (not counted): ${msg.slice(0, 200)}`} where id = ${unit.id}`));
        opts.log?.("collect: network unreachable, pausing discovery");
        break;
      }
      const dead = unit.attempts >= src.maxAttempts;
      await run((q) => q.exec(sql`update collection_units set status = ${dead ? "dead" : "failed"}, locked_at = null, last_error = ${msg},
        duration_ms = ${Date.now() - started}, next_attempt_at = ${new Date(Date.now() + backoffMs(unit.attempts))} where id = ${unit.id}`));
      res.failed++;
      opts.log?.(`${unit.unit_key}: FAILED (attempt ${unit.attempts}${dead ? ", dead-lettered" : ""}) ${msg}`);
    }
  }
  return res;
}

// The embedded database has no autovacuum, so table statistics go stale as rows pour in and the
// planner stops using the trigram/phone indexes (inserts slowed from ~20 ms to ~240 ms). Refresh them.
let sinceAnalyze = 0;
let lastAnalyze = 0;
export async function maybeAnalyze(workspaceId: string, added: number): Promise<void> {
  sinceAnalyze += added;
  if (sinceAnalyze < 1000 && Date.now() - lastAnalyze < 15 * 60_000) return;
  if (sinceAnalyze === 0) return;
  sinceAnalyze = 0;
  lastAnalyze = Date.now();
  await withSystem((q) => q.exec(sql`analyze prospects`)).catch(() => {});
  await withSystem((q) => q.exec(sql`analyze prospect_sources`)).catch(() => {});
  await withSystem((q) => q.exec(sql`analyze prospect_contacts`)).catch(() => {});
}

/**
 * Country share: while the priority country (Nigeria) is below its share of
 * all businesses, only its units run. Once it has no work left, others resume
 * so the engine never idles.
 */
export async function shareHold(q: Q, settings: CollectionSettings): Promise<string | null> {
  const cs = settings.countryShare;
  if (!cs) return null;
  const r = await q.one<{ total: number; mine: number; open: number }>(sql`
    select count(*) filter (where merged_into is null and not is_demo and archived_at is null)::int as total,
      count(*) filter (where merged_into is null and not is_demo and archived_at is null and country = ${cs.cc})::int as mine,
      (select count(*)::int from collection_units where country_code = ${cs.cc} and status in ('pending','failed')) as open
    from prospects`);
  return r.total > 0 && r.mine / r.total < cs.share && r.open > 0 ? cs.cc : null;
}

/** Fill in the Nigerian state from coordinates for records that don't have a clean one. */
export async function backfillNgStates(workspaceId: string): Promise<number> {
  const { nigeriaStateAt, normalizeNgState, NG_STATES } = await import("./ng-states");
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId }, fn);
  const rows = await run((q) => q.many<{ id: string; lat: number | null; lng: number | null; state: string | null }>(sql`
    select id, lat, lng, state from prospects where country = 'NG' and merged_into is null and (state is null or not (state = any(${`{${NG_STATES.map((s) => `"${s}"`).join(",")}}`}::text[])))`));
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await run(async (q) => {
      for (const r of chunk) {
        const st = nigeriaStateAt(r.lat, r.lng) ?? normalizeNgState(r.state);
        if (st && st !== r.state) {
          await q.exec(sql`update prospects set state = ${st} where id = ${r.id}`);
          n++;
        }
      }
    });
  }
  return n;
}

/** When the planned countries are finished and the target isn't met, add the next country. */
async function maybeExpand(workspaceId: string, settings: CollectionSettings, registry: Record<string, CollectionSource>): Promise<boolean> {
  return withWorkspace({ workspaceId }, async (q) => {
    const open = await q.value<number>(sql`select count(*)::int from collection_units where status in ('pending','failed','running')`);
    if (open > 0) return false;
    const total = await q.value<number>(sql`select count(*)::int from prospects where merged_into is null and not is_demo`);
    if (total >= settings.target) return false;
    const next = COLLECTION_COUNTRIES.find((c) => !settings.countries.includes(c.cc));
    if (!next) return false;
    await saveCollectionSettings(q, workspaceId, { countries: [...settings.countries, next.cc] });
    const added = await planCollection(q, workspaceId, [next.cc], settings.sources, registry);
    return added > 0;
  });
}

// ── Website crawl queue ─────────────────────────────────────────────────────

const NOT_A_BUSINESS_SITE = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|wa\.me|whatsapp\.com|linktr\.ee|beacons\.ai|google\.com|goo\.gl|business\.site|g\.page|bit\.ly|selar\.co|paystack\.shop|bumpa\.shop|stan\.store|calendly\.com|fresha\.com|booksy\.com|jiji\.ng|vconnect\.com)$/i;

interface CrawlRow { id: string; website: string; email: string | null; name_from_domain: boolean; business_name: string; website_crawl_attempts: number }

/** Crawl queued websites for public emails, with bounded concurrency. */
export async function runCrawlTick(workspaceId: string, opts: { budgetMs?: number; batch?: number; concurrency?: number; fetcher?: Fetcher; resolver?: Resolver; log?: (m: string) => void; priorityCountry?: string; isOnline?: () => Promise<boolean> } = {}): Promise<{ crawled: number; found: number; errors: number }> {
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId }, fn);
  const settings = await run((q) => getCollectionSettings(q, workspaceId));
  const out = { crawled: 0, found: 0, errors: 0 };
  if (settings.paused || !settings.crawl) return out;
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  while (Date.now() < deadline) {
    // Lease a batch: pushing website_next_crawl_at forward is the lock.
    const rows = await run((q) => q.many<CrawlRow>(sql`
      with c as (
        select id from prospects
        where merged_into is null and website is not null and not do_not_contact
          and country = any(${`{${settings.countries.join(",")}}`}::text[])
          and (website_crawl_status is null or website_crawl_status = 'pending' or (website_crawl_status = 'error' and website_crawl_attempts < 3))
          and coalesce(website_next_crawl_at, '-infinity'::timestamptz) <= now()
        order by (email is null) desc, (country = ${opts.priorityCountry ?? "NG"}) desc, priority_score desc nulls last
        limit ${opts.batch ?? 24}
        for update skip locked)
      update prospects p set website_next_crawl_at = now() + interval '20 minutes' from c where p.id = c.id
      returning p.id, p.website, p.email, p.name_from_domain, p.business_name, p.website_crawl_attempts`));
    if (!rows.length) break;
    const online = opts.isOnline ?? networkUp;
    if (!(await online())) {
      opts.log?.("crawl: network unreachable, pausing the crawl");
      // Release the lease so these sites are retried shortly, with nothing recorded against them.
      await run((q) => q.exec(sql`update prospects set website_next_crawl_at = now() + interval '2 minutes' where id = any(${`{${rows.map((r) => r.id).join(",")}}`}::uuid[])`));
      break;
    }
    await pool(rows, opts.concurrency ?? 6, async (r) => {
      const res = await crawlOne(run, workspaceId, r, opts.fetcher ?? safeFetch, opts.resolver, online);
      out.crawled++;
      if (res === "found") out.found++;
      if (res === "error") out.errors++;
    });
    opts.log?.(`crawl: ${out.crawled} websites checked, ${out.found} with emails, ${out.errors} errors`);
  }
  return out;
}

/**
 * Is the internet reachable? A DNS failure only means "this site is dead" when
 * well-known hosts still resolve; otherwise it's our own network (an outage
 * once marked hundreds of live sites dead). Cached for 30 s.
 */
let netCheck: { ok: boolean; at: number } | null = null;
export async function networkUp(): Promise<boolean> {
  if (netCheck && Date.now() - netCheck.at < 30_000) return netCheck.ok;
  const { lookup } = await import("node:dns/promises");
  const probes = ["www.google.com", "www.cloudflare.com", "www.wikipedia.org"];
  const ok = (await Promise.all(probes.map((h) => lookup(h).then(() => true, () => false)))).some(Boolean);
  netCheck = { ok, at: Date.now() };
  return ok;
}

class NetworkDown extends Error {}

async function crawlOne(run: <T>(fn: (q: Q) => Promise<T>) => Promise<T>, workspaceId: string, r: CrawlRow, fetcher: Fetcher, resolver?: Resolver, online: () => Promise<boolean> = networkUp): Promise<"found" | "none" | "skipped" | "blocked" | "error"> {
  let host = "";
  try {
    host = new URL(r.website).hostname.replace(/^www\./, "");
  } catch {
    /* invalid URL */
  }
  if (!host || NOT_A_BUSINESS_SITE.test(host)) {
    await run((q) => q.exec(sql`update prospects set website_crawl_status = 'skipped', website_checked_at = now() where id = ${r.id}`));
    return "skipped";
  }
  const f = await findEmailsOnWebsite(r.website, fetcher);
  // The site refuses automated access (robots.txt, or 401/403): respect it, don't retry.
  const refused = !f.pagesFetched.length && /returned 40[13]\b/.test(f.error ?? "");
  const blocked = (!f.pagesFetched.length && f.blockedByRobots.length > 0) || refused;
  if (!f.pagesFetched.length && !blocked) {
    // If DNS failed because our own connection is down, record nothing about this site.
    if (/ENOTFOUND|ENODATA|EAI_AGAIN|getaddrinfo/i.test(f.error ?? "") && !(await online())) throw new NetworkDown("network unreachable");
    // Dead domains and permanently missing sites aren't retried; timeouts and 5xx are, with backoff.
    const permanent = /ENOTFOUND|returned 40[04]|returned 410|Invalid website URL|Private address|Social\/directory/i.test(f.error ?? "");
    const attempts = permanent ? 3 : r.website_crawl_attempts + 1;
    await run((q) => q.exec(sql`update prospects set website_crawl_status = 'error', website_crawl_attempts = ${attempts}, website_crawl_error = ${(f.error ?? "No page could be read").slice(0, 300)},
      website_next_crawl_at = ${new Date(Date.now() + backoffMs(attempts) * 60)}, website_checked_at = now() where id = ${r.id}`));
    return "error";
  }
  let primary: string | null = r.email;
  await run(async (q) => {
    if (r.name_from_domain && f.siteName) {
      await q.exec(sql`update prospects set business_name = ${f.siteName}, normalized_name = ${normalizeName(f.siteName) || f.siteName.toLowerCase()}, name_from_domain = false where id = ${r.id}`);
    }
    if (!primary && f.emails[0]) {
      primary = f.emails[0].email;
      await q.exec(sql`update prospects set email = ${primary} where id = ${r.id} and email is null`);
    }
    for (const e of f.emails) await recordSourceEmail(q, workspaceId, r.id, e.email, "website", e.sourceUrl, e.email === primary);
    await q.exec(sql`update prospects set website_crawl_status = ${blocked ? "blocked" : f.emails.length ? "ok" : "no_email"}, website_crawl_error = null,
      website_checked_at = now(), booking_url = coalesce(booking_url, ${normalizeUrl(f.bookingUrl)}), has_booking_link = case when ${Boolean(f.bookingUrl)} then true else has_booking_link end,
      instagram_handle = coalesce(instagram_handle, ${f.instagram}), tiktok_handle = coalesce(tiktok_handle, ${f.tiktok})
      where id = ${r.id}`);
  });
  if (f.emails.length && primary && !r.email) await checkEmail(run, r.id, primary, resolver);
  return blocked ? "blocked" : f.emails.length ? "found" : "none";
}

// ── Email check queue (free DNS check only; never ZeroBounce in bulk) ───────

async function checkEmail(run: <T>(fn: (q: Q) => Promise<T>) => Promise<T>, prospectId: string, email: string, resolver?: Resolver) {
  const v = await verifyBasic(email, resolver);
  await run(async (q) => {
    await q.exec(sql`update prospects set email_status = ${v.status}, email_verified_at = ${v.checkedAt},
      email_verification = ${json({ provider: v.provider, reason: v.reason, checks: v.checks })} where id = ${prospectId} and lower(email) = ${email.toLowerCase()}`);
    await q.exec(sql`update prospect_contacts set verification_status = ${v.status}, verified_at = ${v.checkedAt}, verification_provider = 'dns'
      where prospect_id = ${prospectId} and kind = 'email' and value = ${email.toLowerCase()}`);
  });
}

/** DNS-check emails found in source data (syntax, disposable, MX). Domains are cached, so gmail.com is checked once. */
export async function runEmailCheckTick(workspaceId: string, opts: { budgetMs?: number; batch?: number; concurrency?: number; resolver?: Resolver } = {}): Promise<number> {
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId }, fn);
  const settings = await run((q) => getCollectionSettings(q, workspaceId));
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  let n = 0;
  while (Date.now() < deadline) {
    const rows = await run((q) => q.many<{ id: string; email: string }>(sql`
      select id, email from prospects where merged_into is null and email is not null and email_status = 'unverified' and not is_demo
        and country = any(${`{${settings.countries.join(",")}}`}::text[])
      order by priority_score desc nulls last limit ${opts.batch ?? 200}`));
    if (!rows.length) break;
    await pool(rows, opts.concurrency ?? 10, async (r) => {
      await checkEmail(run, r.id, r.email, opts.resolver);
      n++;
    });
  }
  return n;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch {
        /* one failing site never blocks the rest; status is recorded inside fn */
      }
    }
  });
  await Promise.all(workers);
}
