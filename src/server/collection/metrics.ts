import { sql, type Q } from "../db";

/**
 * Collection progress, computed from the database. Business counts and email
 * counts are separate numbers: one business with three emails is one
 * business; a guessed address is never stored, so never counted. Demo and
 * merged (duplicate) records are excluded from every business count.
 */

export interface CollectionMetrics {
  businesses: number;
  withWebsite: number;
  withEmail: number;
  emailAddresses: number;
  email: {
    publiclyFound: number;
    syntaxValid: number;
    domainMxPresent: number;
    deliverabilityUnknown: number;
    catchAllOrUncertain: number;
    invalid: number;
    verified: number;
    notCheckedYet: number;
    noPublicEmailFound: number;
    suppressed: number;
    needsReview: number;
  };
  eligibleForOutreach: number;
  duplicatesRemoved: number;
  crawl: { pending: number; ok: number; noEmail: number; blocked: number; error: number; deadDomain: number; skipped: number };
  units: { pending: number; running: number; done: number; failed: number; dead: number };
  bySource: { source: string; businesses: number; with_email: number; with_website: number }[];
  byCountry: { country: string; businesses: number; with_email: number; with_website: number }[];
  byCity: { city: string; country: string | null; businesses: number; with_email: number }[];
  ngStates: { state: string; businesses: number; with_email: number }[];
  instagram: { pool: number; checked: number; emails: number };
  ngShare: number;
  byCategory: { category: string; businesses: number; with_email: number }[];
  unitYield: { source: string; units: number; done: number; found: number; created: number; merged: number; with_email: number; failed: number; dead: number; avg_secs: number | null }[];
  perHour: { hour: string; created: number }[];
  recentErrors: { unit_key: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date }[];
  zeroYield: { unit_key: string; diagnostic: string | null }[];
}

const LIVE = sql`p.merged_into is null and not p.is_demo and p.archived_at is null`;

export async function collectionMetrics(q: Q): Promise<CollectionMetrics> {
  const t = await q.one<{
    businesses: number; with_website: number; with_email: number; syntax_valid: number; mx: number; unknown: number; uncertain: number; invalid: number;
    verified: number; unchecked: number; no_email: number; suppressed: number; eligible: number; duplicates: number;
    c_pending: number; c_ok: number; c_none: number; c_blocked: number; c_error: number; c_dead: number; c_skipped: number;
  }>(sql`
    select
      count(*) filter (where ${LIVE})::int as businesses,
      count(*) filter (where ${LIVE} and p.website is not null)::int as with_website,
      count(*) filter (where ${LIVE} and p.email is not null)::int as with_email,
      count(*) filter (where ${LIVE} and p.email is not null and p.email_status <> 'invalid')::int as syntax_valid,
      count(*) filter (where ${LIVE} and p.email is not null and (p.email_verification->'checks'->>'mx') = 'true')::int as mx,
      count(*) filter (where ${LIVE} and p.email_status = 'unknown')::int as unknown,
      count(*) filter (where ${LIVE} and p.email_status in ('catch_all','risky'))::int as uncertain,
      count(*) filter (where ${LIVE} and (p.email_status = 'invalid' or p.bounced))::int as invalid,
      count(*) filter (where ${LIVE} and p.email_status = 'verified')::int as verified,
      count(*) filter (where ${LIVE} and p.email is not null and p.email_status = 'unverified')::int as unchecked,
      count(*) filter (where ${LIVE} and p.email is null and (p.website is null or p.website_crawl_status in ('no_email','blocked','skipped')))::int as no_email,
      count(*) filter (where ${LIVE} and (p.do_not_contact or p.unsubscribed))::int as suppressed,
      count(*) filter (where ${LIVE} and p.email is not null and p.email_status in ('verified','unknown','catch_all') and not p.do_not_contact and not p.unsubscribed and not p.bounced
        and coalesce(p.country, 'NG') in (select country_code from country_policies where cold_email = 'allowed'))::int as eligible,
      count(*) filter (where p.merged_into is not null)::int as duplicates,
      count(*) filter (where ${LIVE} and p.website is not null and (p.website_crawl_status is null or p.website_crawl_status = 'pending'))::int as c_pending,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'ok')::int as c_ok,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'no_email')::int as c_none,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'blocked')::int as c_blocked,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'error' and coalesce(p.website_crawl_error, '') !~* 'ENOTFOUND|ENODATA')::int as c_error,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'error' and p.website_crawl_error ~* 'ENOTFOUND|ENODATA')::int as c_dead,
      count(*) filter (where ${LIVE} and p.website_crawl_status = 'skipped')::int as c_skipped
    from prospects p`);
  const emails = await q.value<number>(sql`select count(distinct c.value)::int from prospect_contacts c join prospects p on p.id = c.prospect_id where c.kind = 'email' and ${LIVE}`);
  // The same address on several businesses (a shared agency inbox, a mall's front desk…) needs a human before outreach.
  const shared = await q.value<number>(sql`select coalesce(sum(n), 0)::int from (select count(*) as n from prospects p where ${LIVE} and p.email is not null group by lower(p.email) having count(*) > 1) s`);
  const mergedDuring = await q.value<number>(sql`select coalesce(sum(merged), 0)::int from collection_units`);
  const units = await q.one<{ pending: number; running: number; done: number; failed: number; dead: number }>(sql`
    select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'done')::int as done, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'dead')::int as dead
    from collection_units`);
  const bySource = await q.many<CollectionMetrics["bySource"][number]>(sql`
    select p.source, count(*)::int as businesses, count(*) filter (where p.email is not null)::int as with_email, count(*) filter (where p.website is not null)::int as with_website
    from prospects p where ${LIVE} group by 1 order by 2 desc`);
  const byCountry = await q.many<CollectionMetrics["byCountry"][number]>(sql`
    select coalesce(p.country, '—') as country, count(*)::int as businesses, count(*) filter (where p.email is not null)::int as with_email,
      count(*) filter (where p.website is not null)::int as with_website
    from prospects p where ${LIVE} group by 1 order by 2 desc`);
  const byCity = await q.many<CollectionMetrics["byCity"][number]>(sql`
    select coalesce(initcap(p.city), '(no city)') as city, max(p.country) as country, count(*)::int as businesses, count(*) filter (where p.email is not null)::int as with_email
    from prospects p where ${LIVE} group by 1 order by 3 desc limit 25`);
  const instagram = await q.one<{ pool: number; checked: number; emails: number }>(sql`
    select count(*) filter (where ${LIVE} and p.instagram_handle is not null and p.email is null and p.instagram_checked_at is null)::int as pool,
      count(*) filter (where ${LIVE} and p.instagram_checked_at is not null)::int as checked,
      count(*) filter (where ${LIVE} and p.email_source = 'instagram_bio')::int as emails
    from prospects p`);
  const { NG_STATES } = await import("./ng-states");
  const ngRows = await q.many<{ state: string; businesses: number; with_email: number }>(sql`
    select coalesce(p.state, '(unknown)') as state, count(*)::int as businesses, count(*) filter (where p.email is not null)::int as with_email
    from prospects p where ${LIVE} and p.country = 'NG' group by 1`);
  // Every state is listed, including those with no businesses yet, so gaps are visible.
  const ngStates = [...NG_STATES.map((s) => ngRows.find((r) => r.state === s) ?? { state: s, businesses: 0, with_email: 0 }),
    ...ngRows.filter((r) => !(NG_STATES as readonly string[]).includes(r.state))].sort((a, b) => b.businesses - a.businesses);
  const byCategory = await q.many<CollectionMetrics["byCategory"][number]>(sql`
    select coalesce(p.category, 'other_service') as category, count(*)::int as businesses, count(*) filter (where p.email is not null)::int as with_email
    from prospects p where ${LIVE} group by 1 order by 2 desc`);
  const unitYield = await q.many<CollectionMetrics["unitYield"][number]>(sql`
    select source, count(*)::int as units, count(*) filter (where status = 'done')::int as done, coalesce(sum(found), 0)::int as found,
      coalesce(sum(created), 0)::int as created, coalesce(sum(merged), 0)::int as merged, coalesce(sum(with_email), 0)::int as with_email,
      count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'dead')::int as dead,
      round(avg(duration_ms) filter (where status = 'done') / 1000.0, 1)::float8 as avg_secs
    from collection_units group by 1 order by 1`);
  const perHour = await q.many<{ hour: string; created: number }>(sql`
    select to_char(date_trunc('hour', p.discovered_at), 'YYYY-MM-DD HH24:00') as hour, count(*)::int as created
    from prospects p where ${LIVE} and p.discovered_at > now() - interval '48 hours' group by 1 order by 1 desc limit 48`);
  const recentErrors = await q.many<CollectionMetrics["recentErrors"][number]>(sql`
    select unit_key, status, attempts, last_error, next_attempt_at from collection_units where status in ('failed','dead') order by next_attempt_at desc limit 15`);
  const zeroYield = await q.many<CollectionMetrics["zeroYield"][number]>(sql`
    select unit_key, diagnostic from collection_units where status = 'done' and found = 0 order by finished_at desc limit 10`);
  return {
    businesses: t.businesses, withWebsite: t.with_website, withEmail: t.with_email, emailAddresses: emails,
    email: {
      publiclyFound: t.with_email, syntaxValid: t.syntax_valid, domainMxPresent: t.mx, deliverabilityUnknown: t.unknown, catchAllOrUncertain: t.uncertain,
      invalid: t.invalid, verified: t.verified, notCheckedYet: t.unchecked, noPublicEmailFound: t.no_email, suppressed: t.suppressed, needsReview: shared,
    },
    eligibleForOutreach: t.eligible,
    duplicatesRemoved: Math.max(t.duplicates, 0) + mergedDuring,
    crawl: { pending: t.c_pending, ok: t.c_ok, noEmail: t.c_none, blocked: t.c_blocked, error: t.c_error, deadDomain: t.c_dead, skipped: t.c_skipped },
    units, bySource, byCountry, byCity, ngStates, instagram, ngShare: t.businesses ? (byCountry.find((c) => c.country === "NG")?.businesses ?? 0) / t.businesses : 0, byCategory, unitYield, perHour, recentErrors, zeroYield,
  };
}
