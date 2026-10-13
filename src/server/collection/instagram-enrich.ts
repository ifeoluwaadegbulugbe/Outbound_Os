import { sql, withWorkspace, type Q } from "../db";
import { loadConfig, graph, type BusinessDiscovery } from "../adapters/instagram";
import { extractEmails } from "../email/address";
import { recordSourceEmail } from "../email/enrich";
import { normalizeUrl, domainOf } from "../domain/normalize";

/**
 * Instagram email enrichment through Meta's official Graph API (Business
 * Discovery), never by scraping. For businesses we already know the
 * Instagram handle of but have no email for, read the public business
 * profile (bio and website) and keep any email the owner published in the
 * bio, with the profile URL as evidence. A website found there goes into the
 * website-crawl queue. Rate-limited to the connected account's quota
 * (Integrations → Instagram, default 180 calls/hour).
 */

export async function instagramConnected(workspaceId: string): Promise<boolean> {
  return withWorkspace({ workspaceId }, async (q) =>
    Boolean(await q.value<boolean>(sql`select status = 'connected' and secret_ciphertext is not null from integrations where key = 'instagram_graph'`)));
}

export async function runInstagramEnrichTick(workspaceId: string, opts: { budgetMs?: number; batch?: number; countries?: string[]; log?: (m: string) => void } = {}): Promise<{ checked: number; emails: number; websites: number; tiktoks: number }> {
  const out = { checked: 0, emails: 0, websites: 0, tiktoks: 0 };
  if (!(await instagramConnected(workspaceId))) return out;
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId }, fn);
  const ctx = { workspaceId, ws: run, progress: async () => true, log: async () => {} };
  const cfg = await loadConfig(ctx);
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  const countries = opts.countries ?? ["NG"];
  while (Date.now() < deadline) {
    const rows = await run((q) => q.many<{ id: string; instagram_handle: string; website: string | null }>(sql`
      select id, instagram_handle, website from prospects
      where merged_into is null and archived_at is null and not is_demo and not do_not_contact and instagram_handle is not null
        and (instagram_checked_at is null or instagram_checked_at < now() - interval '90 days')
        and country = any(${`{${countries.join(",")}}`}::text[])
      order by (email is null) desc, (country = 'NG') desc, priority_score desc nulls last limit ${opts.batch ?? 20}`));
    if (!rows.length) break;
    for (const r of rows) {
      if (Date.now() >= deadline) break;
      const handle = r.instagram_handle.replace(/[^a-z0-9._]/gi, "");
      let bd: BusinessDiscovery["business_discovery"] | null = null;
      try {
        const res = await graph<BusinessDiscovery>(ctx, cfg, cfg.igUserId, { fields: `business_discovery.username(${handle}){username,name,biography,website}` });
        bd = res.business_discovery ?? null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/rate|limit|throttl|#4\b|#17\b|#32\b|#613\b/i.test(msg)) {
          opts.log?.(`instagram: rate limit reached, pausing (${msg.slice(0, 120)})`);
          return out;
        }
        // The app or token isn't allowed to call Business Discovery, so every lookup would fail:
        // stop without marking anything checked.
        if (/\(#(10|190|200)\)/.test(msg)) {
          opts.log?.(`instagram: not permitted by Meta, stopping (${msg.replace(/access_token=[^&\s]+/g, "access_token=REDACTED").slice(0, 160)})`);
          throw new Error(`Instagram lookup not permitted by Meta: ${msg.replace(/access_token=[^&\s]+/g, "access_token=REDACTED").slice(0, 200)}`);
        }
        // Personal (non-business) accounts and unknown handles aren't available through the API: mark and move on.
      }
      const profileUrl = `https://www.instagram.com/${handle}/`;
      await run(async (q) => {
        const emails = bd?.biography ? extractEmails(bd.biography).map((e) => e.email) : [];
        if (emails[0]) {
          await q.exec(sql`update prospects set email = ${emails[0]} where id = ${r.id} and email is null`);
          for (const [i, e] of emails.entries()) await recordSourceEmail(q, workspaceId, r.id, e, "instagram_bio", profileUrl, i === 0);
          out.emails++;
        }
        const tiktok = tiktokFromBio(`${bd?.biography ?? ""} ${bd?.website ?? ""}`);
        if (tiktok) {
          const set = await q.maybe(sql`update prospects set tiktok_handle = ${tiktok} where id = ${r.id} and tiktok_handle is null returning id`);
          if (set) out.tiktoks++;
        }
        const site = normalizeUrl(bd?.website ?? null);
        if (site && !r.website && !/instagram\.com|linktr\.ee|facebook\.com|wa\.me/i.test(site)) {
          await q.exec(sql`update prospects set website = ${site}, website_domain = ${domainOf(site)}, website_crawl_status = null where id = ${r.id} and website is null`);
          out.websites++;
        }
        await q.exec(sql`update prospects set instagram_checked_at = now() where id = ${r.id}`);
      });
      out.checked++;
    }
    opts.log?.(`instagram: ${out.checked} profiles read · ${out.emails} emails from bios · ${out.websites} new websites · ${out.tiktoks} TikTok handles`);
  }
  return out;
}

/** A TikTok handle the owner put in their bio or link: "tiktok.com/@x", "TikTok: @x", "TT - @x". */
export function tiktokFromBio(text: string): string | null {
  const m = /tiktok\.com\/@([a-z0-9._]{2,24})/i.exec(text) ?? /\b(?:tiktok|tik tok|tt)\s*[:\-–|]?\s*@([a-z0-9._]{2,24})/i.exec(text);
  return m ? m[1].replace(/\.+$/, "").toLowerCase() : null;
}
