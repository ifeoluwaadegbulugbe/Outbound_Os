import type { NormalizedProspect } from "../adapters/types";
import { HOST_TOKENS, categoryFromHost } from "./queries";
import { ORBIT_CATEGORIES } from "./icp";

/**
 * Website discovery from the Common Crawl URL index (free, open, permitted
 * for research and commercial use under Common Crawl's terms of use). We read
 * the index for a national domain (e.g. *.com.ng), keep hostnames that
 * contain a service word ("salon", "barber", "catering"…), and save each as a
 * business with a website. Its email comes later from the website crawler,
 * and its real name replaces the domain-derived one when the site is read.
 */

export const CC_INDEX = "https://index.commoncrawl.org";
const UA = "OutboundOS/0.2 (business website discovery)";

const g = globalThis as unknown as { __obCcIndex?: { id: string; at: number } };

export async function latestCcIndex(fetcher: typeof fetch = fetch): Promise<string> {
  if (process.env.COMMONCRAWL_INDEX) return process.env.COMMONCRAWL_INDEX;
  if (g.__obCcIndex && Date.now() - g.__obCcIndex.at < 86_400_000) return g.__obCcIndex.id;
  const res = await fetcher(`${CC_INDEX}/collinfo.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Common Crawl collinfo HTTP ${res.status}`);
  const list = (await res.json()) as { id: string }[];
  const id = list[0]?.id;
  if (!id) throw new Error("No Common Crawl index available");
  g.__obCcIndex = { id, at: Date.now() };
  return id;
}

export async function ccPageCount(domain: string, fetcher: typeof fetch = fetch): Promise<number> {
  const idx = await latestCcIndex(fetcher);
  const res = await fetcher(`${CC_INDEX}/${idx}-index?url=*.${domain}&output=json&showNumPages=true`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Common Crawl page count HTTP ${res.status}`);
  return ((await res.json()) as { pages: number }).pages ?? 0;
}

const SKIP_HOST = /(^|\.)(blogspot|wordpress|wixsite|gov|edu|sch|mil|news|blog|forum)\./i;

/** Distinct service-business hostnames from one page of index lines. Pure (unit-tested). */
export function serviceHostsFromIndex(lines: string, domain: string): { host: string; category: string }[] {
  const hosts = new Map<string, string>();
  const suffix = `.${domain}`;
  for (const line of lines.split("\n")) {
    const m = /"url":\s*"(https?:\/\/[^/"]+)/.exec(line);
    if (!m) continue;
    let host: string;
    try {
      host = new URL(m[1]).hostname.toLowerCase().replace(/^www\d?\./, "");
    } catch {
      continue;
    }
    if (!host.endsWith(suffix) || hosts.has(host) || SKIP_HOST.test(host)) continue;
    // Only the registrable label (e.g. "glamsalon" in glamsalon.com.ng), not deep subdomains.
    const label = host.slice(0, -suffix.length);
    if (label.includes(".")) continue;
    const cat = categoryFromHost(label);
    if (cat && ORBIT_CATEGORIES.has(cat)) hosts.set(host, cat);
  }
  return [...hosts].map(([host, category]) => ({ host, category }));
}

/** "glam-studio-lagos.com.ng" → "Glam Studio Lagos" */
export function nameFromHost(host: string, domain: string): string {
  const label = host.replace(new RegExp(`\\.${domain.replace(/\./g, "\\.")}$`), "");
  let words = label.split(/[-_]+/).filter(Boolean);
  if (words.length === 1) {
    // Split known tokens out of a run-together label: "glamsalonlagos" → "glam salon lagos".
    let w = words[0];
    for (const t of HOST_TOKENS.map((x) => x.token).sort((a, b) => b.length - a.length)) w = w.replace(t, ` ${t} `);
    words = w.split(/\s+/).filter(Boolean);
  }
  return words.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ").slice(0, 120);
}

export async function runCommonCrawlUnit(p: { cc: string; domain: string; page: number }, fetcher: typeof fetch = fetch): Promise<{ items: NormalizedProspect[]; diagnostic?: string }> {
  const idx = await latestCcIndex(fetcher);
  const url = `${CC_INDEX}/${idx}-index?url=*.${encodeURIComponent(p.domain)}&output=json&fl=url&page=${p.page}`;
  const res = await fetcher(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180_000) });
  if (res.status === 404) return { items: [], diagnostic: `No Common Crawl captures for *.${p.domain} page ${p.page}` };
  if (!res.ok) throw new Error(`Common Crawl index HTTP ${res.status}`);
  const text = await res.text();
  const hosts = serviceHostsFromIndex(text, p.domain);
  const items: NormalizedProspect[] = hosts.map((h) => ({
    business_name: nameFromHost(h.host, p.domain),
    name_from_domain: true,
    category: h.category,
    country: p.cc,
    website: `https://${h.host}/`,
    source: "commoncrawl",
    source_url: `https://${h.host}/`,
    external_id: h.host,
    raw: { index: idx, domain: p.domain, page: p.page },
  }));
  return { items, diagnostic: items.length ? undefined : `Page ${p.page} of *.${p.domain}: ${text.split("\n").length} URLs, no service-business hostnames` };
}
