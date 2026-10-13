import { describe, it, expect } from "vitest";
import { tiles, COLLECTION_COUNTRIES } from "@/server/collection/countries";
import { nameRegex, manualQueries, categoryFromHost, CATEGORY_TERMS } from "@/server/collection/queries";
import { overtureToProspect, overtureCategory, type OvertureRow } from "@/server/collection/overture";
import { serviceHostsFromIndex, nameFromHost } from "@/server/collection/commoncrawl";
import { countryTagQuery, countryNameQuery } from "@/server/collection/osm-country";
import { siteNameFrom } from "@/server/email/finder";
import { backoffMs } from "@/server/collection/engine";
import { overtureSource, osmCountrySource, commonCrawlSource } from "@/server/collection/sources";
import { CATEGORY_KEYS } from "@/server/domain/taxonomy";

const row = (o: Partial<OvertureRow> = {}): OvertureRow => ({
  id: "08f1", name: "Glow Beauty Lounge", taxonomy: "beauty_salon", basic: "personal_or_beauty_service",
  websites: ["https://glowlounge.ng/", "https://www.facebook.com/glowlounge"], emails: ["Hello@GlowLounge.ng", "bookings@glowlounge.ng", "hello@glowlounge.ng"],
  phones: ["+2348031234567"], socials: ["https://www.instagram.com/glowlounge/"], address: "12 Admiralty Way", locality: "Lekki", region: "Lagos", country: "NG",
  lng: 3.47, lat: 6.44, confidence: 0.8, datasets: ["meta"], operating_status: "open", ...o,
});

describe("country coverage and tiling", () => {
  it("covers every Nigerian tile without gaps and with stable keys", () => {
    const ng = COLLECTION_COUNTRIES.find((c) => c.cc === "NG")!;
    const t = tiles(ng.bbox, 2);
    expect(t.length).toBe(35); // 9.75° → 5 rows × 12.1° → 7 columns
    expect(new Set(t.map((x) => x.key)).size).toBe(t.length);
    expect(Math.min(...t.map((x) => x.bbox[0]))).toBe(ng.bbox[0]);
    expect(Math.max(...t.map((x) => x.bbox[2]))).toBe(ng.bbox[2]);
    expect(Math.max(...t.map((x) => x.bbox[3]))).toBe(ng.bbox[3]);
    expect(tiles(ng.bbox, 2)).toEqual(t); // deterministic → resumable
  });

  it("puts Nigeria first, then Ghana, Kenya, South Africa, Uganda, Tanzania, Rwanda", () => {
    expect(COLLECTION_COUNTRIES.slice(0, 7).map((c) => c.cc)).toEqual(["NG", "GH", "KE", "ZA", "UG", "TZ", "RW"]);
  });

  it("plans units for every source with unique keys", () => {
    const ng = COLLECTION_COUNTRIES[0];
    const units = [...overtureSource.plan(ng), ...osmCountrySource.plan(ng), ...commonCrawlSource.plan(ng)];
    expect(new Set(units.map((u) => `${u.source}:${u.unit_key}`)).size).toBe(units.length);
    expect(units.filter((u) => u.source === "osm_country").length).toBeGreaterThan(30);
    expect(units.filter((u) => u.source === "commoncrawl").map((u) => u.params.domain)).toEqual(["com.ng", "ng"]);
  });
});

describe("query generation", () => {
  it("uses whole-word name patterns so 'spa' doesn't match 'Spar'", () => {
    const re = new RegExp(nameRegex("spa_wellness")!, "i");
    expect(re.test("Oasis Spa")).toBe(true);
    expect(re.test("Spa & Massage Lekki")).toBe(true);
    expect(re.test("Spar Supermarket")).toBe(false);
    expect(re.test("Workspace Hub")).toBe(false);
    expect(nameRegex("not_a_category")).toBeNull();
  });

  it("builds manual queries per place with local terms and no duplicates", () => {
    const q = manualQueries("Lagos", "Nigeria");
    expect(q.length).toBeGreaterThan(30);
    expect(new Set(q).size).toBe(q.length);
    expect(q.some((x) => /barbing salon/.test(x))).toBe(true);
    expect(q.every((x) => x.includes("Lagos"))).toBe(true);
  });

  it("only maps to real Orbit categories", () => {
    for (const t of CATEGORY_TERMS) expect(CATEGORY_KEYS as readonly string[]).toContain(t.category);
  });

  it("builds country-wide Overpass queries and refuses bad input", () => {
    const q = countryTagQuery("GH", "barber")!;
    expect(q).toContain('area["ISO3166-1"="GH"][admin_level=2]');
    expect(q).toContain('nwr["shop"="barber"](area.c);');
    expect(countryTagQuery("ghana", "barber")).toBeNull();
    expect(countryNameQuery("KE", "nail_technician")).toContain('["name"~"');
  });
});

describe("Overture mapping", () => {
  it("maps a service place with provenance, separating the website from social links", () => {
    const p = overtureToProspect(row(), "NG")!;
    expect(p.category).toBe("beauty_salon");
    expect(p.subcategory).toBe("beauty_salon");
    expect(p.website).toBe("https://glowlounge.ng/");
    expect(p.facebook_url).toBe("https://www.facebook.com/glowlounge");
    expect(p.instagram_handle).toBe("glowlounge");
    expect(p.email).toBe("hello@glowlounge.ng");
    expect(p.extra_emails).toEqual(["bookings@glowlounge.ng"]); // deduped, lower-cased
    expect(p.source).toBe("overture");
    expect(p.external_id).toBe("08f1");
    expect(p.source_url).toBe("https://www.facebook.com/glowlounge");
    expect(p.city).toBe("Lekki");
    expect(p.address).toBe("12 Admiralty Way");
  });

  it("drops non-service, closed and nameless places", () => {
    expect(overtureToProspect(row({ taxonomy: "christian_place_of_worship", basic: "religious_organization" }), "NG")).toBeNull();
    expect(overtureToProspect(row({ operating_status: "permanently_closed" }), "NG")).toBeNull();
    expect(overtureToProspect(row({ name: " " }), "NG")).toBeNull();
  });

  it("keeps only service businesses (excludes sales outlets, utilities, media companies, schools)", () => {
    expect(overtureCategory({ taxonomy: "recycling_center", basic: "home_service" })).toBeNull();
    expect(overtureCategory({ taxonomy: "media_news_company", basic: "media_service" }, "extended")).toBeNull();
    expect(overtureCategory({ taxonomy: "internet_service_provider", basic: "technical_service" }, "extended")).toBeNull();
    expect(overtureCategory({ taxonomy: "real_estate_agent", basic: "real_estate_service" }, "extended")).toBe("real_estate");
    expect(overtureCategory({ taxonomy: "dental_clinic", basic: "dental_clinic" }, "extended")).toBe("health_practice");
    // Already taken by the core set → not duplicated by the extended set.
    expect(overtureCategory({ taxonomy: "beauty_salon", basic: "personal_or_beauty_service" }, "extended")).toBeNull();
  });

  it("falls back to the broad category, and never invents an email", () => {
    expect(overtureCategory({ taxonomy: "some_new_thing", basic: "event_or_party_service" })).toBe("event_planner");
    const p = overtureToProspect(row({ emails: null, websites: null }), "NG")!;
    expect(p.email).toBeNull();
    expect(p.extra_emails).toEqual([]);
    expect(p.website).toBeNull();
  });
});

describe("website discovery from the Common Crawl index", () => {
  it("keeps distinct service hostnames on the national domain only", () => {
    const lines = [
      '{"url": "https://www.glamsalon.com.ng/contact"}',
      '{"url": "https://glamsalon.com.ng/"}',
      '{"url": "https://workspace.com.ng/"}',
      '{"url": "https://news.blog.com.ng/salon-tips"}',
      '{"url": "https://deep.sub.beautyhub.com.ng/"}',
      '{"url": "https://acecatering.com.ng/menu"}',
      '{"url": "https://salonlagos.com/"}',
    ].join("\n");
    expect(serviceHostsFromIndex(lines, "com.ng")).toEqual([
      { host: "glamsalon.com.ng", category: "beauty_salon" },
      { host: "acecatering.com.ng", category: "caterer" },
    ]);
    expect(categoryFromHost("workspace")).toBeNull();
  });

  it("derives a readable placeholder name from the domain", () => {
    expect(nameFromHost("glam-studio-lagos.com.ng", "com.ng")).toBe("Glam Studio Lagos");
    expect(nameFromHost("teniscateringlagos.com.ng", "com.ng")).toBe("Tenis Catering Lagos");
  });

  it("reads the site's own name to replace the placeholder", () => {
    expect(siteNameFrom('<meta property="og:site_name" content="Teni&#039;s Kitchen">')).toBe("Teni's Kitchen");
    expect(siteNameFrom("<title>Home | Glam Studio Lagos</title>")).toBe("Glam Studio Lagos");
    expect(siteNameFrom("<title>Home</title>")).toBeNull();
  });
});

describe("retry policy", () => {
  it("backs off exponentially and caps at 6 hours", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(4)).toBe(480_000);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
  });
});

describe("Nigeria coverage", () => {
  it("assigns all states from coordinates and cleans region codes", async () => {
    const { nigeriaStateAt, normalizeNgState, NG_STATES } = await import("@/server/collection/ng-states");
    expect(NG_STATES.length).toBe(37); // 36 states + FCT
    expect(nigeriaStateAt(6.45, 3.4)).toBe("Lagos");
    expect(nigeriaStateAt(9.06, 7.49)).toBe("FCT");
    expect(nigeriaStateAt(4.82, 7.03)).toBe("Rivers");
    expect(nigeriaStateAt(12.0, 8.52)).toBe("Kano");
    expect(nigeriaStateAt(5.6, -0.2)).toBeNull(); // Accra
    expect(normalizeNgState("LA")).toBe("Lagos");
    expect(normalizeNgState("NG-FC")).toBe("FCT");
    expect(normalizeNgState("Akwa-Ibom")).toBe("Akwa Ibom");
    expect(normalizeNgState("Opposite")).toBeNull();
  });

  it("name pass keeps service names and rejects shops, churches, schools, restaurants", async () => {
    const { categoryFromName } = await import("@/server/collection/overture");
    expect(categoryFromName("Mama T Barbing Salon", { basic: null, taxonomy: null })).toBe("barber");
    expect(categoryFromName("Elegance Events & Decor", { basic: "professional_service", taxonomy: null })).toBe("event_planner");
    expect(categoryFromName("Glam Beauty Store", { basic: null, taxonomy: null })).toBeNull();
    expect(categoryFromName("Beauty Salon Supplies", { basic: "personal_care_and_beauty_store", taxonomy: null })).toBeNull();
    expect(categoryFromName("Fitness Church International", { basic: null, taxonomy: null })).toBeNull();
    expect(categoryFromName("Spa Restaurant", { basic: "restaurant", taxonomy: null })).toBeNull();
  });
});

describe("Orbit fit: small businesses in the 20 target categories only", () => {
  it("accepts target small businesses and rejects everything else", async () => {
    const { orbitFit } = await import("@/server/collection/icp");
    const ok = (category: string, taxonomy: string | null, name: string, brand: string | null = null) => orbitFit({ category, taxonomy, name, brand }).ok;
    expect(ok("hair_stylist", "hair_salon", "Tolu's Braids")).toBe(true);
    expect(ok("home_service", "plumbing", "Femi Plumbing Works")).toBe(true);
    expect(ok("freelancer", "bookkeeper", "Ada Bookkeeping")).toBe(true);
    expect(ok("construction", "building_or_construction_service", "Julius Berger")).toBe(false); // not a target category
    expect(ok("home_service", "solar_installation", "SunPower Installers")).toBe(false); // installer, not repair/maintenance
    expect(ok("real_estate", "real_estate_agent", "Homes Realty")).toBe(false);
    expect(ok("health_practice", "dental_clinic", "Smile Dental")).toBe(false);
    expect(ok("consultant", "professional_service", "XYZ Services")).toBe(false); // too vague on its own
    expect(ok("barber", "barber", "Cutz Barbershop", "Cutz Franchise")).toBe(false); // chain
    expect(ok("marketing_agency", "marketing_agency", "Mega Media Holdings PLC")).toBe(false); // large organisation
    // Categories 21–44
    expect(ok("tattoo_artist", "tattoo_and_piercing", "Ink Masters Lagos")).toBe(true);
    expect(ok("legal_practice", "attorney_or_law_firm", "Okafor & Co Legal Practitioners")).toBe(true);
    expect(ok("accountant", "accountant", "Bisi Adeyemi & Co Chartered Accountants")).toBe(true);
    expect(ok("accountant", "accountant", "KPMG Professional Services")).toBe(false); // large firm
    expect(ok("cake_designer", "bakery", "Sweet Tooth Cakes")).toBe(true);
    expect(ok("cake_designer", "bakery", "Fresh Bread Bakery")).toBe(false); // bread shop, not a custom cake designer
    expect(ok("florist", "florist", "Petals by Ada")).toBe(true);
    expect(ok("immigration_consultant", "passport_and_visa_service", "Easy Visa Consult")).toBe(true);
  });
});

describe("linked social profiles on business websites", () => {
  it("keeps the Instagram/TikTok profiles a site links to, not posts", async () => {
    const { findLinkedProfiles, findEmailsOnWebsite } = await import("@/server/email/finder");
    const html = `<html><head><title>Teni Lashes</title></head><body>
      <a href="https://www.instagram.com/p/Cxyz123/">latest post</a>
      <a href="https://instagram.com/tenilashes/">Instagram</a>
      <a href='https://www.tiktok.com/@teni.lashes?lang=en'>TikTok</a>
      <a href="mailto:hello@tenilashes.ng">Email us</a></body></html>`;
    const fetcher = async (url: string) => new Response(url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : html,
      { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "text/html" } });
    expect(await findLinkedProfiles("https://tenilashes.ng", fetcher)).toEqual({ instagram: "tenilashes", tiktok: "teni.lashes", error: null });
    const full = await findEmailsOnWebsite("https://tenilashes.ng", fetcher);
    expect(full.instagram).toBe("tenilashes");
    expect(full.emails[0]?.email).toBe("hello@tenilashes.ng");
  });
});

describe("TikTok handles in Instagram bios", () => {
  it("reads tiktok.com links and 'TikTok: @x' labels, nothing else", async () => {
    const { tiktokFromBio } = await import("@/server/collection/instagram-enrich");
    expect(tiktokFromBio("Lash tech in Lekki 💕 TikTok: @teni.lashes | DM to book")).toBe("teni.lashes");
    expect(tiktokFromBio("https://www.tiktok.com/@GlamByKemi?lang=en")).toBe("glambykemi");
    expect(tiktokFromBio("TT - @nailsbytolu.")).toBe("nailsbytolu");
    expect(tiktokFromBio("Bookings: @mybookingpage on IG")).toBeNull();
  });
});
