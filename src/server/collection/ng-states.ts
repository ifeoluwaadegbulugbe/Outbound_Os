import fs from "node:fs";
import path from "node:path";

/**
 * Nigerian state (36 states + FCT) for a coordinate, by point-in-polygon on
 * the official ADM1 boundaries (geoBoundaries, CC BY 4.0, data/ng-states.geojson).
 * Most Overture records have no region field, so coordinates are the reliable
 * way to measure coverage per state.
 */

export const NG_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo",
  "Ekiti", "Enugu", "FCT", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa",
  "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const;

/** State capitals / main cities, for state-by-state searches and the manual query list. */
export const NG_STATE_CITIES: Record<string, string[]> = {
  Abia: ["Umuahia", "Aba"], Adamawa: ["Yola", "Mubi"], "Akwa Ibom": ["Uyo", "Eket"], Anambra: ["Awka", "Onitsha", "Nnewi"],
  Bauchi: ["Bauchi"], Bayelsa: ["Yenagoa"], Benue: ["Makurdi", "Gboko"], Borno: ["Maiduguri"], "Cross River": ["Calabar"],
  Delta: ["Asaba", "Warri", "Sapele"], Ebonyi: ["Abakaliki"], Edo: ["Benin City", "Auchi"], Ekiti: ["Ado-Ekiti"], Enugu: ["Enugu", "Nsukka"],
  FCT: ["Abuja", "Gwagwalada"], Gombe: ["Gombe"], Imo: ["Owerri", "Orlu"], Jigawa: ["Dutse"], Kaduna: ["Kaduna", "Zaria"],
  Kano: ["Kano"], Katsina: ["Katsina"], Kebbi: ["Birnin Kebbi"], Kogi: ["Lokoja", "Okene"], Kwara: ["Ilorin"], Lagos: ["Lagos", "Ikeja", "Lekki"],
  Nasarawa: ["Lafia", "Keffi"], Niger: ["Minna", "Suleja"], Ogun: ["Abeokuta", "Ijebu-Ode", "Sagamu"], Ondo: ["Akure", "Ondo"],
  Osun: ["Osogbo", "Ile-Ife", "Ilesa"], Oyo: ["Ibadan", "Ogbomoso", "Oyo"], Plateau: ["Jos"], Rivers: ["Port Harcourt", "Bonny"],
  Sokoto: ["Sokoto"], Taraba: ["Jalingo"], Yobe: ["Damaturu"], Zamfara: ["Gusau"],
};

type Ring = number[][];
interface StateShape { name: string; bbox: [number, number, number, number]; polygons: Ring[][] }

let shapes: StateShape[] | null = null;

function load(): StateShape[] {
  if (shapes) return shapes;
  const file = path.join(process.cwd(), "data", "ng-states.geojson");
  if (!fs.existsSync(file)) return (shapes = []);
  const gj = JSON.parse(fs.readFileSync(file, "utf8")) as { features: { properties: { shapeName: string }; geometry: { type: string; coordinates: unknown } }[] };
  shapes = gj.features.map((f) => {
    const polygons = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const poly of polygons) for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const raw = f.properties.shapeName;
    return { name: /federal capital|abuja/i.test(raw) ? "FCT" : raw, bbox: [minX, minY, maxX, maxY], polygons };
  });
  return shapes;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The Nigerian state containing (lat, lng), or null if outside Nigeria. */
export function nigeriaStateAt(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const s of load()) {
    const [minX, minY, maxX, maxY] = s.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    for (const poly of s.polygons) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))) return s.name;
    }
  }
  return null;
}

const CODES: Record<string, string> = {
  LA: "Lagos", LAG: "Lagos", FC: "FCT", FCT: "FCT", AB: "Abia", AD: "Adamawa", AK: "Akwa Ibom", AN: "Anambra", BA: "Bauchi", BY: "Bayelsa",
  BE: "Benue", BO: "Borno", CR: "Cross River", DE: "Delta", EB: "Ebonyi", ED: "Edo", EK: "Ekiti", EN: "Enugu", GO: "Gombe", IM: "Imo",
  JI: "Jigawa", KD: "Kaduna", KN: "Kano", KT: "Katsina", KE: "Kebbi", KO: "Kogi", KW: "Kwara", NA: "Nasarawa", NI: "Niger", OG: "Ogun",
  ON: "Ondo", OS: "Osun", OY: "Oyo", PL: "Plateau", RI: "Rivers", SO: "Sokoto", TA: "Taraba", YO: "Yobe", ZA: "Zamfara",
};

/** Clean a free-text region ("LA", "Lagos State", "NG-FC", "Abuja Federal Capital Territory") to a state name. */
export function normalizeNgState(region: string | null | undefined): string | null {
  if (!region) return null;
  const r = region.trim().replace(/^NG-/i, "").replace(/\s+state$/i, "");
  if (CODES[r.toUpperCase()]) return CODES[r.toUpperCase()];
  if (/federal capital|^abuja/i.test(r)) return "FCT";
  return NG_STATES.find((s) => s.toLowerCase() === r.toLowerCase().replace(/-/g, " ")) ?? null;
}
