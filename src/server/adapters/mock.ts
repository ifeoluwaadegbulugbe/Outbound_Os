import type { SourceAdapter, NormalizedProspect } from "./types";
import { NIGERIAN_CITIES, categoryLabel } from "../domain/taxonomy";

/**
 * DEVELOPMENT MOCK. Generates fictional businesses so the full pipeline can be
 * exercised without any external integration. Every record is flagged
 * is_demo, handles end in ".demo" and phones use the non-mobile +234 800 555
 * range. Disabled in production.
 */

const FIRST = ["Adaeze", "Bola", "Chika", "Dayo", "Ebere", "Folake", "Gift", "Hadiza", "Ijeoma", "Jide", "Kemi", "Lami", "Mercy", "Nike", "Ope", "Queen", "Rukky", "Sola", "Temi", "Uju", "Vivian", "Wumi", "Yewande", "Zara"];
const SUFFIX: Record<string, string[]> = {
  hair_stylist: ["Hair Studio", "Braids & Wigs", "Hair Lounge"],
  barber: ["Cuts", "Barbershop", "Grooming"],
  nail_technician: ["Nails", "Nail Bar", "Nail Studio"],
  lash_technician: ["Lashes", "Lash Lab", "Brow & Lash"],
  makeup_artist: ["Beauty", "Glam Studio", "Makeovers"],
  photographer: ["Photography", "Captures", "Studios"],
  event_planner: ["Events", "Decor & Events"],
  fashion_designer: ["Couture", "Bespoke", "Stitches"],
};

let counter = 0;

export const mockAdapter: SourceAdapter = {
  info: {
    key: "mock_source",
    label: "Mock source (development)",
    description: "Fictional businesses for testing the pipeline end to end. Flagged as demo data; never contactable.",
    mode: "automated",
    status: process.env.NODE_ENV === "production" || process.env.ENABLE_MOCK_SOURCES === "false" ? "disabled" : "dev_only",
  },
  async *discover(params, ctx) {
    if (this.info.status === "disabled") throw new Error("The mock source is disabled in production.");
    const cities = NIGERIAN_CITIES.filter((c) => params.cities.includes(c.key));
    const cats = params.categories.length ? params.categories : ["hair_stylist", "nail_technician"];
    for (let i = 0; i < params.limit; i++) {
      if (i % 10 === 0 && !(await ctx.progress(i, params.limit, "Generating fictional prospects"))) return;
      const n = ++counter + Math.floor(Date.now() / 1000) % 100000;
      const city = cities[i % Math.max(1, cities.length)] ?? NIGERIAN_CITIES[0];
      const cat = cats[i % cats.length];
      const first = FIRST[n % FIRST.length];
      const name = `${first} ${(SUFFIX[cat] ?? ["Studio"])[n % (SUFFIX[cat]?.length ?? 1)]} ${n}`;
      const handle = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.demo`;
      const p: NormalizedProspect = {
        business_name: name,
        category: cat,
        city: city.name,
        country: "NG",
        bio: `${categoryLabel(cat)} in ${city.name}. ${n % 2 ? "DM to book" : "Book via WhatsApp 0800 555 " + String(1000 + (n % 9000)).slice(-4)}${n % 3 === 0 ? " · Deposit required" : ""}`,
        instagram_handle: handle,
        follower_count: 300 + (n * 137) % 20000,
        last_post_date: new Date(Date.now() - ((n * 7) % 40) * 86_400_000),
        posting_frequency: (n % 6) + 0.5,
        source: "mock_source",
        external_id: `mock:${n}`,
        is_demo: true,
      };
      yield p;
      await new Promise((r) => setTimeout(r, 5));
    }
  },
};
