/**
 * Built-in African cities (seeded into the editable `locations` table) and
 * default country compliance policies. Bounding boxes are approximate city
 * extents (south, west, north, east) used for OpenStreetMap discovery.
 * Add more cities in Settings → Locations — no code change needed.
 */

export interface LocationSeed {
  country_code: string;
  country_name: string;
  region: string | null;
  city: string;
  bbox: [number, number, number, number];
  aliases?: string[];
}

export const AFRICAN_CITIES: LocationSeed[] = [
  // Nigeria (initial market)
  { country_code: "NG", country_name: "Nigeria", region: "Lagos", city: "Lagos", bbox: [6.38, 3.1, 6.7, 3.7], aliases: ["lekki", "ikeja", "yaba", "surulere", "ajah", "victoria island", "ikoyi", "gbagada", "magodo", "festac"] },
  { country_code: "NG", country_name: "Nigeria", region: "FCT", city: "Abuja", bbox: [8.85, 7.25, 9.2, 7.6], aliases: ["wuse", "garki", "maitama", "gwarinpa", "jabi", "kubwa"] },
  { country_code: "NG", country_name: "Nigeria", region: "Rivers", city: "Port Harcourt", bbox: [4.75, 6.92, 4.92, 7.1], aliases: ["ph", "phc"] },
  { country_code: "NG", country_name: "Nigeria", region: "Oyo", city: "Ibadan", bbox: [7.3, 3.8, 7.5, 4.0] },
  { country_code: "NG", country_name: "Nigeria", region: "Edo", city: "Benin City", bbox: [6.28, 5.55, 6.42, 5.7] },
  { country_code: "NG", country_name: "Nigeria", region: "Kano", city: "Kano", bbox: [11.93, 8.45, 12.07, 8.6] },
  { country_code: "NG", country_name: "Nigeria", region: "Enugu", city: "Enugu", bbox: [6.4, 7.45, 6.5, 7.56] },
  { country_code: "NG", country_name: "Nigeria", region: "Kaduna", city: "Kaduna", bbox: [10.45, 7.38, 10.6, 7.5] },
  { country_code: "NG", country_name: "Nigeria", region: "Delta", city: "Warri", bbox: [5.48, 5.7, 5.6, 5.82] },
  { country_code: "NG", country_name: "Nigeria", region: "Delta", city: "Asaba", bbox: [6.15, 6.66, 6.25, 6.78] },
  { country_code: "NG", country_name: "Nigeria", region: "Akwa Ibom", city: "Uyo", bbox: [4.98, 7.88, 5.08, 7.98] },
  { country_code: "NG", country_name: "Nigeria", region: "Imo", city: "Owerri", bbox: [5.45, 6.98, 5.53, 7.08] },
  { country_code: "NG", country_name: "Nigeria", region: "Ogun", city: "Abeokuta", bbox: [7.1, 3.28, 7.2, 3.4] },
  { country_code: "NG", country_name: "Nigeria", region: "Plateau", city: "Jos", bbox: [9.85, 8.83, 9.98, 8.95] },
  { country_code: "NG", country_name: "Nigeria", region: "Kwara", city: "Ilorin", bbox: [8.43, 4.5, 8.55, 4.62] },
  { country_code: "NG", country_name: "Nigeria", region: "Cross River", city: "Calabar", bbox: [4.92, 8.3, 5.03, 8.37] },
  // Ghana
  { country_code: "GH", country_name: "Ghana", region: "Greater Accra", city: "Accra", bbox: [5.52, -0.3, 5.7, -0.1], aliases: ["east legon", "osu", "airport residential"] },
  { country_code: "GH", country_name: "Ghana", region: "Ashanti", city: "Kumasi", bbox: [6.62, -1.7, 6.75, -1.55] },
  // Kenya
  { country_code: "KE", country_name: "Kenya", region: "Nairobi", city: "Nairobi", bbox: [-1.4, 36.7, -1.16, 37.0], aliases: ["westlands", "kilimani", "karen"] },
  { country_code: "KE", country_name: "Kenya", region: "Mombasa", city: "Mombasa", bbox: [-4.1, 39.6, -3.98, 39.72] },
  // South Africa
  { country_code: "ZA", country_name: "South Africa", region: "Gauteng", city: "Johannesburg", bbox: [-26.35, 27.9, -26.05, 28.2], aliases: ["sandton", "rosebank"] },
  { country_code: "ZA", country_name: "South Africa", region: "Western Cape", city: "Cape Town", bbox: [-34.1, 18.35, -33.85, 18.7] },
  { country_code: "ZA", country_name: "South Africa", region: "KwaZulu-Natal", city: "Durban", bbox: [-29.95, 30.9, -29.75, 31.1] },
  { country_code: "ZA", country_name: "South Africa", region: "Gauteng", city: "Pretoria", bbox: [-25.85, 28.1, -25.65, 28.35] },
  // East, West, North & Central Africa
  { country_code: "RW", country_name: "Rwanda", region: "Kigali", city: "Kigali", bbox: [-2.02, 29.98, -1.88, 30.18] },
  { country_code: "UG", country_name: "Uganda", region: "Central", city: "Kampala", bbox: [0.25, 32.5, 0.4, 32.68] },
  { country_code: "TZ", country_name: "Tanzania", region: "Dar es Salaam", city: "Dar es Salaam", bbox: [-6.95, 39.15, -6.7, 39.35] },
  { country_code: "ET", country_name: "Ethiopia", region: "Addis Ababa", city: "Addis Ababa", bbox: [8.9, 38.7, 9.08, 38.87] },
  { country_code: "ZM", country_name: "Zambia", region: "Lusaka", city: "Lusaka", bbox: [-15.48, 28.22, -15.35, 28.38] },
  { country_code: "CI", country_name: "Côte d'Ivoire", region: "Abidjan", city: "Abidjan", bbox: [5.25, -4.1, 5.45, -3.9] },
  { country_code: "SN", country_name: "Senegal", region: "Dakar", city: "Dakar", bbox: [14.65, -17.52, 14.8, -17.35] },
  { country_code: "CM", country_name: "Cameroon", region: "Littoral", city: "Douala", bbox: [3.98, 9.65, 4.12, 9.8] },
  { country_code: "EG", country_name: "Egypt", region: "Cairo", city: "Cairo", bbox: [29.95, 31.15, 30.15, 31.4] },
  { country_code: "MA", country_name: "Morocco", region: "Casablanca-Settat", city: "Casablanca", bbox: [33.5, -7.7, 33.65, -7.48] },
];

export function locationKey(countryCode: string, city: string): string {
  return `${countryCode.toLowerCase()}_${city.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

/**
 * Default cold-email policy per country. Engineering defaults from public
 * summaries of each law — NOT legal advice; review with counsel and adjust in
 * Settings → Countries. Unknown countries default to consent_required.
 */
export const COUNTRY_POLICY_DEFAULTS: Record<string, { cold_email: "allowed" | "consent_required" | "blocked"; legal_basis: string; notes: string }> = {
  NG: { cold_email: "allowed", legal_basis: "NDPA 2023 s.25 legitimate interest", notes: "Requires a documented Legitimate Interest Assessment (NDPC GAID), relevant business offer, sender identification and an easy opt-out honoured immediately." },
  GH: { cold_email: "consent_required", legal_basis: "Data Protection Act 2012 s.40", notes: "Prior written consent required before direct marketing; continuing after an objection is an offence." },
  KE: { cold_email: "consent_required", legal_basis: "Data Protection Act 2019 s.37", notes: "Commercial use (incl. electronic direct marketing) needs consent unless authorised by law." },
  ZA: { cold_email: "consent_required", legal_basis: "POPIA s.69", notes: "Electronic direct marketing needs prior consent (or an existing customer relationship); POPIA also protects juristic persons. An opt-out link does not cure missing consent." },
};

export function defaultPolicy(countryCode: string) {
  return COUNTRY_POLICY_DEFAULTS[countryCode] ?? {
    cold_email: "consent_required" as const,
    legal_basis: "Not assessed",
    notes: "Not yet reviewed — treated as consent required until an admin reviews local law and changes the policy.",
  };
}

export const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(AFRICAN_CITIES.map((c) => [c.country_code, c.country_name]));
