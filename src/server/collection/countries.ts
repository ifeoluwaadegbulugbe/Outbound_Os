/**
 * Collection coverage: countries in priority order (Nigeria first), their
 * bounding boxes (south, west, north, east) and national domain suffixes.
 * Bounding boxes are deliberately generous; rows are also filtered by the
 * country code the source reports, so neighbouring countries don't leak in.
 */

export interface CollectionCountry {
  cc: string;
  name: string;
  bbox: [number, number, number, number];
  /** National second-level domains used for website discovery (Common Crawl). */
  domains: string[];
  priority: number;
}

export const COLLECTION_COUNTRIES: CollectionCountry[] = [
  { cc: "NG", name: "Nigeria", bbox: [4.2, 2.6, 13.95, 14.7], domains: ["com.ng", "ng"], priority: 100 },
  { cc: "GH", name: "Ghana", bbox: [4.7, -3.3, 11.2, 1.25], domains: ["com.gh"], priority: 90 },
  { cc: "KE", name: "Kenya", bbox: [-4.75, 33.9, 5.05, 41.95], domains: ["co.ke"], priority: 88 },
  { cc: "ZA", name: "South Africa", bbox: [-34.9, 16.4, -22.1, 32.95], domains: ["co.za"], priority: 86 },
  { cc: "UG", name: "Uganda", bbox: [-1.5, 29.5, 4.25, 35.05], domains: ["co.ug"], priority: 80 },
  { cc: "TZ", name: "Tanzania", bbox: [-11.8, 29.3, -0.95, 40.5], domains: ["co.tz"], priority: 78 },
  { cc: "RW", name: "Rwanda", bbox: [-2.85, 28.85, -1.04, 30.9], domains: ["rw"], priority: 76 },
  { cc: "ET", name: "Ethiopia", bbox: [3.4, 32.95, 14.9, 48.0], domains: ["com.et"], priority: 60 },
  { cc: "ZM", name: "Zambia", bbox: [-18.1, 21.95, -8.2, 33.75], domains: ["co.zm"], priority: 58 },
  { cc: "CM", name: "Cameroon", bbox: [1.65, 8.45, 13.1, 16.2], domains: ["cm"], priority: 56 },
  { cc: "CI", name: "Côte d'Ivoire", bbox: [4.3, -8.65, 10.75, -2.45], domains: ["ci"], priority: 54 },
  { cc: "SN", name: "Senegal", bbox: [12.3, -17.6, 16.7, -11.3], domains: ["sn"], priority: 52 },
  { cc: "EG", name: "Egypt", bbox: [22.0, 24.7, 31.7, 36.9], domains: ["com.eg"], priority: 50 },
  { cc: "MA", name: "Morocco", bbox: [27.6, -13.2, 35.95, -0.95], domains: ["ma"], priority: 48 },
  { cc: "ZW", name: "Zimbabwe", bbox: [-22.45, 25.2, -15.6, 33.1], domains: ["co.zw"], priority: 46 },
  { cc: "BW", name: "Botswana", bbox: [-26.95, 19.95, -17.75, 29.4], domains: ["co.bw"], priority: 44 },
  { cc: "NA", name: "Namibia", bbox: [-29.0, 11.7, -16.95, 25.3], domains: ["com.na"], priority: 42 },
  { cc: "MW", name: "Malawi", bbox: [-17.15, 32.65, -9.35, 35.95], domains: ["mw"], priority: 40 },
  { cc: "MZ", name: "Mozambique", bbox: [-26.9, 30.2, -10.45, 40.9], domains: ["co.mz"], priority: 38 },
  { cc: "BJ", name: "Benin", bbox: [6.2, 0.75, 12.45, 3.9], domains: ["bj"], priority: 36 },
  { cc: "TG", name: "Togo", bbox: [6.05, -0.2, 11.15, 1.85], domains: ["tg"], priority: 34 },
  { cc: "SL", name: "Sierra Leone", bbox: [6.85, -13.35, 10.0, -10.25], domains: ["sl"], priority: 32 },
  { cc: "LR", name: "Liberia", bbox: [4.3, -11.5, 8.6, -7.35], domains: ["com.lr"], priority: 30 },
  { cc: "GM", name: "Gambia", bbox: [13.0, -16.85, 13.85, -13.75], domains: ["gm"], priority: 28 },
];

export const COUNTRY_BY_CC = new Map(COLLECTION_COUNTRIES.map((c) => [c.cc, c]));

/** Split a bounding box into roughly `step`-degree tiles with stable keys. */
export function tiles(bbox: [number, number, number, number], step = 2): { key: string; bbox: [number, number, number, number] }[] {
  const [s, w, n, e] = bbox;
  const out: { key: string; bbox: [number, number, number, number] }[] = [];
  for (let y = s, iy = 0; y < n; y += step, iy++) {
    for (let x = w, ix = 0; x < e; x += step, ix++) {
      out.push({ key: `${iy}_${ix}`, bbox: [round(y), round(x), round(Math.min(n, y + step)), round(Math.min(e, x + step))] });
    }
  }
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
