/**
 * Shared vocabulary: service-business categories, Orbit value propositions,
 * Nigerian cities. Pure data — safe to import from client components.
 */

export const CATEGORIES = [
  { key: "hair_stylist", label: "Hair stylist", group: "beauty", keywords: ["hair stylist", "hairstylist", "hair", "braids", "braider", "wig", "wigs", "frontal", "weave", "locs", "hair salon", "salon", "hairdresser", "silk press", "knotless"] },
  { key: "barber", label: "Barber", group: "beauty", keywords: ["barber", "barbershop", "barbing", "fade", "haircut", "barbing salon"] },
  { key: "nail_technician", label: "Nail technician", group: "beauty", keywords: ["nail tech", "nails", "nail technician", "manicure", "pedicure", "acrylic", "gel nails", "press on", "press-on", "nail artist", "nail studio", "nail bar"] },
  { key: "lash_technician", label: "Lash technician", group: "beauty", keywords: ["lash tech", "lashes", "lash extensions", "lash artist", "brows", "brow", "microblading", "lash technician", "lash studio"] },
  { key: "makeup_artist", label: "Makeup artist", group: "beauty", keywords: ["makeup artist", "mua", "makeup", "bridal makeup", "glam", "beat face", "gele"] },
  { key: "skincare", label: "Skincare / esthetician", group: "beauty", keywords: ["esthetician", "facial", "skincare clinic", "skin care", "aesthetics", "dermaplaning", "waxing"] },
  { key: "spa_wellness", label: "Spa & wellness", group: "wellness", keywords: ["spa", "massage", "wellness", "therapist", "reflexology", "sauna"] },
  { key: "fitness_trainer", label: "Fitness trainer", group: "wellness", keywords: ["personal trainer", "fitness coach", "gym", "pt", "fitness trainer", "pilates", "yoga"] },
  { key: "photographer", label: "Photographer", group: "creative", keywords: ["photographer", "photography", "photo studio", "photoshoot", "videographer", "shoot"] },
  { key: "event_planner", label: "Event planner", group: "events", keywords: ["event planner", "wedding planner", "events", "decor", "decorator", "event decor", "planner", "event management"] },
  { key: "fashion_designer", label: "Fashion designer / tailor", group: "creative", keywords: ["fashion designer", "tailor", "bespoke", "aso ebi", "asoebi", "made to measure", "couture", "fashion house"] },
  { key: "coach", label: "Coach", group: "professional", keywords: ["coach", "life coach", "business coach", "mentor", "coaching"] },
  { key: "consultant", label: "Consultant", group: "professional", keywords: ["consultant", "consulting", "advisory"] },
  { key: "tutor", label: "Tutor / teacher", group: "professional", keywords: ["tutor", "lessons", "classes", "teacher", "tutoring"] },
  { key: "freelancer", label: "Freelancer", group: "professional", keywords: ["freelancer", "freelance", "designer", "developer", "copywriter", "virtual assistant"] },
  { key: "caterer", label: "Caterer / private chef", group: "events", keywords: ["caterer", "catering", "private chef", "small chops", "cakes", "baker"] },
  { key: "cleaning_service", label: "Cleaning service", group: "home", keywords: ["cleaning service", "cleaning services", "cleaners", "house cleaning", "office cleaning", "deep cleaning", "laundry", "dry cleaning", "fumigation"] },
  { key: "beauty_salon", label: "Beauty salon", group: "beauty", keywords: ["beauty salon", "beauty parlour", "beauty parlor", "beauty studio", "unisex salon"] },
  { key: "designer", label: "Designer (graphic, web, interior)", group: "creative", keywords: ["graphic designer", "web designer", "interior designer", "interior decor", "branding"] },
  { key: "media_production", label: "Music & media production", group: "creative", keywords: ["studio", "music production", "recording studio", "video production"] },
  { key: "marketing_agency", label: "Marketing agency", group: "professional", keywords: ["marketing agency", "digital marketing", "advertising agency", "social media management", "pr agency"] },
  { key: "home_service", label: "Home services", group: "home", keywords: ["plumber", "electrician", "painter", "handyman", "pest control", "contractor", "solar installation", "ac repair"] },
  { key: "auto_service", label: "Auto services", group: "home", keywords: ["mechanic", "car wash", "auto repair", "car detailing", "vulcanizer"] },
  { key: "pet_service", label: "Pet services", group: "home", keywords: ["pet grooming", "dog grooming", "pet care", "vet"] },
  { key: "real_estate", label: "Real estate agent", group: "professional", keywords: ["real estate", "realtor", "property agent", "estate agent", "property management"] },
  { key: "health_practice", label: "Clinic / health practice", group: "wellness", keywords: ["clinic", "dental", "dentist", "physiotherapy", "optician", "eye clinic"] },
  { key: "legal_finance", label: "Law / accounting firm", group: "professional", keywords: ["law firm", "solicitor", "attorney", "accountant", "tax consultant", "insurance agent"] },
  { key: "travel_agency", label: "Travel agency", group: "professional", keywords: ["travel agency", "travel and tours", "visa services", "tour operator"] },
  { key: "printing_service", label: "Printing & branding", group: "creative", keywords: ["printing press", "printing", "branding", "souvenirs", "signage"] },
  { key: "tech_service", label: "IT & device repair", group: "professional", keywords: ["computer repair", "phone repair", "it services", "cctv installation"] },
  { key: "construction", label: "Construction & engineering", group: "professional", keywords: ["construction", "builders", "engineering services", "contractor"] },
  { key: "logistics", label: "Logistics & delivery", group: "professional", keywords: ["logistics", "dispatch", "courier", "freight", "haulage", "delivery service"] },
  { key: "tattoo_artist", label: "Tattoo & body art", group: "beauty", keywords: ["tattoo", "piercing", "body art"] },
  { key: "henna_artist", label: "Henna artist", group: "beauty", keywords: ["henna", "mehndi", "lalle"] },
  { key: "personal_stylist", label: "Personal stylist / image consultant", group: "beauty", keywords: ["personal stylist", "image consultant", "wardrobe stylist"] },
  { key: "florist", label: "Florist", group: "events", keywords: ["florist", "flowers", "floral"] },
  { key: "cake_designer", label: "Cake designer / custom baker", group: "events", keywords: ["cakes", "cake designer", "custom cakes", "confectionery"] },
  { key: "entertainer", label: "DJ / MC / entertainer", group: "events", keywords: ["dj", "mc", "compere", "hypeman", "event host", "live band"] },
  { key: "accountant", label: "Accountant / bookkeeper", group: "professional", keywords: ["accountant", "bookkeeping", "tax consultant", "chartered accountants"] },
  { key: "hr_recruiter", label: "HR consultant / recruiter", group: "professional", keywords: ["recruitment", "hr consulting", "staffing", "human resources"] },
  { key: "legal_practice", label: "Small law practice", group: "professional", keywords: ["law firm", "solicitors", "barristers", "legal practitioners", "chambers"] },
  { key: "immigration_consultant", label: "Immigration / relocation consultant", group: "professional", keywords: ["immigration", "visa consultant", "relocation", "study abroad"] },
  { key: "other_service", label: "Other service business", group: "other", keywords: [] },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as CategoryKey[];

export function categoryLabel(key: string | null | undefined): string {
  if (!key) return "Uncategorized";
  return CATEGORIES.find((c) => c.key === key)?.label ?? key.replace(/_/g, " ");
}

export function categoryGroup(key: string | null | undefined): string {
  return CATEGORIES.find((c) => c.key === key)?.group ?? "other";
}

/** Orbit capabilities a message may lead with. */
export const VALUE_PROPS = {
  bookings: { label: "Bookings", short: "take bookings without the back-and-forth in DMs" },
  clients: { label: "Clients", short: "keep every client's details and history in one place" },
  payments: { label: "Payments", short: "collect payments and see who still owes you" },
  invoices: { label: "Invoices", short: "send proper invoices in seconds" },
  reminders: { label: "Reminders", short: "send automatic appointment reminders so fewer clients no-show" },
  services: { label: "Services", short: "list your services and prices for clients" },
  tracking: { label: "Business tracking", short: "see how your business is actually doing each week" },
} as const;

export type ValuePropKey = keyof typeof VALUE_PROPS;

/** Most relevant Orbit value props per category (first = strongest). */
export const CATEGORY_VALUE_PROPS: Record<string, ValuePropKey[]> = {
  hair_stylist: ["bookings", "clients", "reminders"],
  barber: ["bookings", "reminders", "clients"],
  nail_technician: ["bookings", "clients", "reminders"],
  lash_technician: ["bookings", "reminders", "clients"],
  makeup_artist: ["bookings", "payments", "clients"],
  skincare: ["bookings", "clients", "reminders"],
  spa_wellness: ["bookings", "reminders", "payments"],
  fitness_trainer: ["clients", "bookings", "payments"],
  photographer: ["bookings", "payments", "invoices"],
  event_planner: ["clients", "invoices", "payments"],
  fashion_designer: ["clients", "payments", "invoices"],
  coach: ["clients", "bookings", "payments"],
  consultant: ["clients", "invoices", "payments"],
  tutor: ["bookings", "clients", "payments"],
  freelancer: ["clients", "invoices", "payments"],
  caterer: ["clients", "invoices", "payments"],
  cleaning_service: ["bookings", "invoices", "payments"],
  beauty_salon: ["bookings", "clients", "reminders"],
  designer: ["clients", "invoices", "payments"],
  media_production: ["bookings", "invoices", "payments"],
  marketing_agency: ["clients", "invoices", "tracking"],
  home_service: ["bookings", "invoices", "payments"],
  auto_service: ["bookings", "clients", "payments"],
  pet_service: ["bookings", "reminders", "clients"],
  real_estate: ["clients", "tracking", "payments"],
  health_practice: ["bookings", "reminders", "clients"],
  legal_finance: ["clients", "invoices", "payments"],
  travel_agency: ["clients", "payments", "invoices"],
  printing_service: ["clients", "invoices", "payments"],
  tech_service: ["bookings", "invoices", "clients"],
  construction: ["clients", "invoices", "payments"],
  logistics: ["bookings", "invoices", "payments"],
  tattoo_artist: ["bookings", "payments", "clients"],
  henna_artist: ["bookings", "payments", "clients"],
  personal_stylist: ["bookings", "clients", "payments"],
  florist: ["clients", "payments", "invoices"],
  cake_designer: ["clients", "payments", "invoices"],
  entertainer: ["bookings", "payments", "invoices"],
  accountant: ["clients", "invoices", "payments"],
  hr_recruiter: ["clients", "invoices", "tracking"],
  legal_practice: ["clients", "bookings", "invoices"],
  immigration_consultant: ["clients", "bookings", "payments"],
  other_service: ["bookings", "clients", "payments"],
};

export interface CityInfo {
  key: string;
  name: string;
  state: string;
  aliases: string[];
  /** south, west, north, east */
  bbox: [number, number, number, number];
}

export const NIGERIAN_CITIES: CityInfo[] = [
  { key: "lagos", name: "Lagos", state: "Lagos", aliases: ["lagos", "lag", "ikeja", "lekki", "vi", "victoria island", "ikoyi", "yaba", "surulere", "ajah", "magodo", "gbagada", "festac", "ogba", "ikorodu", "maryland", "oniru", "chevron", "sangotedo", "ojodu", "berger", "agege", "isolo", "egbeda", "ojota", "ketu", "lagos island", "mainland"], bbox: [6.38, 3.1, 6.7, 3.7] },
  { key: "abuja", name: "Abuja", state: "FCT", aliases: ["abuja", "fct", "wuse", "garki", "maitama", "asokoro", "gwarinpa", "jabi", "kubwa", "lugbe", "utako", "lokogoma", "katampe", "life camp"], bbox: [8.85, 7.25, 9.2, 7.6] },
  { key: "port_harcourt", name: "Port Harcourt", state: "Rivers", aliases: ["port harcourt", "portharcourt", "ph", "phc", "gra ph", "rumuola", "trans amadi", "rumuokoro", "eliozu"], bbox: [4.75, 6.92, 4.92, 7.1] },
  { key: "ibadan", name: "Ibadan", state: "Oyo", aliases: ["ibadan", "bodija", "ring road ibadan", "challenge", "dugbe", "akobo", "jericho", "samonda"], bbox: [7.3, 3.8, 7.5, 4.0] },
  { key: "benin_city", name: "Benin City", state: "Edo", aliases: ["benin city", "benin", "ugbowo", "gra benin", "sapele road", "ekenwan"], bbox: [6.28, 5.55, 6.42, 5.7] },
  { key: "kano", name: "Kano", state: "Kano", aliases: ["kano"], bbox: [11.93, 8.45, 12.07, 8.6] },
  { key: "enugu", name: "Enugu", state: "Enugu", aliases: ["enugu", "independence layout", "new haven", "trans ekulu"], bbox: [6.4, 7.45, 6.5, 7.56] },
  { key: "kaduna", name: "Kaduna", state: "Kaduna", aliases: ["kaduna"], bbox: [10.45, 7.38, 10.6, 7.5] },
  { key: "warri", name: "Warri", state: "Delta", aliases: ["warri", "effurun"], bbox: [5.48, 5.7, 5.6, 5.82] },
  { key: "uyo", name: "Uyo", state: "Akwa Ibom", aliases: ["uyo"], bbox: [4.98, 7.88, 5.08, 7.98] },
  { key: "owerri", name: "Owerri", state: "Imo", aliases: ["owerri"], bbox: [5.45, 6.98, 5.53, 7.08] },
  { key: "abeokuta", name: "Abeokuta", state: "Ogun", aliases: ["abeokuta"], bbox: [7.1, 3.28, 7.2, 3.4] },
];

export function findCity(text: string | null | undefined): CityInfo | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  // Prefer explicit city names over neighbourhood aliases.
  for (const c of NIGERIAN_CITIES) if (t.includes(` ${c.name.toLowerCase()} `)) return c;
  for (const c of NIGERIAN_CITIES) {
    for (const a of c.aliases) {
      // Very short aliases ("ph", "vi", "lag") only count as standalone tokens.
      if (t.includes(` ${a} `)) return c;
    }
  }
  return null;
}

export const CHANNELS = ["instagram", "tiktok", "whatsapp", "email", "linkedin", "facebook"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  whatsapp: "WhatsApp",
  email: "Email",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

export const PROSPECT_STATUSES = [
  "NEW", "RESEARCHING", "QUALIFIED", "READY", "APPROVED", "CONTACTED", "REPLIED", "INTERESTED",
  "NOT_INTERESTED", "FOLLOW_UP", "DEMO", "SIGNED_UP", "ACTIVATED", "PAID", "LOST", "DO_NOT_CONTACT",
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const STATUS_LABELS: Record<ProspectStatus, string> = {
  NEW: "New",
  RESEARCHING: "Researching",
  QUALIFIED: "Qualified",
  READY: "Ready",
  APPROVED: "Approved",
  CONTACTED: "Contacted",
  REPLIED: "Replied",
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not interested",
  FOLLOW_UP: "Follow-up",
  DEMO: "Demo",
  SIGNED_UP: "Signed up",
  ACTIVATED: "Activated",
  PAID: "Paid",
  LOST: "Lost",
  DO_NOT_CONTACT: "Do not contact",
};

export const MESSAGE_ANGLES = [
  { key: "problem_first", label: "Problem-first", hint: "Open with a specific friction you noticed (e.g. bookings in DMs)." },
  { key: "curiosity", label: "Curiosity", hint: "Ask a light question about how they handle something." },
  { key: "outcome", label: "Outcome", hint: "Lead with the result: fewer no-shows, less admin." },
  { key: "product_intro", label: "Product introduction", hint: "Plainly say what you're building and why they came to mind." },
  { key: "social_proof", label: "Social proof", hint: "Only verified proof from settings; otherwise falls back." },
  { key: "feedback_request", label: "Feedback request", hint: "Ask for their honest opinion as a practitioner." },
  { key: "founder", label: "Founder outreach", hint: "Personal note from the founder. Use sparingly." },
] as const;
export type MessageAngle = (typeof MESSAGE_ANGLES)[number]["key"];

/** Suggested Instagram hashtags per category + city for discovery. */
export function suggestHashtags(category: string, cityKey: string): string[] {
  const city = NIGERIAN_CITIES.find((c) => c.key === cityKey)?.name.toLowerCase().replace(/\s+/g, "") ?? cityKey;
  const base: Record<string, string[]> = {
    hair_stylist: ["hairstylist", "braids", "wigs", "hairsalon", "knotlessbraids"],
    barber: ["barber", "barbershop"],
    nail_technician: ["nails", "nailtech", "naildesigns", "acrylicnails"],
    lash_technician: ["lashes", "lashtech", "lashextensions", "brows"],
    makeup_artist: ["mua", "makeupartist", "bridalmakeup"],
    skincare: ["esthetician", "skincare", "facials"],
    spa_wellness: ["spa", "massage"],
    fitness_trainer: ["personaltrainer", "fitness"],
    photographer: ["photographer", "photography"],
    event_planner: ["eventplanner", "weddingplanner", "eventdecor"],
    fashion_designer: ["fashiondesigner", "asoebi", "bespoke"],
  };
  return (base[category] ?? ["business"]).map((b) => `${city}${b}`);
}
