import type { SourceAdapter } from "./types";
import { osmAdapter } from "./osm";
import { instagramAdapter } from "./instagram";
import { mockAdapter } from "./mock";

/**
 * Automated discovery adapters. Manual capture, CSV import and Foursquare
 * open data enter through their own flows (Discover → Capture / Import) but
 * produce the same NormalizedProspect and go through the same ingestion.
 *
 * Deliberately absent (see docs/integration-feasibility.md): TikTok, LinkedIn
 * and Google Places — no permitted automated discovery route exists.
 */
export const ADAPTERS: Record<string, SourceAdapter> = {
  instagram_graph: instagramAdapter,
  osm_overpass: osmAdapter,
  mock_source: mockAdapter,
};

export function getAdapter(key: string): SourceAdapter | null {
  return ADAPTERS[key] ?? null;
}
