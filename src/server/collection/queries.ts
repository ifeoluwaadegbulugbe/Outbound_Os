/**
 * Search-term generation. One vocabulary per Orbit category, including local
 * terminology (e.g. "barbing salon", "small chops", "aso ebi"), used to:
 *  - build name-pattern queries for OpenStreetMap,
 *  - pick website hostnames from the Common Crawl index,
 *  - produce the manual web/Maps search list shown on the Collection page.
 * Every generated unit has a stable key, so a query is never issued twice.
 */

export interface CategoryTerms {
  category: string;
  /** Phrases people actually search for. */
  phrases: string[];
  /** Words that appear in business names. */
  tokens: string[];
}

export const CATEGORY_TERMS: CategoryTerms[] = [
  { category: "hair_stylist", phrases: ["hair salon", "hair stylist", "braids", "wig installation", "hair studio", "unisex salon", "hair and beauty", "hair palace", "hair world", "natural hair"], tokens: ["hair", "braids", "braiding", "wigs", "salon", "locs", "weaves", "coiffure"] },
  { category: "barber", phrases: ["barbershop", "barbing salon", "barber", "barbing saloon", "gents salon"], tokens: ["barber", "barbers", "barbing", "barbershop", "saloon", "cutz", "kutz"] },
  { category: "beauty_salon", phrases: ["beauty salon", "beauty parlour", "unisex salon", "beauty studio", "beauty place", "beauty hub", "beauty lounge", "beauty bar"], tokens: ["beauty", "glam", "parlour", "glamour", "glow"] },
  { category: "nail_technician", phrases: ["nail salon", "nail technician", "nail studio", "nail bar"], tokens: ["nail", "nails"] },
  { category: "lash_technician", phrases: ["lash extensions", "lash technician", "brows and lashes"], tokens: ["lash", "lashes", "brows"] },
  { category: "makeup_artist", phrases: ["makeup artist", "bridal makeup", "MUA", "make up", "gele tying", "makeup studio", "mobile makeup", "home service makeup", "mobile beauty"], tokens: ["makeup", "makeover", "makeovers", "mua", "gele"] },
  { category: "skincare", phrases: ["skincare clinic", "esthetician", "facial spa"], tokens: ["skincare", "aesthetics", "facials"] },
  { category: "spa_wellness", phrases: ["spa", "massage", "wellness centre"], tokens: ["spa", "massage", "wellness"] },
  { category: "fitness_trainer", phrases: ["gym", "personal trainer", "fitness studio", "yoga"], tokens: ["gym", "fitness", "yoga", "pilates"] },
  { category: "photographer", phrases: ["photographer", "photo studio", "wedding photographer", "videographer", "photo and video", "pictures studio"], tokens: ["photography", "photographer", "photos", "photo", "videography", "videographer", "pictures", "shots", "lens"] },
  { category: "event_planner", phrases: ["event planner", "wedding planner", "event decorator", "event management", "events and decor", "party rentals", "event rentals"], tokens: ["events", "decor", "decorations", "decors", "weddings", "planner", "planners", "rentals", "ushering"] },
  { category: "caterer", phrases: ["caterer", "catering services", "small chops", "cake shop", "private chef"], tokens: ["catering", "caterer", "cakes", "chops"] },
  { category: "fashion_designer", phrases: ["fashion designer", "tailor", "fashion house", "aso ebi", "bespoke tailoring", "fashion home", "fashion world", "fashion designs", "fashion place"], tokens: ["tailor", "tailors", "tailoring", "couture", "stitches", "stitch", "bespoke", "atelier", "designz", "fashions"] },
  { category: "cleaning_service", phrases: ["cleaning services", "laundry", "dry cleaning", "fumigation", "dry cleaners", "cleaning company"], tokens: ["cleaning", "cleaners", "laundry", "laundromat", "fumigation", "drycleaners", "dryclean"] },
  { category: "tutor", phrases: ["tutorial centre", "home tutor", "lesson teacher", "driving school"], tokens: ["tutors", "tutorial", "tutorials", "lessons"] },
  { category: "designer", phrases: ["interior designer", "graphic designer", "web designer", "graphics design", "web design", "interior decor"], tokens: ["interior", "interiors", "graphics", "webdesign"] },
  { category: "marketing_agency", phrases: ["digital marketing agency", "social media management", "branding agency", "digital agency", "media consult"], tokens: ["marketing", "branding", "socialmedia"] },
  { category: "home_service", phrases: ["plumber", "electrician", "AC repair", "pest control", "phone repairs", "generator repairs", "fridge repairs", "electrical works", "plumbing works"], tokens: ["plumbing", "plumber", "electrician", "electricals", "repairs", "repair", "technician", "technicians", "fumigators"] },
  { category: "auto_service", phrases: ["car wash", "mechanic", "car detailing"], tokens: ["carwash", "detailing", "mechanic"] },
  { category: "coach", phrases: ["life coach", "business coach"], tokens: ["coach", "coaching"] },
  { category: "consultant", phrases: ["business consultant", "management consultant", "consulting services", "market research", "research consultants", "brand strategist", "brand strategy"], tokens: ["consulting", "consultants", "consultancy", "advisory"] },
  { category: "freelancer", phrases: ["virtual assistant", "secretarial services", "voice over", "voiceover artist", "ugc creator", "content writer", "copywriter", "copywriting", "grant writing", "proposal writing", "content creator"], tokens: ["secretarial", "transcription", "voiceover", "copywriting", "copywriter", "ugc"] },
  { category: "accountant", phrases: ["chartered accountants", "accounting firm", "bookkeeping services", "tax consultants", "audit and tax"], tokens: ["accountants", "accounting", "bookkeeping", "taxation"] },
  { category: "hr_recruiter", phrases: ["recruitment agency", "hr consulting", "human resources consulting", "staffing solutions"], tokens: ["recruitment", "recruiters", "staffing", "headhunters"] },
  { category: "legal_practice", phrases: ["law firm", "legal practitioners", "barristers and solicitors", "law chambers", "law office"], tokens: ["solicitors", "barristers", "chambers", "attorneys", "advocates"] },
  { category: "immigration_consultant", phrases: ["immigration consultant", "visa consultant", "travel and visa", "study abroad", "relocation services"], tokens: ["immigration", "relocation", "visas"] },
  { category: "tattoo_artist", phrases: ["tattoo studio", "tattoo parlour", "body piercing"], tokens: ["tattoo", "tattoos", "piercing"] },
  { category: "henna_artist", phrases: ["henna artist", "bridal henna", "henna designs"], tokens: ["henna", "mehndi", "lalle"] },
  { category: "personal_stylist", phrases: ["personal stylist", "image consultant", "wardrobe stylist", "fashion stylist"], tokens: ["stylist", "styling"] },
  { category: "florist", phrases: ["florist", "flower shop", "floral designs"], tokens: ["florist", "florists", "floral", "flowers"] },
  { category: "cake_designer", phrases: ["cake designer", "custom cakes", "cakes and pastries", "cake studio"], tokens: ["cakes", "cakery", "confectionery", "cupcakes"] },
  { category: "entertainer", phrases: ["event host", "live band", "mc services", "comedian"], tokens: ["deejay", "compere", "hypeman"] },
];

export const CONTACT_WORDS = ["contact", "email", "bookings", "enquiries", "inquiries", "official website"];

/**
 * Hostname tokens for website discovery (Common Crawl). Only tokens that are
 * unambiguous inside a hostname: "spa" would match "workspace" and "hair"
 * would match "chairman", so those are left out here.
 */
export const HOST_TOKENS: { token: string; category: string }[] = [
  { token: "salon", category: "beauty_salon" }, { token: "barber", category: "barber" }, { token: "barbing", category: "barber" },
  { token: "beauty", category: "beauty_salon" }, { token: "nails", category: "nail_technician" }, { token: "lashes", category: "lash_technician" },
  { token: "makeup", category: "makeup_artist" }, { token: "massage", category: "spa_wellness" }, { token: "wellness", category: "spa_wellness" },
  { token: "fitness", category: "fitness_trainer" }, { token: "photography", category: "photographer" }, { token: "catering", category: "caterer" },
  { token: "couture", category: "fashion_designer" }, { token: "tailor", category: "fashion_designer" }, { token: "laundry", category: "cleaning_service" },
  { token: "cleaning", category: "cleaning_service" }, { token: "interiors", category: "designer" }, { token: "weddings", category: "event_planner" },
  { token: "eventplanner", category: "event_planner" }, { token: "tutorial", category: "tutor" }, { token: "plumbing", category: "home_service" },
  { token: "carwash", category: "auto_service" }, { token: "skincare", category: "skincare" }, { token: "hairstudio", category: "hair_stylist" },
];

/**
 * Overpass name regex for a category (case-insensitive). Whole words only:
 * Overpass uses POSIX regular expressions (no word-boundary escape), so the
 * alternation is wrapped in non-letter guards and "spa" won't match "Spar".
 */
export function nameRegex(category: string): string | null {
  const c = CATEGORY_TERMS.find((x) => x.category === category);
  if (!c) return null;
  const words = [...new Set(c.tokens.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")))].filter((w) => w.length >= 3);
  return words.length ? "(^|[^a-z])(" + words.join("|") + ")([^a-z]|$)" : null;
}

/** Manual research queries (web search / Google Maps) for a place. Shown in the UI; never issued automatically. */
export function manualQueries(city: string, country: string, limit = 60): string[] {
  const out: string[] = [];
  for (const c of CATEGORY_TERMS) {
    for (const p of c.phrases.slice(0, 2)) {
      out.push(`${p} in ${city} ${CONTACT_WORDS[out.length % CONTACT_WORDS.length]}`);
      out.push(`${p} ${city}, ${country} email`);
    }
  }
  return [...new Set(out)].slice(0, limit);
}

/** Category implied by a hostname. */
export function categoryFromHost(host: string): string | null {
  const h = host.toLowerCase();
  return HOST_TOKENS.find((t) => h.includes(t.token))?.category ?? null;
}
