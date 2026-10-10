import type { NormalizedProspect } from "../adapters/types";
import { TAGS } from "../adapters/osm";
import { tiles, type CollectionCountry } from "./countries";
import { CATEGORY_TERMS } from "./queries";
import { overtureToProspect, queryOvertureTile, OVERTURE_ATTRIBUTION } from "./overture";
import { runOsmCountryUnit } from "./osm-country";
import { ccPageCount, runCommonCrawlUnit } from "./commoncrawl";

/**
 * Collection sources share one interface: plan() turns a country into work
 * units (persisted in collection_units, so nothing is issued twice), run()
 * executes one unit and returns normalized businesses. A unit may spawn more
 * units (e.g. the Common Crawl page list is only known at run time).
 */

export interface UnitSpec {
  source: string;
  unit_key: string;
  country_code: string | null;
  category?: string | null;
  params: Record<string, unknown>;
  priority: number;
}

export interface UnitResult {
  items: NormalizedProspect[];
  diagnostic?: string;
  spawn?: UnitSpec[];
}

export interface CollectionSource {
  key: string;
  label: string;
  description: string;
  license: string;
  /** Minimum gap between two units of this source (politeness / provider limits). */
  minIntervalMs: number;
  maxAttempts: number;
  plan(country: CollectionCountry): UnitSpec[];
  run(unit: { unit_key: string; params: Record<string, unknown>; country_code: string | null }, ctx: { workspaceId: string }): Promise<UnitResult>;
}

export const overtureSource: CollectionSource = {
  key: "overture",
  label: "Overture Maps Places",
  description: "Open places dataset (Meta, Microsoft and others): name, category, address, phone, website, socials and public business email. Queried per 2° tile.",
  license: OVERTURE_ATTRIBUTION,
  minIntervalMs: 0,
  maxAttempts: 4,
  plan: (c) => tiles(c.bbox, 2).map((t) => ({
    source: "overture", unit_key: `overture:${c.cc}:${t.key}`, country_code: c.cc, params: { cc: c.cc, bbox: t.bbox }, priority: c.priority,
  })),
  async run(unit) {
    const cc = String(unit.params.cc);
    const rows = await queryOvertureTile(cc, unit.params.bbox as [number, number, number, number]);
    const items = rows.map((r) => overtureToProspect(r, cc)).filter((x): x is NormalizedProspect => x !== null);
    return { items, diagnostic: rows.length ? undefined : `No service places in this tile (sparse area, water or outside ${cc})` };
  },
};

export const overtureExtendedSource: CollectionSource = {
  key: "overture_ext",
  label: "Overture Maps Places (extended services)",
  description: "Same open dataset, further service businesses that fit Orbit: professional services, real estate, clinics, law/accounting, travel, printing, IT repair, venues, auto services. Labelled separately from core targets.",
  license: OVERTURE_ATTRIBUTION,
  minIntervalMs: 0,
  maxAttempts: 4,
  // Nigeria first: extended units for NG outrank every other country's work.
  plan: (c) => tiles(c.bbox, 2).map((t) => ({
    source: "overture_ext", unit_key: `overture_ext:${c.cc}:${t.key}`, country_code: c.cc, params: { cc: c.cc, bbox: t.bbox }, priority: c.cc === "NG" ? 110 : c.priority - 2,
  })),
  async run(unit) {
    const cc = String(unit.params.cc);
    const rows = await queryOvertureTile(cc, unit.params.bbox as [number, number, number, number], "extended");
    const items = rows.map((r) => overtureToProspect(r, cc, "extended")).filter((x): x is NormalizedProspect => x !== null);
    return { items, diagnostic: rows.length ? undefined : `No extended-service places in this tile` };
  },
};

export const overtureNamesSource: CollectionSource = {
  key: "overture_names",
  label: "Overture Maps Places (service names)",
  description: "Places Overture left uncategorised or mis-categorised whose name says they're a service business (\"… Barbing Salon\", \"… Events\", \"… Catering\"). Excludes shops, restaurants, hotels, schools, churches, banks.",
  license: OVERTURE_ATTRIBUTION,
  minIntervalMs: 0,
  maxAttempts: 4,
  plan: (c) => tiles(c.bbox, 2).map((t) => ({
    source: "overture_names", unit_key: `overture_names:v3:${c.cc}:${t.key}`, country_code: c.cc, params: { cc: c.cc, bbox: t.bbox }, priority: c.cc === "NG" ? 105 : c.priority - 4,
  })),
  async run(unit) {
    const cc = String(unit.params.cc);
    const rows = await queryOvertureTile(cc, unit.params.bbox as [number, number, number, number], "names");
    const items = rows.map((r) => overtureToProspect(r, cc, "names")).filter((x): x is NormalizedProspect => x !== null);
    return { items, diagnostic: rows.length ? undefined : "No service-named places in this tile" };
  },
};

/** Exactly Orbit's target types (the 44 categories), straight from Overture's taxonomy. */
export const overtureOrbitSource: CollectionSource = {
  key: "overture_orbit",
  label: "Overture Maps Places (Orbit target types)",
  description: "Every place whose type is one of Orbit's target categories: beauty, grooming, events, entertainment, creative, marketing, consulting, tutoring, fitness, cleaning, repair, florists, cake designers, small law/accounting practices, recruiters, immigration consultants. Chains and large organisations excluded.",
  license: OVERTURE_ATTRIBUTION,
  minIntervalMs: 0,
  maxAttempts: 4,
  plan: (c) => tiles(c.bbox, 2).map((t) => ({
    source: "overture_orbit", unit_key: `overture_orbit:${c.cc}:${t.key}`, country_code: c.cc, params: { cc: c.cc, bbox: t.bbox }, priority: c.cc === "NG" ? 112 : c.priority,
  })),
  async run(unit) {
    const cc = String(unit.params.cc);
    const rows = await queryOvertureTile(cc, unit.params.bbox as [number, number, number, number], "orbit");
    const items = rows.map((r) => overtureToProspect(r, cc, "orbit")).filter((x): x is NormalizedProspect => x !== null);
    return { items, diagnostic: rows.length ? undefined : "No Orbit target-type places in this tile" };
  },
};

export const overtureB2bSource: CollectionSource = {
  key: "overture_b2b",
  label: "Overture Maps Places (business services)",
  description: "Construction and engineering firms, logistics/delivery companies, IT and software services, and general health practices (not hospitals).",
  license: OVERTURE_ATTRIBUTION,
  minIntervalMs: 0,
  maxAttempts: 4,
  plan: (c) => tiles(c.bbox, 2).map((t) => ({
    source: "overture_b2b", unit_key: `overture_b2b:${c.cc}:${t.key}`, country_code: c.cc, params: { cc: c.cc, bbox: t.bbox }, priority: c.cc === "NG" ? 104 : c.priority - 6,
  })),
  async run(unit) {
    const cc = String(unit.params.cc);
    const rows = await queryOvertureTile(cc, unit.params.bbox as [number, number, number, number], "b2b");
    const items = rows.map((r) => overtureToProspect(r, cc, "b2b")).filter((x): x is NormalizedProspect => x !== null);
    return { items, diagnostic: rows.length ? undefined : "No business-service places in this tile" };
  },
};

export const osmCountrySource: CollectionSource = {
  key: "osm_country",
  label: "OpenStreetMap (country-wide)",
  description: "Overpass queries over each national boundary: tagged businesses per category, plus a name-pattern pass for untagged shops.",
  license: "© OpenStreetMap contributors (ODbL)",
  minIntervalMs: 15_000,
  maxAttempts: 3,
  plan(c) {
    const out: UnitSpec[] = [];
    for (const category of Object.keys(TAGS)) {
      out.push({ source: "osm_country", unit_key: `osm:${c.cc}:${category}:tags`, country_code: c.cc, category, params: { cc: c.cc, category, mode: "tags" }, priority: c.priority - 5 });
    }
    for (const t of CATEGORY_TERMS) {
      out.push({ source: "osm_country", unit_key: `osm:${c.cc}:${t.category}:names`, country_code: c.cc, category: t.category, params: { cc: c.cc, category: t.category, mode: "names" }, priority: c.priority - 15 });
    }
    return out;
  },
  run: (unit, ctx) => runOsmCountryUnit(ctx.workspaceId, unit.params as { cc: string; category: string; mode: "tags" | "names" }),
};

export const commonCrawlSource: CollectionSource = {
  key: "commoncrawl",
  label: "Common Crawl (website discovery)",
  description: "Reads the open Common Crawl URL index for each national domain (e.g. *.com.ng) and keeps hostnames containing service words. Emails come from the website crawler.",
  license: "Common Crawl Terms of Use (open index)",
  minIntervalMs: 3_000,
  maxAttempts: 3,
  plan: (c) => c.domains.map((domain) => ({
    source: "commoncrawl", unit_key: `cc:${domain}:pages`, country_code: c.cc, params: { cc: c.cc, domain, list: true }, priority: c.priority - 20,
  })),
  async run(unit) {
    const p = unit.params as { cc: string; domain: string; list?: boolean; page?: number };
    if (p.list) {
      const pages = await ccPageCount(p.domain);
      const spawn: UnitSpec[] = Array.from({ length: Math.min(pages, 400) }, (_, page) => ({
        source: "commoncrawl", unit_key: `cc:${p.domain}:p${page}`, country_code: p.cc, params: { cc: p.cc, domain: p.domain, page }, priority: 25,
      }));
      return { items: [], spawn, diagnostic: `${pages} index pages queued for *.${p.domain}` };
    }
    return runCommonCrawlUnit({ cc: p.cc, domain: p.domain, page: Number(p.page) });
  },
};

export const COLLECTION_SOURCES: Record<string, CollectionSource> = {
  overture: overtureSource,
  overture_ext: overtureExtendedSource,
  overture_names: overtureNamesSource,
  overture_orbit: overtureOrbitSource,
  overture_b2b: overtureB2bSource,
  osm_country: osmCountrySource,
  commoncrawl: commonCrawlSource,
};
