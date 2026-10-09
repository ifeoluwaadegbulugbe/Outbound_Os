import { z } from "zod";
import { CATEGORIES, findCity, PROSPECT_STATUSES, categoryLabel } from "./taxonomy";

/**
 * Filter language used by segments, ICP rules, saved views and Discover.
 * A JSON tree of AND / OR / NOT over a whitelist of fields; compiled to
 * parameterized SQL in filters-sql.ts. Pure — safe for client components.
 */

export const FIELD_DEFS = {
  business_name: { label: "Business name", type: "text" },
  bio: { label: "Bio", type: "text" },
  category: { label: "Category", type: "enum", options: CATEGORIES.map((c) => c.key) },
  city: { label: "City", type: "text" },
  state: { label: "State", type: "text" },
  country: { label: "Country", type: "text" },
  area: { label: "Area", type: "text" },
  status: { label: "Status", type: "enum", options: [...PROSPECT_STATUSES] },
  source: { label: "Source", type: "text" },
  icp_score: { label: "ICP score", type: "number" },
  priority_score: { label: "Priority", type: "number" },
  intent_score: { label: "Intent score", type: "number" },
  fit_score: { label: "Fit score", type: "number" },
  completeness_score: { label: "Data completeness", type: "number" },
  follower_count: { label: "Followers", type: "number" },
  posting_frequency: { label: "Posts per week", type: "number" },
  days_since_post: { label: "Days since last post", type: "number" },
  contact_count: { label: "Times contacted", type: "number" },
  services: { label: "Services", type: "array" },
  active: { label: "Active (posted ≤30d)", type: "boolean" },
  accepts_bookings: { label: "Takes bookings", type: "boolean" },
  has_booking_link: { label: "Has booking link", type: "boolean" },
  accepts_whatsapp_bookings: { label: "WhatsApp bookings", type: "boolean" },
  dm_bookings: { label: "Books via DMs", type: "boolean" },
  has_website: { label: "Has website", type: "boolean" },
  has_instagram: { label: "Has Instagram", type: "boolean" },
  has_tiktok: { label: "Has TikTok", type: "boolean" },
  has_phone: { label: "Has phone/WhatsApp", type: "boolean" },
  has_email: { label: "Has email", type: "boolean" },
  uses_booking_software: { label: "Uses booking software", type: "boolean" },
  contacted: { label: "Contacted", type: "boolean" },
  signed_up: { label: "Signed up", type: "boolean" },
  activated: { label: "Activated", type: "boolean" },
  paid: { label: "Paid", type: "boolean" },
  do_not_contact: { label: "Do not contact", type: "boolean" },
  is_demo: { label: "Demo data", type: "boolean" },
} as const;

export type FieldKey = keyof typeof FIELD_DEFS;
export const FIELD_KEYS = Object.keys(FIELD_DEFS) as [FieldKey, ...FieldKey[]];
export const CMPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "not_in", "is_true", "is_false", "is_set", "is_not_set"] as const;
export type Cmp = (typeof CMPS)[number];

export type Condition = { field: FieldKey; cmp: Cmp; value?: string | number | boolean | string[] };
export type FilterNode = { op: "and" | "or"; children: FilterNode[] } | { op: "not"; child: FilterNode } | Condition;

export const conditionSchema = z.object({
  field: z.enum(FIELD_KEYS),
  cmp: z.enum(CMPS),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(100)).max(50)]).optional(),
});

export const filterSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), children: z.array(filterSchema).max(30) }),
    z.object({ op: z.literal("not"), child: filterSchema }),
    conditionSchema,
  ]),
) as z.ZodType<FilterNode>;

export function isGroup(n: FilterNode): n is { op: "and" | "or"; children: FilterNode[] } {
  return "op" in n && (n.op === "and" || n.op === "or");
}
export function isNot(n: FilterNode): n is { op: "not"; child: FilterNode } {
  return "op" in n && n.op === "not";
}

const CMP_TEXT: Record<Cmp, string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", not_contains: "doesn't contain",
  in: "is any of", not_in: "is none of", is_true: "is true", is_false: "is false", is_set: "is set", is_not_set: "is empty",
};

function valueText(field: FieldKey, v: Condition["value"]): string {
  if (Array.isArray(v)) return v.map((x) => (field === "category" ? categoryLabel(x) : x)).join(", ");
  if (field === "category" && typeof v === "string") return categoryLabel(v);
  return String(v);
}

/** Human-readable rendering: CATEGORY = Nail technician AND CITY = Lagos */
export function describeFilter(n: FilterNode | null | undefined): string {
  if (!n) return "All prospects";
  if (isGroup(n)) {
    if (!n.children.length) return "All prospects";
    const inner = n.children.map(describeFilter).join(n.op === "and" ? " AND " : " OR ");
    return n.children.length > 1 ? `(${inner})` : inner;
  }
  if (isNot(n)) return `NOT ${describeFilter(n.child)}`;
  const def = FIELD_DEFS[n.field];
  if (n.cmp === "is_true") return def.label;
  if (n.cmp === "is_false") return `not ${def.label.toLowerCase()}`;
  if (n.cmp === "is_set" || n.cmp === "is_not_set") return `${def.label} ${CMP_TEXT[n.cmp]}`;
  return `${def.label} ${CMP_TEXT[n.cmp]} ${valueText(n.field, n.value)}`;
}

// ── Natural language → filter (deterministic parser) ───────────────────────

export interface ParsedFilter {
  filter: FilterNode;
  explanation: string[];
  /** Words we didn't understand (shown to the user, never silently dropped). */
  unparsed: string[];
}

const PLURALS: Record<string, string> = {
  "nail techs": "nail_technician", "nail technicians": "nail_technician", "nail tech": "nail_technician",
  "lash techs": "lash_technician", "lash technicians": "lash_technician", "lash tech": "lash_technician",
  "hair stylists": "hair_stylist", "hairstylists": "hair_stylist", "stylists": "hair_stylist", "braiders": "hair_stylist", "hair salons": "hair_stylist",
  "barbers": "barber", "barbershops": "barber",
  "makeup artists": "makeup_artist", "muas": "makeup_artist", "make up artists": "makeup_artist",
  "photographers": "photographer", "event planners": "event_planner", "wedding planners": "event_planner",
  "coaches": "coach", "consultants": "consultant", "freelancers": "freelancer", "tutors": "tutor",
  "fashion designers": "fashion_designer", "tailors": "fashion_designer", "caterers": "caterer",
  "spas": "spa_wellness", "estheticians": "skincare", "personal trainers": "fitness_trainer", "trainers": "fitness_trainer",
};
const GROUP_WORDS: Record<string, string[]> = {
  beauty: CATEGORIES.filter((c) => c.group === "beauty").map((c) => c.key),
  wellness: CATEGORIES.filter((c) => c.group === "wellness").map((c) => c.key),
  creative: CATEGORIES.filter((c) => c.group === "creative").map((c) => c.key),
};

function num(s: string): number {
  const m = /^([\d.,]+)\s*(k|m)?$/i.exec(s.trim());
  if (!m) return Number.NaN;
  const n = Number(m[1].replace(/,/g, ""));
  return m[2]?.toLowerCase() === "k" ? n * 1000 : m[2]?.toLowerCase() === "m" ? n * 1_000_000 : n;
}

export function parseNaturalLanguage(input: string): ParsedFilter {
  let text = ` ${input.toLowerCase().replace(/[“”"]/g, " ").replace(/\s+/g, " ")} `;
  const conds: FilterNode[] = [];
  const explanation: string[] = [];
  const consume = (re: RegExp) => {
    text = text.replace(re, " ");
  };

  // Numeric comparisons
  const numericRules: { re: RegExp; field: FieldKey; label: string }[] = [
    { re: /(more than|over|above|greater than|at least|>=|>|min(?:imum)?)\s*([\d.,]+\s*[km]?)\s*followers?/, field: "follower_count", label: "Followers" },
    { re: /([\d.,]+\s*[km]?)\s*\+\s*followers?/, field: "follower_count", label: "Followers" },
    { re: /(less than|under|below|fewer than|at most|<=|<|max(?:imum)?)\s*([\d.,]+\s*[km]?)\s*followers?/, field: "follower_count", label: "Followers" },
    { re: /(?:icp|icp score|score|fit)\s*(>=|>|above|over|greater than|at least|of at least)\s*(\d{1,3})/, field: "icp_score", label: "ICP score" },
    { re: /(?:icp|icp score|score)\s*(<=|<|below|under|less than)\s*(\d{1,3})/, field: "icp_score", label: "ICP score" },
    { re: /priority\s*(>=|>|above|over|at least)\s*(\d{1,3})/, field: "priority_score", label: "Priority" },
  ];
  for (const r of numericRules) {
    const m = r.re.exec(text);
    if (!m) continue;
    let op = m.length === 3 ? m[1] : "at least";
    let value = num(m.length === 3 ? m[2] : m[1]);
    if (r.re.source.startsWith("([\\d")) {
      op = "at least";
      value = num(m[1]);
    }
    if (Number.isNaN(value)) continue;
    const lt = /less|under|below|fewer|at most|<|max/.test(op);
    const strict = /more than|over|above|greater|>$|^>$|less than|under|below|fewer|^<$/.test(op) && !/at least|at most|>=|<=/.test(op);
    const cmp: Cmp = lt ? (strict ? "lt" : "lte") : strict ? "gt" : "gte";
    conds.push({ field: r.field, cmp, value });
    explanation.push(`${r.label} ${CMP_TEXT[cmp]} ${value.toLocaleString()}`);
    consume(r.re);
  }

  // Negated categories/cities: "excluding barbers", "not in abuja"
  const negCats: string[] = [];
  for (const [w, key] of Object.entries(PLURALS)) {
    const re = new RegExp(`\\b(?:not|excluding|except|no|without)\\s+${w}\\b`);
    if (re.test(text)) {
      negCats.push(key);
      consume(re);
    }
  }
  const negCity = /\b(?:not in|outside|excluding)\s+([a-z ]+?)(?=\s(?:with|and|that|who|,)|\s*$)/.exec(text);
  if (negCity) {
    const city = findCity(negCity[1]);
    if (city) {
      conds.push({ op: "not", child: { field: "city", cmp: "eq", value: city.name } });
      explanation.push(`City is not ${city.name}`);
      consume(new RegExp(negCity[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }

  // Categories
  const cats = new Set<string>();
  for (const [w, key] of Object.entries(PLURALS).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`\\b${w}\\b`);
    if (re.test(text)) {
      cats.add(key);
      consume(re);
    }
  }
  for (const c of CATEGORIES) {
    for (const k of [...c.keywords].sort((a, b) => b.length - a.length)) {
      if (k.length < 4) continue;
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`);
      if (re.test(text) && !["salon", "hair", "shoot", "events", "planner", "classes", "lessons"].includes(k)) {
        cats.add(c.key);
        consume(re);
      }
    }
  }
  for (const [g, keys] of Object.entries(GROUP_WORDS)) {
    const re = new RegExp(`\\b${g}\\b`);
    if (re.test(text)) {
      keys.forEach((k) => cats.add(k));
      consume(re);
      explanation.push(`${g[0].toUpperCase()}${g.slice(1)} categories`);
    }
  }
  if (cats.size === 1) {
    const [k] = [...cats];
    conds.push({ field: "category", cmp: "eq", value: k });
    explanation.push(`Category = ${categoryLabel(k)}`);
  } else if (cats.size > 1) {
    conds.push({ field: "category", cmp: "in", value: [...cats] });
    if (!explanation.some((e) => e.endsWith("categories"))) explanation.push(`Category is any of ${[...cats].map(categoryLabel).join(", ")}`);
  }
  if (negCats.length) {
    conds.push({ field: "category", cmp: "not_in", value: negCats });
    explanation.push(`Category is none of ${negCats.map(categoryLabel).join(", ")}`);
  }

  // Cities (all mentioned, OR'd)
  const cityNames = new Set<string>();
  for (const part of text.split(/\b(?:and|or|,)\b/)) {
    const c = findCity(part);
    if (c) {
      cityNames.add(c.name);
    }
  }
  if (cityNames.size) {
    for (const name of cityNames) consume(new RegExp(`\\b(in\\s+)?${name.toLowerCase()}\\b`, "g"));
    // also remove alias words that matched
    if (cityNames.size === 1) {
      const [c] = [...cityNames];
      conds.push({ field: "city", cmp: "eq", value: c });
      explanation.push(`City = ${c}`);
    } else {
      conds.push({ field: "city", cmp: "in", value: [...cityNames] });
      explanation.push(`City is any of ${[...cityNames].join(", ")}`);
    }
  }

  // Boolean phrases
  const boolRules: { re: RegExp; field: FieldKey; value: boolean; label: string }[] = [
    { re: /\b(without|no|missing)\s+(a\s+)?booking links?\b/, field: "has_booking_link", value: false, label: "No booking link" },
    { re: /\b(with|has|have|having)?\s*(a\s+)?booking links?\b/, field: "has_booking_link", value: true, label: "Has booking link" },
    { re: /\b(accept|accepts|accepting|take|takes|taking|that take|who take)\s+(online\s+)?bookings?\b/, field: "accepts_bookings", value: true, label: "Takes bookings" },
    { re: /\b(whatsapp|whats app)\s*(bookings?)?\b/, field: "accepts_whatsapp_bookings", value: true, label: "Books via WhatsApp" },
    { re: /\b(book|bookings?)\s+(via|through|in)\s+dms?\b|\bdm bookings?\b/, field: "dm_bookings", value: true, label: "Books via DMs" },
    { re: /\b(without|no)\s+(a\s+)?website\b/, field: "has_website", value: false, label: "No website" },
    { re: /\b(with|has|have)\s+(a\s+)?websites?\b/, field: "has_website", value: true, label: "Has website" },
    { re: /\b(not|never|un)\s*contacted\b|\bnew leads?\b/, field: "contacted", value: false, label: "Not contacted yet" },
    { re: /\bcontacted\b/, field: "contacted", value: true, label: "Contacted" },
    { re: /\bsigned up\b|\bsignups?\b/, field: "signed_up", value: true, label: "Signed up" },
    { re: /\bactivated\b/, field: "activated", value: true, label: "Activated" },
    { re: /\bpaid\b|\bpaying\b|\bcustomers\b/, field: "paid", value: true, label: "Paid" },
    { re: /\b(inactive|dormant)\b/, field: "active", value: false, label: "Inactive" },
    { re: /\bactive\b/, field: "active", value: true, label: "Active (posted in last 30 days)" },
    { re: /\b(with|has|on)\s+instagram\b|\binstagram\b/, field: "has_instagram", value: true, label: "Has Instagram" },
    { re: /\b(with|has|on)\s+tiktok\b|\btiktok\b/, field: "has_tiktok", value: true, label: "Has TikTok" },
    { re: /\b(without|no)\s+email\b/, field: "has_email", value: false, label: "No email" },
    { re: /\b(with|has)\s+(an\s+)?email\b/, field: "has_email", value: true, label: "Has email" },
    { re: /\b(with|has)\s+(a\s+)?phone( number)?\b/, field: "has_phone", value: true, label: "Has phone" },
  ];
  for (const r of boolRules) {
    if (r.re.test(text)) {
      if (!conds.some((c) => "field" in c && c.field === r.field)) {
        conds.push({ field: r.field, cmp: r.value ? "is_true" : "is_false" });
        explanation.push(r.label);
      }
      consume(r.re);
    }
  }

  const filler = new Set(["in", "with", "and", "or", "that", "who", "the", "a", "an", "of", "businesses", "business", "all", "show", "me", "find", "prospects", "leads", "based", "than", "more", "have", "has", "are", "is", "from", "located", "for", "list", "get", "accounts", "profiles", "people", "nigeria", "nigerian", "service", "services", "&", "-", "within"]);
  const unparsed = text.split(/\s+/).filter((w) => w && !filler.has(w) && !/^[,.;:!?]+$/.test(w) && !findCity(w));
  return { filter: { op: "and", children: conds }, explanation, unparsed };
}
