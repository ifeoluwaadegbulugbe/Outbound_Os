/**
 * Source adapter contract. Every discovery source (Instagram Graph API,
 * OpenStreetMap, CSV, manual capture, mock…) returns NormalizedProspect
 * objects; nothing downstream knows which source produced a record.
 */

export interface NormalizedProspect {
  business_name: string;
  owner_name?: string | null;
  category?: string | null;
  subcategory?: string | null;
  services?: string[];
  description?: string | null;
  bio?: string | null;
  business_size?: "solo" | "small" | "medium" | "large" | null;

  country?: string | null;
  state?: string | null;
  city?: string | null;
  area?: string | null;
  lat?: number | null;
  lng?: number | null;

  instagram_handle?: string | null;
  tiktok_handle?: string | null;
  facebook_url?: string | null;
  linkedin_url?: string | null;
  youtube_url?: string | null;
  email?: string | null;
  /** Further publicly listed emails for the same business (stored as contacts with provenance). */
  extra_emails?: string[];
  /** Public business address (freeform). */
  address?: string | null;
  /** True when business_name was derived from a domain and should be replaced by the site's own name when crawled. */
  name_from_domain?: boolean;
  phone?: string | null;
  whatsapp?: string | null;
  website?: string | null;
  booking_url?: string | null;

  follower_count?: number | null;
  following_count?: number | null;
  media_count?: number | null;
  last_post_date?: Date | string | null;
  posting_frequency?: number | null;

  /** Extra text that may hold signals (captions, snippet) — analysed, not stored verbatim. */
  extra_text?: string | null;

  source: string;              // adapter key
  source_url?: string | null;
  external_id?: string | null; // stable id within the source
  raw?: Record<string, unknown> | null;
  is_demo?: boolean;
}

export type AdapterMode = "automated" | "assisted" | "manual";

export interface AdapterInfo {
  key: string;
  label: string;
  description: string;
  mode: AdapterMode;
  /** Shown in the UI so users know what's real. */
  status: "available" | "needs_setup" | "needs_approval" | "dev_only" | "disabled";
  attribution?: string;
}

export interface DiscoveryParams {
  categories: string[];
  cities: string[];          // location keys
  /** Resolved locations (from the editable locations table). */
  locations?: { key: string; city: string; country_code: string; bbox: [number, number, number, number] }[];
  /** Overpass tag filters for custom categories (categories table). */
  customTags?: Record<string, string[]>;
  limit: number;
  hashtags?: string[];
  seedHandles?: string[];
  query?: string;
}

export interface DiscoveryContext {
  workspaceId: string;
  /** Short workspace-scoped transaction (don't call progress/log inside it). */
  ws<T>(fn: (q: import("../db").Q) => Promise<T>): Promise<T>;
  /** Report progress; return false if the job was cancelled. */
  progress(current: number, total: number | null, label?: string): Promise<boolean>;
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void>;
  /** Resumable discovery: skip work units already completed in a previous attempt. */
  isDone?(unit: string): boolean;
  markDone?(unit: string): Promise<void>;
}

export interface SourceAdapter {
  info: AdapterInfo;
  /** Stream normalized prospects. Must respect rate limits internally. */
  discover(params: DiscoveryParams, ctx: DiscoveryContext): AsyncIterable<NormalizedProspect>;
}
