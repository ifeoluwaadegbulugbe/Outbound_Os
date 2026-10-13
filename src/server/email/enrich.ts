import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sql, json, type Q } from "../db";
import { decryptSecret } from "../auth/crypto";
import { findEmailsOnWebsite, type Fetcher } from "./finder";
import { verifyEmail, type Resolver } from "./verify";
import { normalizeAddress, isRoleAddress } from "./address";
import { rescoreProspect } from "../services/scoring-service";
import { logEvent } from "../services/audit";
import type { Run } from "./providers";

/**
 * Email enrichment: find publicly listed emails on a prospect's own website,
 * verify them, and store each with its source URL and timestamps.
 */

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) return /^(::1|fc|fd|fe80)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** fetch that refuses private/internal destinations (imported data must not reach internal services). */
export const safeFetch: Fetcher = async (url, init) => {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs");
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Refusing to fetch a private network address");
  return fetch(url, init);
};

async function zeroBounceKey(run: Run): Promise<string | null> {
  if (process.env.ZEROBOUNCE_API_KEY) return process.env.ZEROBOUNCE_API_KEY;
  const row = await run((q) => q.maybe<{ secret_ciphertext: string | null; status: string }>(sql`select secret_ciphertext, status from integrations where key = 'zerobounce'`));
  return row?.secret_ciphertext && row.status === "connected" ? decryptSecret(row.secret_ciphertext) : null;
}

/** Verify a prospect's primary email and store the result (status + provider + timestamp + raw). */
export async function verifyAndStore(run: Run, workspaceId: string, prospectId: string, opts: { resolver?: Resolver } = {}) {
  const p = await run((q) => q.maybe<{ email: string | null }>(sql`select email from prospects where id = ${prospectId}`));
  if (!p?.email) {
    await run((q) => q.exec(sql`update prospects set email_status = 'none' where id = ${prospectId}`));
    return null;
  }
  const r = await verifyEmail(p.email, { zeroBounceKey: await zeroBounceKey(run), resolver: opts.resolver });
  await run(async (q) => {
    await q.exec(sql`update prospects set email_status = ${r.status}, email_verified_at = ${r.checkedAt},
      email_verification = ${json({ provider: r.provider, reason: r.reason, checks: r.checks })} where id = ${prospectId}`);
    await q.exec(sql`update prospect_contacts set verification_status = ${r.status}, verified_at = ${r.checkedAt}, verification_provider = ${r.provider},
      verification_raw = ${json(r.raw ?? { reason: r.reason, checks: r.checks })} where prospect_id = ${prospectId} and kind = 'email' and value = ${p.email!.toLowerCase()}`);
    if (r.provider === "zerobounce") await q.exec(sql`update integrations set last_success_at = now() where key = 'zerobounce'`);
  });
  return r;
}

export interface EnrichResult {
  outcome: "found" | "already_had" | "none_found" | "no_website" | "error";
  email?: string;
  detail?: string;
}

/** Find emails on the website (if needed), store all with provenance, verify the primary. */
export async function enrichProspectEmail(run: Run, workspaceId: string, prospectId: string, opts: { fetcher?: Fetcher; resolver?: Resolver; force?: boolean } = {}): Promise<EnrichResult> {
  const p = await run((q) => q.maybe<{ email: string | null; website: string | null; email_status: string; booking_url: string | null }>(
    sql`select email, website, email_status, booking_url from prospects where id = ${prospectId}`));
  if (!p) return { outcome: "error", detail: "Prospect not found" };
  if (p.email && !opts.force) {
    if (p.email_status === "unverified") await verifyAndStore(run, workspaceId, prospectId, opts);
    return { outcome: "already_had", email: p.email };
  }
  if (!p.website) {
    await run((q) => q.exec(sql`update prospects set email_status = case when email is null then 'none' else email_status end where id = ${prospectId}`));
    return { outcome: "no_website" };
  }
  const found = await findEmailsOnWebsite(p.website, opts.fetcher ?? safeFetch);
  const now = new Date();
  await run(async (q) => {
    await q.exec(sql`update prospects set website_checked_at = ${now}, last_researched_at = ${now},
      booking_url = coalesce(booking_url, ${found.bookingUrl}), has_booking_link = case when ${Boolean(found.bookingUrl)} then true else has_booking_link end,
      instagram_handle = coalesce(instagram_handle, ${found.instagram}), tiktok_handle = coalesce(tiktok_handle, ${found.tiktok})
      where id = ${prospectId}`);
    for (const [i, f] of found.emails.entries()) {
      await q.exec(sql`insert into prospect_contacts (workspace_id, prospect_id, kind, value, is_primary, is_role, source, source_url, discovered_at, verification_status)
        values (${workspaceId}, ${prospectId}, 'email', ${f.email}, ${i === 0 && !p.email}, ${f.isRole}, 'website', ${f.sourceUrl}, ${now}, 'unverified')
        on conflict (prospect_id, kind, value) do nothing`);
    }
    if (found.emails[0] && !p.email) {
      const best = found.emails[0];
      await q.exec(sql`update prospects set email = ${best.email}, email_status = 'unverified', email_source = 'website', email_source_url = ${best.sourceUrl},
        email_discovered_at = ${now} where id = ${prospectId}`);
      await logEvent(q, { workspaceId, actorType: "system" }, { type: "email.found", prospectId, data: { email: best.email, sourceUrl: best.sourceUrl } });
    } else if (!found.emails.length && !p.email) {
      await q.exec(sql`update prospects set email_status = 'none' where id = ${prospectId}`);
    }
  });
  if (found.emails[0] && !p.email) {
    await verifyAndStore(run, workspaceId, prospectId, opts);
    await run((q) => rescoreProspect(q, prospectId));
    return { outcome: "found", email: found.emails[0].email };
  }
  if (found.error) return { outcome: "error", detail: found.error };
  return { outcome: "none_found", detail: found.blockedByRobots.length ? "Contact pages disallowed by robots.txt" : `Checked ${found.pagesFetched.length} page(s)` };
}

/** Record an email that came with a source record (OSM/CSV/manual) with its provenance. */
export async function recordSourceEmail(q: Q, workspaceId: string, prospectId: string, email: string, source: string, sourceUrl: string | null, isPrimary = true): Promise<void> {
  const e = normalizeAddress(email);
  if (!e) return;
  await q.exec(sql`insert into prospect_contacts (workspace_id, prospect_id, kind, value, is_primary, is_role, source, source_url, verification_status)
    values (${workspaceId}, ${prospectId}, 'email', ${e}, ${isPrimary}, ${isRoleAddress(e)}, ${source}, ${sourceUrl}, 'unverified') on conflict do nothing`);
  await q.exec(sql`update prospects set email_source = coalesce(email_source, ${source}), email_source_url = coalesce(email_source_url, ${sourceUrl}),
    email_discovered_at = coalesce(email_discovered_at, now()), email_status = case when email_status = 'none' then 'unverified' else email_status end
    where id = ${prospectId} and lower(email) = ${e}`);
}
