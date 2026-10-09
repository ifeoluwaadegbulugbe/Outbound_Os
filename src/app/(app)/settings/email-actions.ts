"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json, textArray } from "@/server/db";
import { audit } from "@/server/services/audit";
import { locationKey, COUNTRY_NAMES } from "@/server/domain/locations";
import { CATEGORY_KEYS } from "@/server/domain/taxonomy";
import type { ActionResult } from "@/components/ui/dialog";

const STATUSES = ["verified", "unknown", "catch_all", "risky"] as const;

const emailSettingsSchema = z.object({
  senderName: z.string().trim().min(1, "Your name is required").max(80),
  company: z.string().trim().min(1).max(120),
  address: z.string().trim().min(8, "A real postal address is required in every commercial email").max(300),
  defaultCountry: z.string().trim().length(2).toUpperCase(),
  allowedStatuses: z.array(z.enum(STATUSES)).min(1, "Allow at least one status"),
  autoVerifyBeforeSend: z.boolean(),
  requireReviewForNew: z.boolean(),
  maxBounceRate: z.number().min(0.005).max(0.2),
  maxComplaintRate: z.number().min(0.0005).max(0.05),
  minSample: z.number().int().min(5).max(500),
});

export async function saveEmailSettingsAction(input: z.input<typeof emailSettingsSchema>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = emailSettingsSchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const d = v.data;
  await asUser(user, async (q) => {
    const patch = {
      sender: { senderName: d.senderName, company: d.company, address: d.address },
      defaultCountry: d.defaultCountry,
      emailPolicy: { allowedStatuses: d.allowedStatuses, autoVerifyBeforeSend: d.autoVerifyBeforeSend, requireReviewForNew: d.requireReviewForNew },
      safety: { maxBounceRate: d.maxBounceRate, maxComplaintRate: d.maxComplaintRate, minSample: d.minSample },
    };
    await q.exec(sql`update workspaces set settings = settings || ${json(patch)} where id = ${user.workspaceId}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "settings.email_updated", "workspace", user.workspaceId, patch);
  });
  revalidatePath("/settings/email");
  return { ok: true, message: "Email settings saved" };
}

const policySchema = z.object({
  countryCode: z.string().trim().length(2).toUpperCase(),
  coldEmail: z.enum(["allowed", "consent_required", "blocked"]),
  legalBasis: z.string().trim().max(200).optional().default(""),
  notes: z.string().trim().max(1000).optional().default(""),
  acknowledged: z.boolean(),
});

/**
 * Country rules. Allowing cold email requires an explicit acknowledgement that
 * the rules were reviewed. The acknowledgement and who gave it are recorded.
 */
export async function saveCountryPolicyAction(input: z.input<typeof policySchema>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = policySchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const d = v.data;
  if (d.coldEmail === "allowed" && !d.acknowledged) return { ok: false, error: "Confirm you've reviewed this country's rules (and documented your legal basis) before allowing cold email." };
  if (d.coldEmail === "allowed" && !d.legalBasis) return { ok: false, error: "Record the legal basis you're relying on (e.g. legitimate interest, with an LIA)." };
  await asUser(user, async (q) => {
    await q.exec(sql`
      insert into country_policies (workspace_id, country_code, cold_email, legal_basis, notes, acknowledged_by, acknowledged_at, updated_at)
      values (${user.workspaceId}, ${d.countryCode}, ${d.coldEmail}, ${d.legalBasis || null}, ${d.notes || null}, ${d.acknowledged ? user.userId : null}, ${d.acknowledged ? new Date() : null}, now())
      on conflict (workspace_id, country_code) do update set cold_email = excluded.cold_email, legal_basis = excluded.legal_basis, notes = excluded.notes,
        acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at, updated_at = now()`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "compliance.country_policy", "country", d.countryCode, d);
  });
  revalidatePath("/settings/countries");
  return { ok: true, message: `${COUNTRY_NAMES[d.countryCode] ?? d.countryCode}: ${d.coldEmail.replace("_", " ")}` };
}

const categorySchema = z.object({
  label: z.string().trim().min(2).max(60),
  group: z.string().trim().max(40).optional().default("other"),
  keywords: z.string().max(1000).optional().default(""),
  osmTags: z.string().max(2000).optional().default(""),
});

/** Custom categories: usable in discovery, filters, scoring and drafts without code changes. */
export async function addCategoryAction(input: z.input<typeof categorySchema>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = categorySchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const key = v.data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) return { ok: false, error: "Label must start with a letter" };
  if ((CATEGORY_KEYS as readonly string[]).includes(key)) return { ok: false, error: "That's already a built-in category" };
  const keywords = v.data.keywords.split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 40);
  const tags = v.data.osmTags.split(/\n|(?<=\])\s*,\s*(?=\[)/).map((t) => t.trim()).filter(Boolean);
  // Overpass filters must look like ["key"="value"] (optionally chained), nothing else is sent to Overpass.
  const bad = tags.find((t) => !/^(\[\s*"[a-z0-9:_]+"\s*(=|~|!=)\s*"[^"\]]{1,80}"\s*\])+$/i.test(t));
  if (bad) return { ok: false, error: `Not a valid OpenStreetMap tag filter: ${bad}. Use the form ["shop"="laundry"].` };
  const r = await asUser(user, async (q) => {
    const exists = await q.value<boolean>(sql`select exists(select 1 from categories where key = ${key})`);
    if (exists) return { ok: false as const, error: "A category with that name already exists" };
    await q.exec(sql`insert into categories (workspace_id, key, label, group_name, keywords, osm_tags)
      values (${user.workspaceId}, ${key}, ${v.data.label}, ${v.data.group || "other"}, ${textArray(keywords)}, ${textArray(tags)})`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "taxonomy.category_added", "category", key, { keywords, tags });
    return { ok: true as const, message: `Added “${v.data.label}”${tags.length ? "" : ". It has no map tags yet, so discovery will skip it (CSV/import still work)"}` };
  });
  revalidatePath("/settings/taxonomy");
  return r;
}

export async function toggleCategoryAction(key: string, active: boolean): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, (q) => q.exec(sql`update categories set is_active = ${active} where key = ${z.string().max(41).parse(key)}`));
  revalidatePath("/settings/taxonomy");
  return { ok: true, message: active ? "Category enabled" : "Category disabled" };
}

const locationSchema = z.object({
  countryCode: z.string().trim().length(2).toUpperCase(),
  countryName: z.string().trim().max(60).optional().default(""),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional().default(""),
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
});

export async function addLocationAction(input: z.input<typeof locationSchema>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = locationSchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const d = v.data;
  if (d.south >= d.north || d.west >= d.east) return { ok: false, error: "The bounding box is inverted: south must be below north, and west left of east." };
  // Keep each search area to roughly a metro region so Overpass queries stay small.
  if (d.north - d.south > 1.5 || d.east - d.west > 1.5) return { ok: false, error: "That area is too large. Keep it under about 1.5° each way (one city or metro area)." };
  const key = locationKey(d.countryCode, d.city);
  const r = await asUser(user, async (q) => {
    const exists = await q.value<boolean>(sql`select exists(select 1 from locations where key = ${key})`);
    if (exists) return { ok: false as const, error: "That location already exists" };
    await q.exec(sql`insert into locations (workspace_id, country_code, country_name, region, city, key, bbox_south, bbox_west, bbox_north, bbox_east)
      values (${user.workspaceId}, ${d.countryCode}, ${d.countryName || COUNTRY_NAMES[d.countryCode] || d.countryCode}, ${d.region || null}, ${d.city}, ${key}, ${d.south}, ${d.west}, ${d.north}, ${d.east})`);
    // New countries start as "not assessed": cold email stays off until reviewed.
    await q.exec(sql`insert into country_policies (workspace_id, country_code, cold_email, legal_basis, notes)
      values (${user.workspaceId}, ${d.countryCode}, 'consent_required', null, 'Not assessed yet. Review local rules before allowing cold email.') on conflict do nothing`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "taxonomy.location_added", "location", key, d);
    return { ok: true as const, message: `Added ${d.city}` };
  });
  revalidatePath("/settings/taxonomy");
  return r;
}

export async function toggleLocationAction(key: string, active: boolean): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, (q) => q.exec(sql`update locations set is_active = ${active} where key = ${z.string().max(100).parse(key)}`));
  revalidatePath("/settings/taxonomy");
  return { ok: true, message: active ? "Location enabled" : "Location disabled" };
}
