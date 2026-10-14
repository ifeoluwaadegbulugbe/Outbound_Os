import { CATEGORY_TERMS } from "./queries";
import { ORBIT_CATEGORIES, orbitFit } from "./icp";
import { NG_STATE_CITIES } from "./ng-states";
import { PLATFORM_HANDLES } from "../domain/normalize";

/**
 * Filters for Instagram accounts found by following @mentions in the captions
 * of businesses we already have (official Business Discovery API only). An
 * account is kept only when it's a small business, in one of Orbit's service
 * categories, in a country we target. Everything else is skipped with a reason.
 */

export const MAX_FOLLOWERS = 100_000;

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;

/** Category from name, username and bio. Needs a name/username word or a specific bio phrase ("bridal makeup"); a loose bio word alone isn't enough. */
export function categoryFromProfile(p: { name: string; username: string; bio: string | null }): string | null {
  const name = words(p.name);
  const user = p.username.toLowerCase().replace(/[^a-z]/g, "");
  const bio = words(p.bio ?? "");
  let best: { category: string; score: number } | null = null;
  for (const c of CATEGORY_TERMS) {
    if (!ORBIT_CATEGORIES.has(c.category)) continue;
    let strong = 0;
    let weak = 0;
    let bioPhrase = 0;
    for (const ph of c.phrases.map((x) => words(x).trim()).filter(Boolean)) {
      if (name.includes(` ${ph} `)) strong += 3;
      else if (bio.includes(` ${ph} `) && ph.includes(" ")) bioPhrase += 2;
      else if (bio.includes(` ${ph} `)) weak += 2;
    }
    for (const t of c.tokens.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((x) => x.length >= 3)) {
      if (name.includes(` ${t} `)) strong += 2;
      else if (t.length >= 4 && user.includes(t)) strong += 2;
      else if (bio.includes(` ${t} `)) weak += 1;
    }
    if (!strong && !bioPhrase) continue;
    const score = strong + bioPhrase + weak;
    if (!best || score > best.score) best = { category: c.category, score };
  }
  return best?.category ?? null;
}

const OTHER_CITIES: Record<string, string[]> = {
  GH: ["Accra", "Kumasi", "Tamale", "Takoradi", "East Legon", "Tema", "Ghana"],
  KE: ["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Westlands", "Kenya"],
  ZA: ["Johannesburg", "Joburg", "Cape Town", "Durban", "Pretoria", "Sandton", "Soweto", "South Africa"],
};
const NG_EXTRA = ["Nigeria", "Naija", "Lekki", "Ikeja", "Victoria Island", "Ikoyi", "Surulere", "Yaba", "Ajah", "Festac", "Gbagada", "Magodo", "Wuse", "Maitama", "Garki", "Gwarinpa", "Asokoro", "Jabi", "Kubwa"];

/** Country (and Nigerian state/city) from what the owner wrote: bio, name, website, phone codes. */
export function locateProfile(text: string): { country: string; state: string | null; city: string | null } | null {
  const t = words(text);
  for (const [state, cities] of Object.entries(NG_STATE_CITIES)) {
    for (const city of cities) if (t.includes(words(city))) return { country: "NG", state, city };
  }
  for (const state of Object.keys(NG_STATE_CITIES)) {
    if (state.length > 3 && t.includes(words(`${state} state`))) return { country: "NG", state, city: null };
  }
  for (const w of NG_EXTRA) {
    if (t.includes(words(w))) return { country: "NG", state: ["Lekki", "Ikeja", "Victoria Island", "Ikoyi", "Surulere", "Yaba", "Ajah", "Festac", "Gbagada", "Magodo"].includes(w) ? "Lagos" : ["Wuse", "Maitama", "Garki", "Gwarinpa", "Asokoro", "Jabi", "Kubwa"].includes(w) ? "FCT" : null, city: null };
  }
  if (/\+234|\b0[789][01]\d{8}\b|\.ng\b/i.test(text)) return { country: "NG", state: null, city: null };
  for (const [country, cities] of Object.entries(OTHER_CITIES)) {
    for (const city of cities) if (t.includes(words(city))) return { country, state: null, city: city.includes(" ") || city.length > 5 ? city : null };
  }
  if (/\+233|\.com\.gh\b/i.test(text)) return { country: "GH", state: null, city: null };
  if (/\+254|\.co\.ke\b/i.test(text)) return { country: "KE", state: null, city: null };
  if (/\+27\b|\.co\.za\b/i.test(text)) return { country: "ZA", state: null, city: null };
  return null;
}

export type SnowballVerdict =
  | { keep: true; category: string; country: string; state: string | null; city: string | null }
  | { keep: false; reason: string };

export function judgeProfile(p: { name: string; username: string; bio: string | null; website: string | null; followers: number | null }): SnowballVerdict {
  if (PLATFORM_HANDLES.has(p.username.toLowerCase())) return { keep: false, reason: "platform account" };
  if (p.followers != null && p.followers > MAX_FOLLOWERS) return { keep: false, reason: `${p.followers} followers (not a small business)` };
  const category = categoryFromProfile(p);
  if (!category) return { keep: false, reason: "not one of the service categories" };
  const fit = orbitFit({ category, name: p.name });
  if (!fit.ok) return { keep: false, reason: fit.reason };
  const where = locateProfile(`${p.name} ${p.bio ?? ""} ${p.website ?? ""}`);
  if (!where) return { keep: false, reason: "location not stated" };
  return { keep: true, category, ...where };
}
