import type { NormalizedProspect } from "../adapters/types";
import { integrationFetch } from "../adapters/http";
import { TAGS, osmToProspect, type OsmElement } from "../adapters/osm";
import { nameRegex } from "./queries";
import { orbitFit } from "./icp";

/**
 * OpenStreetMap, country-wide: one Overpass query per country × category over
 * the national boundary (area), instead of a single city box. A second pass
 * per category matches business names (e.g. "… Barbing Salon") on shops,
 * crafts and offices that aren't tagged with the category.
 * Public Overpass: one request at a time, ≥15 s apart, fallback mirror.
 */

export const OVERPASS_ENDPOINTS = (process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function countryTagQuery(cc: string, category: string, filters: string[] = TAGS[category] ?? []): string | null {
  if (!filters.length || !/^[A-Z]{2}$/.test(cc)) return null;
  const body = filters.map((f) => `nwr${f}(area.c);`).join("");
  return `[out:json][timeout:90][maxsize:536870912];area["ISO3166-1"="${cc}"][admin_level=2]->.c;(${body});out center tags;`;
}

export function countryNameQuery(cc: string, category: string): string | null {
  const re = nameRegex(category);
  if (!re || !/^[A-Z]{2}$/.test(cc)) return null;
  const name = `["name"~"${re}",i]`;
  const body = ["shop", "craft", "office", "amenity", "leisure"].map((k) => `nwr${name}["${k}"](area.c);`).join("");
  return `[out:json][timeout:90][maxsize:536870912];area["ISO3166-1"="${cc}"][admin_level=2]->.c;(${body});out center tags;`;
}

/** Shops/amenities whose names match but which clearly aren't the category (supermarkets, schools…). */
const NOT_SERVICE = /^(supermarket|convenience|fuel|bank|school|university|college|hospital|clinic|pharmacy|place_of_worship|restaurant|fast_food|bar|pub|marketplace|car|motorcycle|mobile_phone|electronics|clothes|shoes|bakery)$/;

export async function runOsmCountryUnit(workspaceId: string, p: { cc: string; category: string; mode: "tags" | "names" }): Promise<{ items: NormalizedProspect[]; diagnostic?: string }> {
  const query = p.mode === "tags" ? countryTagQuery(p.cc, p.category) : countryNameQuery(p.cc, p.category);
  if (!query) return { items: [], diagnostic: `No ${p.mode === "tags" ? "OpenStreetMap tags" : "name pattern"} defined for ${p.category}` };
  let lastErr: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await integrationFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "OutboundOS/0.2 (business discovery; low volume)" },
        body: `data=${encodeURIComponent(query)}`,
      }, { workspaceId, integration: "osm_overpass", minIntervalMs: 15_000, maxRetries: 1, timeoutMs: 100_000 });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = (await res.json()) as { elements?: OsmElement[]; remark?: string };
      if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) throw new Error(`Overpass: ${data.remark.slice(0, 200)}`);
      const items: NormalizedProspect[] = [];
      const seen = new Set<string>();
      for (const el of data.elements ?? []) {
        const key = `${el.type}/${el.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = el.tags ?? {};
        if (p.mode === "names" && (NOT_SERVICE.test(t.shop ?? "") || NOT_SERVICE.test(t.amenity ?? ""))) continue;
        const item = osmToProspect(el, p.category, "", p.cc);
        if (item && orbitFit({ category: item.category, name: item.business_name, brand: t.brand ?? null }).ok) items.push({ ...item, source: "osm_overpass", address: [t["addr:housenumber"], t["addr:street"], t["addr:suburb"], t["addr:city"]].filter(Boolean).join(", ") || null });
      }
      return { items, diagnostic: items.length ? undefined : `0 ${p.category.replace(/_/g, " ")} records mapped in OpenStreetMap for ${p.cc} (${p.mode})` };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
