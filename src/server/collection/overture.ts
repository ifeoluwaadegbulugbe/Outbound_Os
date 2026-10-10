import type { NormalizedProspect } from "../adapters/types";
import { normalizeEmail } from "../domain/normalize";
import { nigeriaStateAt, normalizeNgState } from "./ng-states";
import { CATEGORY_TERMS } from "./queries";
import { ORBIT_TAXONOMY, orbitFit, cakeDesignerFromBakery } from "./icp";

/**
 * Overture Maps Places: an open dataset (CDLA Permissive 2.0) of tens of
 * millions of places contributed by Meta, Microsoft and others, published as
 * spatially sorted GeoParquet on public S3. Free to download, store and use
 * commercially, with attribution. Queried with DuckDB over HTTPS: only the
 * row groups whose bounding boxes overlap the requested tile are read.
 * Emails/websites are the business's own public listing details (largely
 * from public Facebook business pages via Meta).
 */

export const OVERTURE_BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
export const OVERTURE_ATTRIBUTION = "© Overture Maps Foundation (CDLA Permissive 2.0); includes data © OpenStreetMap contributors and others";

/** Overture taxonomy → Orbit category. Only service businesses Orbit can serve. */
export const OVERTURE_CATEGORY_MAP: Record<string, string> = {
  beauty_salon: "beauty_salon", hair_salon: "hair_stylist", hair_stylist: "hair_stylist", hair_extensions: "hair_stylist", hair_replacement: "hair_stylist",
  barber: "barber", nail_salon: "nail_technician", eyelash_service: "lash_technician", makeup_artist: "makeup_artist",
  skin_care_and_makeup: "skincare", skin_care: "skincare", waxing: "skincare", hair_removal: "skincare", laser_hair_removal: "skincare",
  threading_service: "skincare", tanning_salon: "skincare", teeth_whitening: "skincare", image_consultant: "coach", life_coach: "coach",
  spa: "spa_wellness", day_spa: "spa_wellness", health_spa: "spa_wellness", medical_spa: "spa_wellness", massage_therapy: "spa_wellness",
  massage: "spa_wellness", nutrition_service: "coach", weight_loss_center: "fitness_trainer",
  gym: "fitness_trainer", personal_trainer: "fitness_trainer", yoga_studio: "fitness_trainer", pilates_studio: "fitness_trainer",
  boot_camp: "fitness_trainer", fitness_trainer: "fitness_trainer", dance_school: "fitness_trainer", martial_arts_club: "fitness_trainer",
  party_and_event_planning: "event_planner", event_planning: "event_planner", wedding_planning: "event_planner", dj_service: "event_planner",
  party_equipment_rental: "event_planner", balloon_services: "event_planner", caterer: "caterer", personal_chef: "caterer", bartender: "caterer",
  event_photography_service: "photographer", session_photography_service: "photographer", photographer: "photographer",
  videographer: "photographer", photography_service: "photographer", video_film_production: "media_production",
  music_production: "media_production", music_production_service: "media_production", recording_and_rehearsal_studio: "media_production",
  sewing_and_alterations: "fashion_designer", tailor: "fashion_designer", fashion_designer: "fashion_designer", costume_designer: "fashion_designer",
  home_cleaning: "cleaning_service", janitorial_service: "cleaning_service", industrial_cleaning_service: "cleaning_service",
  laundry_service: "cleaning_service", dry_cleaning: "cleaning_service", laundromat: "cleaning_service", carpet_cleaning: "cleaning_service",
  pest_control_service: "home_service", pool_cleaning: "home_service",
  interior_design: "designer", graphic_designer: "designer", web_designer: "designer", sign_making: "designer",
  marketing_agency: "marketing_agency", advertising_agency: "marketing_agency", social_media_agency: "marketing_agency",
  internet_marketing_service: "marketing_agency", public_relations: "marketing_agency", b2b_advertising_and_marketing_service: "marketing_agency",
  b2b_marketing_consultant: "marketing_agency", business_consulting: "consultant", career_counseling: "coach",
  tutoring_service: "tutor", computer_coaching: "tutor", driving_school: "tutor", music_school: "tutor", language_school: "tutor",
  cooking_school: "tutor", art_school: "tutor", cosmetology_school: "tutor",
  pet_groomer: "pet_service", pet_sitting: "pet_service", dog_walkers: "pet_service", pet_boarding: "pet_service",
  car_wash: "auto_service", auto_detailing: "auto_service", automotive_repair: "auto_service", auto_body_shop: "auto_service",
  tattoo_and_piercing: "other_service", shoe_repair: "other_service",
};

/** Broad Overture basic categories that are service businesses; used when the specific taxonomy isn't mapped. */
/**
 * Extended service businesses: still Orbit-fit (they book clients, keep client
 * records and invoice) but outside the core beauty/wellness/events targets.
 * Collected by a separate source ("overture_ext") so core and extended stay
 * distinguishable; ICP scoring ranks them below target categories.
 * Excluded on purpose: retail stores, schools, churches, banks, hotels,
 * restaurants, government offices.
 */
export const OVERTURE_EXTENDED_MAP: Record<string, string> = {
  professional_service: "consultant", business_consulting: "consultant", b2b_business_management_service: "consultant",
  employment_agency: "consultant", writing_service: "consultant", translating_and_interpreting_service: "consultant",
  real_estate_service: "real_estate", real_estate_agent: "real_estate", property_management: "real_estate", real_estate: "real_estate",
  attorney_or_law_firm: "legal_finance", legal_service: "legal_finance", lawyer: "legal_finance", accountant: "legal_finance",
  tax_services: "legal_finance", insurance_agency: "legal_finance", notary_public: "legal_finance", bookkeeper: "legal_finance",
  travel_service: "travel_agency", travel_agents: "travel_agency", tour_operator: "travel_agency", visa_and_passport_service: "travel_agency",
  printing_service: "printing_service", print_shop: "printing_service", screen_printing: "printing_service", engraving: "printing_service",
  it_service_and_computer_repair: "tech_service", mobile_phone_repair: "tech_service", computer_repair: "tech_service",
  electronics_repair: "tech_service", it_consultant: "tech_service", cctv_installation: "tech_service",
  dental_clinic: "health_practice", dentist: "health_practice", physical_therapy: "health_practice", optometrist: "health_practice",
  chiropractor: "health_practice", dermatologist: "health_practice", psychologist: "health_practice", counseling_and_mental_health: "health_practice",
  acupuncture: "health_practice", speech_therapist: "health_practice", occupational_therapy: "health_practice",
  event_venue: "event_planner", wedding_chapel: "event_planner", banquet_hall: "event_planner",
  tutoring_service: "tutor", vocational_and_technical_school: "tutor",
  media_agency: "marketing_agency",
  automotive_repair: "auto_service", auto_glass_service: "auto_service", tire_repair_shop: "auto_service", towing_service: "auto_service",
  vehicle_wrap: "auto_service",
};

/**
 * Broad Overture categories counted as extended services when no specific
 * mapping applies. Only groups made of service businesses: media (news
 * companies, publishers, TV), technical (ISPs, hardware makers), schools,
 * real-estate developers and car dealers are deliberately not here.
 */
export const OVERTURE_EXTENDED_BASIC_MAP: Record<string, string> = {
  professional_service: "consultant",
  b2b_office_and_professional_service: "consultant",
  legal_service: "legal_finance",
  travel_service: "travel_agency",
  printing_service: "printing_service",
  dental_clinic: "health_practice",
  vision_or_eye_care_clinic: "health_practice",
  physical_medicine_and_rehabilitation: "health_practice",
  complementary_and_alternative_medicine: "health_practice",
  behavioral_or_mental_health_clinic: "health_practice",
  event_venue: "event_planner",
};

export const OVERTURE_BASIC_MAP: Record<string, string> = {
  personal_or_beauty_service: "beauty_salon",
  wellness_service: "spa_wellness",
  event_or_party_service: "event_planner",
  fitness_studio: "fitness_trainer",
  gym: "fitness_trainer",
  laundry_service: "cleaning_service",
  tutoring_service: "tutor",
  home_service: "home_service",
  design_service: "designer",
  animal_or_pet_service: "pet_service",
};

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|wa\.me|whatsapp\.com|linktr\.ee)$/i;

export interface OvertureRow {
  id: string;
  name: string | null;
  taxonomy: string | null;
  basic: string | null;
  websites: string[] | null;
  emails: string[] | null;
  phones: string[] | null;
  socials: string[] | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  lng: number | null;
  lat: number | null;
  confidence: number | null;
  datasets: string[] | null;
  operating_status: string | null;
  /** Brand name: set for chains/franchises (excluded: Orbit targets small, owner-run businesses). */
  brand?: string | null;
}

export type OvertureSet = "core" | "extended" | "names" | "b2b" | "orbit";

/** Business-service companies (construction, engineering, logistics, IT, general health practices). Hospitals excluded. */
export const OVERTURE_B2B_MAP: Record<string, string> = {
  building_or_construction_service: "construction", engineering_service: "construction", structural_engineer: "construction",
  civil_engineers: "construction", construction_services: "construction",
  freight_and_cargo_service: "logistics", courier_and_delivery_services: "logistics", shipping_center: "logistics", moving_company: "logistics",
  logistics_service: "logistics", trucking_company: "logistics",
  information_technology_company: "tech_service", software_development: "tech_service", it_service_and_computer_repair: "tech_service",
  web_hosting_service: "tech_service",
  health_care: "health_practice", medical_center: "health_practice", diagnostic_services: "health_practice", laboratory_testing: "health_practice",
};

/** Tags inside service groups that aren't service businesses Orbit can serve (sales outlets, utilities, facilities). */
export const OVERTURE_NOT_SERVICE = new Set([
  "recycling_center", "television_service_provider", "glass_and_mirror_sales_service", "beauty_supply_store", "hair_supply_store",
  "wig_store", "cosmetics_and_fragrance_store", "internet_service_provider", "computer_hardware_company", "home_developer",
  "media_news_company", "publisher", "print_media", "record_label", "game_publisher", "medical_school", "nursing_school", "flight_school",
  "auto_dealer", "gas_station", "parking", "storage_facility", "water_utility_provider", "electric_utility_provider",
]);

export function overtureCategory(row: Pick<OvertureRow, "taxonomy" | "basic">, set: OvertureSet = "core"): string | null {
  if (row.taxonomy && OVERTURE_NOT_SERVICE.has(row.taxonomy)) return null;
  const core = (row.taxonomy && OVERTURE_CATEGORY_MAP[row.taxonomy]) || (row.basic && OVERTURE_BASIC_MAP[row.basic]) || null;
  if (set === "core") return core;
  // Extended set: only places the core set didn't already take.
  if (core) return null;
  return (row.taxonomy && OVERTURE_EXTENDED_MAP[row.taxonomy]) || (row.basic && OVERTURE_EXTENDED_BASIC_MAP[row.basic]) || null;
}

function hostOf(u: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Overture row → NormalizedProspect. Pure (unit-tested). Returns null for non-service or closed places. */
export function overtureToProspect(row: OvertureRow, fallbackCountry: string, set: OvertureSet = "core"): NormalizedProspect | null {
  const name = row.name?.trim();
  if (!name) return null;
  if (row.operating_status && row.operating_status !== "open") return null;
  let category = set === "orbit" ? (row.taxonomy ? ORBIT_TAXONOMY[row.taxonomy] ?? (cakeDesignerFromBakery(row.taxonomy, name) ? "cake_designer" : null) : null)
    : set === "names" ? categoryFromName(name, row)
    : set === "b2b" ? (row.taxonomy && !OVERTURE_NOT_SERVICE.has(row.taxonomy) ? OVERTURE_B2B_MAP[row.taxonomy] ?? null : null)
    : overtureCategory(row, set);
  if (!category) return null;
  // Precise target category when the type is one of Orbit's 20 (e.g. skin_care_and_makeup → makeup artist).
  if (set !== "names" && row.taxonomy && ORBIT_TAXONOMY[row.taxonomy]) category = ORBIT_TAXONOMY[row.taxonomy];
  // Only small businesses in Orbit's target categories get through.
  if (!orbitFit({ category, taxonomy: set === "names" ? null : (row.taxonomy ?? row.basic), name, brand: row.brand ?? null }).ok) return null;
  const sites = (row.websites ?? []).filter(Boolean);
  const own = sites.find((u) => !SOCIAL_HOSTS.test(hostOf(u) ?? ""));
  const socials = [...(row.socials ?? []), ...sites.filter((u) => u !== own)];
  const fb = socials.find((u) => /facebook\.com|fb\.com/i.test(u)) ?? null;
  const ig = socials.find((u) => /instagram\.com/i.test(u)) ?? null;
  const tt = socials.find((u) => /tiktok\.com/i.test(u)) ?? null;
  const emails = [...new Set((row.emails ?? []).map((e) => normalizeEmail(e)).filter(Boolean) as string[])];
  const datasets = [...new Set(row.datasets ?? [])];
  return {
    business_name: name.slice(0, 200),
    category,
    subcategory: row.taxonomy ?? row.basic ?? null,
    country: (row.country ?? fallbackCountry).toUpperCase().slice(0, 2),
    // Most Nigerian records lack a region: derive the state from the coordinates.
    state: (row.country ?? fallbackCountry).toUpperCase() === "NG" ? nigeriaStateAt(row.lat, row.lng) ?? normalizeNgState(row.region) ?? row.region ?? null : row.region ?? null,
    city: row.locality ?? null,
    address: row.address ?? null,
    lat: row.lat,
    lng: row.lng,
    phone: row.phones?.[0] ?? null,
    email: emails[0] ?? null,
    extra_emails: emails.slice(1, 5),
    website: own ?? null,
    facebook_url: fb,
    instagram_handle: ig ? ig.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "") || null : null,
    tiktok_handle: tt ? tt.replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, "").replace(/[/?#].*$/, "") || null : null,
    source: set === "core" ? "overture" : set === "extended" ? "overture_ext" : set === "b2b" ? "overture_b2b" : set === "orbit" ? "overture_orbit" : "overture_names",
    // Email/phone provenance: the public listing they came from (Facebook page when Meta supplied it).
    source_url: fb ?? own ?? `https://explore.overturemaps.org/?id=${row.id}`,
    external_id: row.id,
    raw: { taxonomy: row.taxonomy, basic: row.basic, confidence: row.confidence, datasets, extraPhones: row.phones?.slice(1, 3) ?? [] },
  };
}

// ── DuckDB access (lazy: the app only loads DuckDB when collecting) ─────────

type Conn = { runAndReadAll(sql: string): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }>; run(sql: string): Promise<unknown> };
const g = globalThis as unknown as { __obDuck?: Promise<Conn>; __obOvertureRelease?: { v: string; at: number } };

async function duck(): Promise<Conn> {
  if (!g.__obDuck) {
    g.__obDuck = (async () => {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const db = await DuckDBInstance.create(":memory:");
      const c = (await db.connect()) as unknown as Conn;
      await c.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET memory_limit='1GB'; SET threads=4;");
      return c;
    })().catch((e) => {
      g.__obDuck = undefined;
      throw e;
    });
  }
  return g.__obDuck;
}

/** Latest Overture release (env override OVERTURE_RELEASE), cached for a day. */
export async function overtureRelease(fetcher: typeof fetch = fetch): Promise<string> {
  if (process.env.OVERTURE_RELEASE) return process.env.OVERTURE_RELEASE;
  if (g.__obOvertureRelease && Date.now() - g.__obOvertureRelease.at < 86_400_000) return g.__obOvertureRelease.v;
  const res = await fetcher(`${OVERTURE_BUCKET}/?list-type=2&prefix=release/&delimiter=/`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Overture release listing failed: HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [...xml.matchAll(/<Prefix>release\/([^<]+)\/<\/Prefix>/g)].map((m) => m[1]).sort();
  const v = versions.at(-1);
  if (!v) throw new Error("No Overture releases found");
  g.__obOvertureRelease = { v, at: Date.now() };
  return v;
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** All service places in one tile of one country. */
/**
 * Name-pattern pass: places Overture didn't categorise as a service (or left
 * uncategorised) whose name says what they do ("… Barbing Salon", "… Events",
 * "… Catering Services"). Whole words only; never shops, restaurants, hotels,
 * schools, churches, banks, hospitals or government offices.
 */
export const NAME_PASS_EXCLUDED_BASIC = [
  "religious_organization", "christian_place_of_worship", "muslim_place_of_worship", "place_of_worship", "school", "elementary_school",
  "middle_school", "high_school", "college_university", "place_of_learning", "preschool", "hospital", "bank_or_credit_union", "atm",
  "government_office", "government_department", "restaurant", "fast_food_restaurant", "casual_eatery", "cafe", "coffee_shop", "bar",
  "lounge", "nightlife_venue", "hotel", "lodging", "resort", "inn", "bed_and_breakfast", "shopping_mall", "shopping", "market",
  "convenience_store", "department_store", "supplier_or_distributor", "wholesaler", "manufacturer", "pharmacy_and_drug_store",
  "gas_station", "parking", "police_station", "embassy", "civic_organization", "political_organization", "sport_team",
];

const STRONG_SERVICE = / (salon|saloon|barbing|barber|barbershop|tailor|tailors|tailoring|couture|stitches|bespoke|atelier|makeover|makeovers|spa|nails|lashes|braids|braiding|photography|studio|studios|laundry|dry cleaners|cleaning) /;

export function categoryFromName(name: string, row: Pick<OvertureRow, "basic" | "taxonomy">): string | null {
  const strong = STRONG_SERVICE.test(" " + name.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ");
  const isStore = (row.basic?.endsWith("_store") ?? false) || (row.taxonomy?.endsWith("_store") ?? false);
  if (row.basic && NAME_PASS_EXCLUDED_BASIC.includes(row.basic)) return null;
  if (row.taxonomy && OVERTURE_NOT_SERVICE.has(row.taxonomy) && !strong) return null;
  if (isStore && !strong) return null;
  const n = " " + name.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  if (/ (store|stores|mart|supermarket|wholesale|depot|supplies|supply|cosmetics|accessories|boutique|pharmacy|church|mosque|school|college|hotel|restaurant|bank|motors|autos) /.test(n)) return null;
  // Most specific match wins: "barbing salon" is a barber, not a hair salon.
  let best: { cat: string; len: number } | null = null;
  for (const c of CATEGORY_TERMS) for (const t of [...c.tokens, ...c.phrases]) {
    const term = t.toLowerCase();
    if (n.includes(` ${term} `) && (!best || term.length > best.len)) best = { cat: c.category, len: term.length };
  }
  return best?.cat ?? null;
}

export function nameRegexSql(): string {
  const words = [...new Set(CATEGORY_TERMS.flatMap((c) => c.tokens.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))))].filter((w) => w.length >= 3);
  return "(^|[^a-z])(" + words.join("|") + ")([^a-z]|$)";
}

export async function queryOvertureTile(cc: string, bbox: [number, number, number, number], set: OvertureSet = "core"): Promise<OvertureRow[]> {
  const release = await overtureRelease();
  const [s, w, n, e] = bbox.map(Number);
  if (![s, w, n, e].every(Number.isFinite)) throw new Error("Invalid bbox");
  const coreTax = Object.keys(OVERTURE_CATEGORY_MAP).map(sqlStr).join(",");
  const coreBasic = Object.keys(OVERTURE_BASIC_MAP).map(sqlStr).join(",");
  const extTax = Object.keys(OVERTURE_EXTENDED_MAP).map(sqlStr).join(",");
  const extBasic = Object.keys(OVERTURE_EXTENDED_BASIC_MAP).map(sqlStr).join(",");
  const filter = set === "orbit"
    ? `(taxonomy.primary in (${Object.keys(ORBIT_TAXONOMY).map(sqlStr).join(",")}) or (taxonomy.primary = 'bakery' and regexp_matches(lower(names.primary), 'cake|confection')))`
    : set === "b2b"
    ? `taxonomy.primary in (${Object.keys(OVERTURE_B2B_MAP).map(sqlStr).join(",")})`
    : set === "core"
    ? `(taxonomy.primary in (${coreTax}) or basic_category in (${coreBasic}))`
    : set === "extended"
      ? `(taxonomy.primary in (${extTax}) or basic_category in (${extBasic}))`
      // names: not already covered by core/extended, and the name contains a service word
      : `not coalesce(taxonomy.primary in (${coreTax}, ${extTax}), false) and not coalesce(basic_category in (${coreBasic}, ${extBasic}), false)
         and regexp_matches(lower(names.primary), ${sqlStr(nameRegexSql())})`;
  const c = await duck();
  const r = await c.runAndReadAll(`
    select id, names.primary as name, taxonomy.primary as taxonomy, basic_category as basic, websites, emails, phones, socials,
      addresses[1].freeform as address, addresses[1].locality as locality, addresses[1].region as region, addresses[1].country as country,
      (bbox.xmin + bbox.xmax) / 2 as lng, (bbox.ymin + bbox.ymax) / 2 as lat, confidence, operating_status,
      list_distinct([x.dataset for x in sources]) as datasets, brand.names.primary as brand
    from read_parquet('s3://overturemaps-us-west-2/release/${release.replace(/[^0-9a-z.\-]/gi, "")}/theme=places/type=place/*')
    where bbox.xmin >= ${w} and bbox.xmin < ${e} and bbox.ymin >= ${s} and bbox.ymin < ${n}
      and coalesce(addresses[1].country, ${sqlStr(cc)}) = ${sqlStr(cc)}
      and ${filter}
      and coalesce(operating_status, 'open') = 'open'`);
  return r.getRowObjectsJson() as unknown as OvertureRow[];
}
