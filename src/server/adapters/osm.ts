import type { SourceAdapter, NormalizedProspect, DiscoveryParams, DiscoveryContext } from "./types";
import { integrationFetch } from "./http";
import { NIGERIAN_CITIES } from "../domain/taxonomy";

/**
 * OpenStreetMap via the Overpass API. Data © OpenStreetMap contributors,
 * licensed under the ODbL — storing it is permitted with attribution.
 * Public instance usage policy: low volume, one request at a time. Point
 * OVERPASS_URL at a self-hosted/paid instance for heavy use.
 */

const TAGS: Record<string, string[]> = {
  hair_stylist: ['["shop"="hairdresser"]["hairdresser"!="barber"]', '["shop"="hairdresser_supply"]', '["beauty"="hair"]'],
  barber: ['["shop"="hairdresser"]["hairdresser"="barber"]', '["shop"="barber"]', '["amenity"="barber"]'],
  nail_technician: ['["beauty"="nails"]', '["shop"="beauty"]["beauty"~"nails"]'],
  lash_technician: ['["beauty"~"lashes|eyelashes|brows"]'],
  makeup_artist: ['["beauty"~"makeup|cosmetics"]', '["craft"="makeup_artist"]'],
  skincare: ['["beauty"~"skin|facial|waxing"]', '["shop"="beauty"]["beauty"~"skin"]'],
  spa_wellness: ['["leisure"="spa"]', '["amenity"="spa"]', '["shop"="massage"]'],
  fitness_trainer: ['["leisure"="fitness_centre"]'],
  photographer: ['["craft"="photographer"]', '["shop"="photo"]', '["craft"="photographic_studio"]'],
  event_planner: ['["office"="event_management"]', '["craft"="event_planner"]', '["amenity"="events_venue"]'],
  fashion_designer: ['["craft"="tailor"]', '["shop"="tailor"]', '["craft"="dressmaker"]', '["shop"="fashion"]'],
  caterer: ['["craft"="caterer"]', '["shop"="pastry"]', '["amenity"="catering"]'],
  cleaning_service: ['["shop"="dry_cleaning"]', '["shop"="laundry"]', '["craft"="cleaning"]', '["office"="cleaning"]'],
  consultant: ['["office"="consulting"]'],
  coach: ['["office"="coaching"]'],
};
const GENERIC_BEAUTY = '["shop"="beauty"]';

function buildQuery(category: string, bbox: [number, number, number, number], filters: string[] = TAGS[category] ?? []): string {
  const parts = (category === "nail_technician" || category === "lash_technician" || category === "makeup_artist" ? [...filters, GENERIC_BEAUTY] : filters)
    .flatMap((f) => [`node${f}(${bbox.join(",")});`, `way${f}(${bbox.join(",")});`]);
  return `[out:json][timeout:60];(${parts.join("")});out center tags 400;`;
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function categoryFromTags(t: Record<string, string>, requested: string): string {
  if (t.hairdresser === "barber" || t.shop === "barber") return "barber";
  if (t.beauty?.includes("nails")) return "nail_technician";
  if (/lash|brow/.test(t.beauty ?? "")) return "lash_technician";
  if (/makeup|cosmetic/.test(t.beauty ?? "")) return "makeup_artist";
  if (t.shop === "hairdresser") return "hair_stylist";
  if (t.leisure === "spa" || t.shop === "massage") return "spa_wellness";
  if (t.craft === "tailor" || t.shop === "tailor" || t.craft === "dressmaker") return "fashion_designer";
  if (t.craft === "photographer" || t.shop === "photo") return "photographer";
  return requested;
}

export function osmToProspect(el: OsmElement, requested: string, cityName: string, countryCode = "NG"): NormalizedProspect | null {
  const t = el.tags ?? {};
  const name = t.name ?? t["name:en"] ?? t.brand;
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;
  const ig = t["contact:instagram"] ?? t.instagram ?? null;
  const fb = t["contact:facebook"] ?? t.facebook ?? null;
  const tiktok = t["contact:tiktok"] ?? null;
  return {
    business_name: name,
    category: categoryFromTags(t, requested),
    description: [t.description, t.opening_hours ? `Opening hours: ${t.opening_hours}` : null].filter(Boolean).join(" · ") || null,
    city: t["addr:city"] ?? cityName,
    area: t["addr:suburb"] ?? t["addr:district"] ?? null,
    state: t["addr:state"] ?? null,
    country: (t["addr:country"] ?? countryCode).toUpperCase().slice(0, 2),
    lat,
    lng,
    phone: t["contact:phone"] ?? t.phone ?? t["contact:mobile"] ?? null,
    whatsapp: t["contact:whatsapp"] ?? null,
    email: t["contact:email"] ?? t.email ?? null,
    website: t["contact:website"] ?? t.website ?? null,
    instagram_handle: ig ? ig.replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "") : null,
    tiktok_handle: tiktok ? tiktok.replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/, "").replace(/\/.*$/, "") : null,
    facebook_url: fb ? (fb.startsWith("http") ? fb : `https://facebook.com/${fb}`) : null,
    source: "osm_overpass",
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    external_id: `${el.type}/${el.id}`,
    raw: { tags: t },
  };
}

export const osmAdapter: SourceAdapter = {
  info: {
    key: "osm_overpass",
    label: "OpenStreetMap",
    description: "Salons, barbers, spas, tailors and studios mapped on OpenStreetMap. Free, permitted to store (ODbL). Coverage varies by city.",
    mode: "automated",
    status: "available",
    attribution: "© OpenStreetMap contributors (ODbL)",
  },
  async *discover(params: DiscoveryParams, ctx: DiscoveryContext) {
    const endpoint = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
    const locs = params.locations?.length
      ? params.locations
      : NIGERIAN_CITIES.filter((c) => params.cities.includes(c.key)).map((c) => ({ key: c.key, city: c.name, country_code: "NG", bbox: c.bbox }));
    const tagsFor = (cat: string) => [...(TAGS[cat] ?? []), ...(params.customTags?.[cat] ?? [])];
    const cats = params.categories.filter((c) => tagsFor(c).length);
    const units = locs.flatMap((l) => cats.map((cat) => ({ l, cat, unit: `osm:${l.key}:${cat}` })));
    let done = units.filter((u) => ctx.isDone?.(u.unit)).length;
    let yielded = 0;
    const seen = new Set<string>();
    for (const { l, cat, unit } of units) {
      if (ctx.isDone?.(unit)) continue; // completed in an earlier attempt (resume)
      if (yielded >= params.limit) return;
      if (!(await ctx.progress(done, units.length, `OpenStreetMap: ${cat.replace(/_/g, " ")} in ${l.city}`))) return;
      const res = await integrationFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "OutboundOS/0.1 (internal growth tool)" },
        body: `data=${encodeURIComponent(buildQuery(cat, l.bbox, tagsFor(cat)))}`,
      }, { workspaceId: ctx.workspaceId, integration: "osm_overpass", minIntervalMs: 5000, maxRetries: 3, timeoutMs: 90_000 });
      const data = (await res.json()) as { elements?: OsmElement[] };
      const els = data.elements ?? [];
      await ctx.log("info", `OSM ${cat} in ${l.city}: ${els.length} features`);
      for (const el of els) {
        const key = `${el.type}/${el.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = osmToProspect(el, cat, l.city, l.country_code);
        if (p) {
          yielded++;
          yield p;
          if (yielded >= params.limit) return; // unit not marked done → resumes here next time
        }
      }
      await ctx.markDone?.(unit);
      done++;
    }
  },
};
