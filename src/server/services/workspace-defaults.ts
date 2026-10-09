import { sql, json, type Q } from "../db";
import { DEFAULT_ICP } from "../domain/scoring";
import { AFRICAN_CITIES, locationKey, defaultPolicy } from "../domain/locations";

export const DEFAULT_FOLLOWUP_STEPS = [
  { day: 3, angle: "bump", instructions: "Very short, friendly nudge. One line. No pressure." },
  { day: 7, angle: "value", instructions: "Share one specific, concrete way Orbit would help their kind of business." },
  { day: 14, angle: "final", instructions: "Polite last message. Make it easy to say no. Offer to stop." },
];

/** Integrations every workspace starts with, all honest about their status. */
export const DEFAULT_INTEGRATIONS: { key: string; status: string }[] = [
  { key: "instagram_graph", status: "needs_setup" },
  { key: "osm_overpass", status: "connected" },
  { key: "csv_import", status: "connected" },
  { key: "manual_capture", status: "connected" },
  { key: "mock_source", status: "connected" },
  { key: "brave_search", status: "disabled" },
  { key: "browser_extension", status: "needs_setup" },
  { key: "conversions_webhook", status: "needs_setup" },
  { key: "ai", status: "connected" },
  { key: "tiktok", status: "disabled" },
  { key: "whatsapp_cloud", status: "disabled" },
  { key: "gmail", status: "needs_setup" },
  { key: "microsoft_mail", status: "needs_setup" },
  { key: "website_email_finder", status: "connected" },
  { key: "email_verify_dns", status: "connected" },
  { key: "zerobounce", status: "needs_setup" },
  { key: "linkedin", status: "disabled" },
];

export async function seedWorkspaceDefaults(q: Q, workspaceId: string): Promise<void> {
  await q.exec(sql`
    insert into icp_profiles (workspace_id, name, description, config, is_default)
    values (${workspaceId}, 'Nigerian service businesses',
            'Appointment-based service businesses in major Nigerian cities that manage bookings and payments manually.',
            ${json(DEFAULT_ICP)}, true)`);
  await q.exec(sql`
    insert into followup_sequences (workspace_id, name, steps, is_default)
    values (${workspaceId}, 'Standard: day 3 / 7 / 14', ${json(DEFAULT_FOLLOWUP_STEPS)}, true)`);
  await ensureEmailDefaults(q, workspaceId);
  for (const i of DEFAULT_INTEGRATIONS) {
    await q.exec(sql`insert into integrations (workspace_id, key, status) values (${workspaceId}, ${i.key}, ${i.status})
                     on conflict (workspace_id, key) do nothing`);
  }
}

/**
 * Idempotent defaults added by the email-first upgrade: African locations,
 * country compliance policies, new integration rows. Safe to call repeatedly
 * (runs at boot for existing workspaces).
 */
export async function ensureEmailDefaults(q: Q, workspaceId: string): Promise<void> {
  for (const c of AFRICAN_CITIES) {
    await q.exec(sql`
      insert into locations (workspace_id, country_code, country_name, region, city, key, aliases, bbox_south, bbox_west, bbox_north, bbox_east, is_builtin)
      values (${workspaceId}, ${c.country_code}, ${c.country_name}, ${c.region}, ${c.city}, ${locationKey(c.country_code, c.city)},
              ${`{${(c.aliases ?? []).map((a) => `"${a}"`).join(",")}}`}::text[], ${c.bbox[0]}, ${c.bbox[1]}, ${c.bbox[2]}, ${c.bbox[3]}, true)
      on conflict (workspace_id, key) do nothing`);
  }
  for (const cc of [...new Set(AFRICAN_CITIES.map((c) => c.country_code))]) {
    const p = defaultPolicy(cc);
    await q.exec(sql`insert into country_policies (workspace_id, country_code, cold_email, legal_basis, notes)
      values (${workspaceId}, ${cc}, ${p.cold_email}, ${p.legal_basis}, ${p.notes}) on conflict do nothing`);
  }
  for (const i of DEFAULT_INTEGRATIONS) {
    await q.exec(sql`insert into integrations (workspace_id, key, status) values (${workspaceId}, ${i.key}, ${i.status}) on conflict (workspace_id, key) do nothing`);
  }
  // Email is the primary channel: make it the default for campaigns without a choice yet.
  await q.exec(sql`update campaigns set code = coalesce(code, left(replace(slug, '-', '_'), 40)) where code is null`);
}
