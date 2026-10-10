import Papa from "papaparse";
import { sql, json } from "../db";
import type { JobContext } from "../jobs/worker";
import type { NormalizedProspect } from "../adapters/types";
import { ingestMany, prepare, type IngestOutcome } from "./ingest";
import { getIcpConfig } from "./scoring-service";
import { compareProspects } from "../domain/dedup";
import { notify } from "./audit";
import { CATEGORIES, type CategoryKey } from "../domain/taxonomy";
import type { Q } from "../db";

/**
 * CSV import: auto-map columns → preview with duplicate detection → import
 * as a background job through the same ingestion pipeline as discovery.
 */

export const TARGET_FIELDS = [
  "business_name", "owner_name", "category", "description", "bio", "city", "state", "area", "country", "instagram", "tiktok", "facebook",
  "linkedin", "email", "phone", "whatsapp", "website", "booking_url", "followers", "last_post_date", "external_id", "source_url",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];
export type Mapping = Partial<Record<TargetField, string>>;

const SYNONYMS: Record<TargetField, string[]> = {
  business_name: ["business_name", "business", "name", "company", "brand", "business name", "store", "shop", "account name", "full_name"],
  owner_name: ["owner", "owner_name", "contact", "contact name", "contact_name", "person"],
  category: ["category", "categories", "type", "business type", "niche", "service", "fsq_category_labels", "industry"],
  description: ["description", "about", "notes", "summary"],
  bio: ["bio", "biography", "instagram bio", "profile bio"],
  city: ["city", "town", "location", "locality", "lga"],
  state: ["state", "region", "province"],
  area: ["area", "neighbourhood", "neighborhood", "suburb", "district", "address"],
  country: ["country", "country_code"],
  instagram: ["instagram", "ig", "instagram_handle", "instagram handle", "insta", "instagram url", "instagram_url"],
  tiktok: ["tiktok", "tiktok_handle", "tiktok handle", "tiktok url"],
  facebook: ["facebook", "facebook_url", "fb", "facebook_id"],
  linkedin: ["linkedin", "linkedin_url"],
  email: ["email", "e-mail", "email address", "mail"],
  phone: ["phone", "phone number", "tel", "telephone", "mobile", "tel_number", "phone_number"],
  whatsapp: ["whatsapp", "whatsapp number", "wa"],
  website: ["website", "url", "site", "web", "homepage"],
  booking_url: ["booking", "booking link", "booking_url", "book", "calendly"],
  followers: ["followers", "follower_count", "followers_count", "follower count"],
  last_post_date: ["last_post", "last post", "last_post_date", "last posted"],
  external_id: ["id", "external_id", "fsq_place_id", "place_id"],
  source_url: ["source_url", "profile url", "link"],
};

export const PRESETS: Record<string, { label: string; mapping: Mapping; source: string; note: string }> = {
  generic: { label: "Generic CSV", mapping: {}, source: "csv", note: "Columns are matched automatically." },
  foursquare_os: {
    label: "Foursquare Open Source Places",
    mapping: { business_name: "name", category: "fsq_category_labels", city: "locality", state: "region", area: "address", country: "country", phone: "tel", website: "website", email: "email", instagram: "instagram", facebook: "facebook_id", external_id: "fsq_place_id" },
    source: "foursquare_os",
    note: "Apache 2.0 — keep the NOTICE attribution. Filter to Nigeria first (see docs/integrations.md).",
  },
};

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; errors: string[] } {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  return {
    headers: res.meta.fields ?? [],
    rows: res.data.slice(0, 50_000),
    errors: res.errors.slice(0, 10).map((e) => `Row ${(e.row ?? 0) + 2}: ${e.message}`),
  };
}

export function autoMap(headers: string[], preset?: string): Mapping {
  const base = PRESETS[preset ?? "generic"]?.mapping ?? {};
  const mapping: Mapping = {};
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const field of TARGET_FIELDS) {
    const presetCol = base[field];
    if (presetCol && headers.includes(presetCol)) {
      mapping[field] = presetCol;
      continue;
    }
    const idx = lower.findIndex((h) => SYNONYMS[field].includes(h));
    if (idx >= 0 && !Object.values(mapping).includes(headers[idx])) mapping[field] = headers[idx];
  }
  return mapping;
}

function mapCategory(raw: string | undefined): CategoryKey | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if ((CATEGORIES.map((c) => c.key) as string[]).includes(t)) return t as CategoryKey;
  let best: { key: CategoryKey; hits: number } | null = null;
  for (const c of CATEGORIES) {
    const hits = c.keywords.filter((k) => t.includes(k)).length;
    if (hits && (!best || hits > best.hits)) best = { key: c.key, hits };
  }
  if (/barber/.test(t)) return "barber";
  if (/nail/.test(t)) return "nail_technician";
  if (/salon|hair/.test(t)) return "hair_stylist";
  if (/spa|massage/.test(t)) return "spa_wellness";
  if (/beauty|cosmetic/.test(t)) return best?.key ?? "makeup_artist";
  return best?.key ?? null;
}

export function rowToProspect(row: Record<string, string>, m: Mapping, source: string): NormalizedProspect | null {
  const get = (f: TargetField) => (m[f] ? row[m[f]!]?.trim() || null : null);
  const name = get("business_name");
  if (!name) return null;
  const followers = get("followers");
  const country = get("country");
  return {
    business_name: name,
    owner_name: get("owner_name"),
    category: mapCategory(get("category") ?? undefined),
    description: get("description"),
    bio: get("bio"),
    city: get("city"),
    state: get("state"),
    area: get("area"),
    country: country ? (country.length === 2 ? country.toUpperCase() : /nigeria/i.test(country) ? "NG" : country) : null,
    instagram_handle: get("instagram")?.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?].*$/, "") ?? null,
    tiktok_handle: get("tiktok")?.replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, "").replace(/[/?].*$/, "") ?? null,
    facebook_url: get("facebook") ? (get("facebook")!.startsWith("http") ? get("facebook") : `https://facebook.com/${get("facebook")}`) : null,
    linkedin_url: get("linkedin"),
    email: get("email"),
    phone: get("phone"),
    whatsapp: get("whatsapp"),
    website: get("website"),
    booking_url: get("booking_url"),
    follower_count: followers ? Number(followers.replace(/[^\d.]/g, "")) * (/k$/i.test(followers) ? 1000 : 1) || null : null,
    last_post_date: get("last_post_date") ? new Date(get("last_post_date")!) : null,
    source,
    source_url: get("source_url"),
    external_id: get("external_id"),
  };
}

export interface PreviewRow {
  index: number;
  prospect: NormalizedProspect | null;
  issue: string | null;
  duplicateOf: { id: string; name: string; confidence: number; decision: string } | null;
}

/** Preview first N rows, checking each against existing prospects. */
export async function previewImport(q: Q, rows: Record<string, string>[], mapping: Mapping, source: string, n = 25): Promise<PreviewRow[]> {
  const out: PreviewRow[] = [];
  for (let i = 0; i < Math.min(n, rows.length); i++) {
    const p = rowToProspect(rows[i], mapping, source);
    if (!p) {
      out.push({ index: i, prospect: null, issue: "Missing business name", duplicateOf: null });
      continue;
    }
    const prep = prepare(p);
    const d = prep.dedup;
    const cands = await q.many<{ id: string; business_name: string; city: string | null; instagram_handle: string | null; tiktok_handle: string | null; phone: string | null; whatsapp: string | null; email: string | null; website_domain: string | null }>(sql`
      select id, business_name, city, instagram_handle, tiktok_handle, phone, whatsapp, email, website_domain from prospects
      where merged_into is null and (similarity(normalized_name, ${prep.row.normalized_name as string}) > 0.45
        or (${d.instagram_handle}::text is not null and lower(instagram_handle) = ${d.instagram_handle})
        or (${d.phone}::text is not null and (phone = ${d.phone} or whatsapp = ${d.phone})))
      limit 10`);
    const best = cands.map((c) => ({ c, m: compareProspects(c, d) })).filter((x) => x.m.decision !== "distinct").sort((a, b) => b.m.confidence - a.m.confidence)[0];
    out.push({
      index: i,
      prospect: { ...p, category: (prep.row.category as string) ?? p.category, city: (prep.row.city as string) ?? p.city, phone: (prep.row.phone as string) ?? null, instagram_handle: (prep.row.instagram_handle as string) ?? null },
      issue: null,
      duplicateOf: best ? { id: best.c.id, name: best.c.business_name, confidence: best.m.confidence, decision: best.m.decision } : null,
    });
  }
  return out;
}

export async function runImport(ctx: JobContext) {
  const p = ctx.job.payload as { importId: string; csv: string; mapping: Mapping; source: string; campaignId: string | null };
  const { rows } = parseCsv(p.csv);
  const icp = await ctx.ws((q) => getIcpConfig(q));
  const counts: Record<IngestOutcome, number> = { created: 0, merged: 0, flagged: 0, suppressed: 0, skipped: 0 };
  const errors: string[] = [];
  await ctx.ws((q) => q.exec(sql`update import_batches set status = 'running', total = ${rows.length}, job_id = ${ctx.job.id} where id = ${p.importId}`));
  for (let i = 0; i < rows.length; i += 50) {
    await ctx.progress(i, rows.length, `Importing rows ${i + 1}–${Math.min(rows.length, i + 50)}`);
    const items: NormalizedProspect[] = [];
    rows.slice(i, i + 50).forEach((r, j) => {
      const np = rowToProspect(r, p.mapping, p.source);
      if (np) items.push(np);
      else {
        counts.skipped++;
        if (errors.length < 50) errors.push(`Row ${i + j + 2}: missing business name`);
      }
    });
    const r = await ctx.ws((q) => ingestMany(q, { workspaceId: ctx.workspaceId, actorType: "user", actorId: ctx.userId }, items, { campaignId: p.campaignId, icp }));
    for (const k of Object.keys(counts) as IngestOutcome[]) counts[k] += r.counts[k];
    await ctx.ws((q) => q.exec(sql`update import_batches set created = ${counts.created + counts.flagged}, merged = ${counts.merged}, duplicates_flagged = ${counts.flagged}, skipped = ${counts.skipped + counts.suppressed} where id = ${p.importId}`));
  }
  await ctx.ws(async (q) => {
    await q.exec(sql`update import_batches set status = 'succeeded', errors = ${json(errors)} where id = ${p.importId}`);
    await notify(q, ctx.workspaceId, { userId: ctx.userId, type: "import_done", title: `Import finished: ${counts.created + counts.flagged} new prospects`, body: `${counts.merged} matched existing · ${counts.flagged} possible duplicates · ${counts.skipped + counts.suppressed} skipped`, link: "/prospects?sort=discovered" });
  });
  // The raw CSV is no longer needed once imported (data minimisation).
  await ctx.ws((q) => q.exec(sql`update jobs set payload = payload - 'csv' where id = ${ctx.job.id}`));
  return counts;
}
