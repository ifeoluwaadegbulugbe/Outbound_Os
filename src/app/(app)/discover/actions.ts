"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { enqueue, cancelJob } from "@/server/jobs/queue";
import { getAdapter } from "@/server/adapters/registry";
import { ingestProspect } from "@/server/services/ingest";
import { autoMap, parseCsv, previewImport, PRESETS, TARGET_FIELDS, type Mapping, type PreviewRow } from "@/server/services/importer";
import { mergeProspects } from "@/server/services/merge";
import { socialFromUrl, normalizeHandle, extractSignals } from "@/server/domain/normalize";
import { CATEGORY_KEYS } from "@/server/domain/taxonomy";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

export async function startDiscoveryAction(input: { adapter: string; categories: string[]; cities: string[]; limit: number; campaignId: string | null; hashtags?: string; seedHandles?: string; findEmails?: boolean }): Promise<ActionResult> {
  const user = await requireUser("member");
  const adapter = getAdapter(input.adapter);
  if (!adapter) return { ok: false, error: "Unknown source" };
  if (adapter.info.status === "disabled") return { ok: false, error: `${adapter.info.label} is disabled.` };
  // Categories and locations are editable data (Settings), validated against the DB.
  const known = await asUser(user, async (q) => ({
    cats: (await q.many<{ key: string }>(sql`select key from categories where is_active`)).map((r) => r.key),
    locs: (await q.many<{ key: string }>(sql`select key from locations where is_active`)).map((r) => r.key),
  }));
  const catSet = new Set<string>([...CATEGORY_KEYS, ...known.cats]);
  const locSet = new Set(known.locs);
  const categories = z.array(z.string()).parse(input.categories).filter((c) => catSet.has(c));
  const cities = z.array(z.string()).parse(input.cities).filter((c) => locSet.has(c));
  if (!categories.length && input.adapter !== "instagram_graph") return { ok: false, error: "Pick at least one category." };
  if (!cities.length) return { ok: false, error: "Pick at least one location." };
  const limit = Math.min(50_000, Math.max(1, Math.round(input.limit)));
  const hashtags = (input.hashtags ?? "").split(/[s,]+/).map((h) => h.replace(/^#/, "").trim().toLowerCase()).filter(Boolean).slice(0, 30);
  const seedHandles = (input.seedHandles ?? "").split(/[s,]+/).map((h) => normalizeHandle(h)).filter(Boolean) as string[];
  if (input.adapter === "instagram_graph") {
    const ig = await asUser(user, (q) => q.maybe<{ secret_ciphertext: string | null }>(sql`select secret_ciphertext from integrations where key = 'instagram_graph'`));
    if (!ig?.secret_ciphertext) return { ok: false, error: "Connect Instagram first (Data Sources → Instagram)." };
  }
  const findEmails = Boolean(input.findEmails);
  const runId = await asUser(user, async (q) => {
    const id = await q.value<string>(sql`
      insert into discovery_runs (workspace_id, campaign_id, adapter, params, created_by, target)
      values (${user.workspaceId}, ${input.campaignId}, ${input.adapter}, ${json({ categories, cities, limit, hashtags, seedHandles, findEmails })}, ${user.userId}, ${limit}) returning id`);
    const jobId = await enqueue(q, { workspaceId: user.workspaceId, type: "discovery.run", createdBy: user.userId, total: limit,
      payload: { runId: id, adapter: input.adapter, categories, cities, limit, campaignId: input.campaignId, hashtags, seedHandles, findEmails } });
    await q.exec(sql`update discovery_runs set job_id = ${jobId} where id = ${id}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "discovery.started", "discovery_run", id, { adapter: input.adapter, limit, locations: cities.length, categories: categories.length });
    return id;
  });
  revalidatePath("/discover");
  return { ok: true, message: "Discovery started. It runs in the background and can be paused.", data: { runId } };
}

/** Pause keeps the checkpoint; resume continues from the last completed unit. */
export async function controlDiscoveryAction(runId: string, op: "pause" | "resume" | "cancel"): Promise<ActionResult> {
  const user = await requireUser("member");
  const r = await asUser(user, async (q) => {
    const run = await q.maybe<{ id: string; status: string; job_id: string | null; adapter: string; params: Record<string, unknown>; campaign_id: string | null; target: number | null }>(sql`
      select id, status, job_id, adapter, params, campaign_id, target from discovery_runs where id = ${runId}`);
    if (!run) return { ok: false as const, error: "Run not found" };
    const actor = { workspaceId: user.workspaceId, actorType: "user" as const, actorId: user.userId };
    if (op === "resume") {
      if (!["paused", "failed", "cancelled"].includes(run.status)) return { ok: false as const, error: `Can't resume a ${run.status} run.` };
      const pl = run.params as { categories: string[]; cities: string[]; limit: number; hashtags?: string[]; seedHandles?: string[]; findEmails?: boolean };
      const jobId = await enqueue(q, { workspaceId: user.workspaceId, type: "discovery.run", createdBy: user.userId, total: pl.limit,
        payload: { runId: run.id, adapter: run.adapter, categories: pl.categories, cities: pl.cities, limit: pl.limit, campaignId: run.campaign_id, hashtags: pl.hashtags, seedHandles: pl.seedHandles, findEmails: pl.findEmails } });
      await q.exec(sql`update discovery_runs set status = 'queued', job_id = ${jobId}, error = null, finished_at = null where id = ${run.id}`);
      await audit(q, actor, "discovery.resumed", "discovery_run", run.id, {});
      return { ok: true as const, message: "Resuming from the last checkpoint" };
    }
    if (!["queued", "running"].includes(run.status)) return { ok: false as const, error: `Run is already ${run.status}.` };
    // Set the run status first so the worker's cancel handler leaves "paused" alone.
    await q.exec(sql`update discovery_runs set status = ${op === "pause" ? "paused" : "cancelled"}, finished_at = ${op === "cancel" ? new Date() : null} where id = ${run.id}`);
    if (run.job_id) await cancelJob(q, run.job_id);
    await audit(q, actor, op === "pause" ? "discovery.paused" : "discovery.cancelled", "discovery_run", run.id, {});
    return { ok: true as const, message: op === "pause" ? "Pausing after the current step. Progress is saved." : "Discovery cancelled" };
  });
  revalidatePath("/discover");
  return r;
}

/**
 * Quick capture: the user found a profile while browsing and pasted its URL
 * and/or bio (or used the bookmarklet). We parse what they gave us — no
 * fetching of Instagram/TikTok pages.
 */
export async function captureAction(input: { url: string; text: string; name?: string; category?: string; city?: string; campaignId?: string | null }): Promise<ActionResult> {
  const user = await requireUser("member");
  const url = input.url.trim().slice(0, 500);
  const text = input.text.trim().slice(0, 3000);
  if (!url && !text) return { ok: false, error: "Paste a profile link or their bio." };
  const social = url ? socialFromUrl(url) : null;
  const signals = extractSignals(text, "bio");
  const handle = social?.handle ?? signals.instagram[0]?.value ?? null;
  // Name: explicit > title-like first line of pasted text > handle.
  const firstLine = text.split(/\n/)[0]?.replace(/\(@[^)]+\)|•.*$|\|.*$/g, "").trim();
  const name = input.name?.trim() || (firstLine && firstLine.length <= 60 && !/followers|following|posts/i.test(firstLine) ? firstLine : null) || handle;
  if (!name) return { ok: false, error: "Couldn't find a name — add the business name." };
  const r = await asUser(user, (q) => ingestProspect(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, {
    business_name: name,
    bio: text || null,
    instagram_handle: social?.platform === "instagram" ? social.handle : signals.instagram[0]?.value ?? null,
    tiktok_handle: social?.platform === "tiktok" ? social.handle : signals.tiktok[0]?.value ?? null,
    facebook_url: social?.platform === "facebook" ? social.url : null,
    website: !social && url ? url : null,
    category: input.category && CATEGORY_KEYS.includes(input.category as never) ? input.category : null,
    city: input.city || null,
    source: "manual_capture",
    source_url: url || null,
  }, { campaignId: input.campaignId ?? null }));
  revalidatePath("/discover");
  if (!r.prospectId) return { ok: false, error: r.reason ?? "Not added" };
  const label = { created: "Added", merged: "Matched an existing prospect — updated it", flagged: "Added — flagged as a possible duplicate", suppressed: "", skipped: "" }[r.outcome];
  return { ok: true, message: label, data: { prospectId: r.prospectId, outcome: r.outcome } };
}

export async function previewImportAction(csv: string, preset: string, mapping?: Mapping): Promise<{ ok: true; headers: string[]; mapping: Mapping; preview: PreviewRow[]; total: number; errors: string[] } | { ok: false; error: string }> {
  const user = await requireUser("member");
  if (csv.length > 15_000_000) return { ok: false, error: "File is too large (max ~15 MB). Split it into parts." };
  const { headers, rows, errors } = parseCsv(csv);
  if (!headers.length || !rows.length) return { ok: false, error: "No rows found. Is the first row a header?" };
  const m = mapping && Object.keys(mapping).length ? mapping : autoMap(headers, preset);
  if (!m.business_name) return { ok: true, headers, mapping: m, preview: [], total: rows.length, errors: ["Map a column to Business name to continue.", ...errors] };
  const preview = await asUser(user, (q) => previewImport(q, rows, m, PRESETS[preset]?.source ?? "csv", 20));
  return { ok: true, headers, mapping: m, preview, total: rows.length, errors };
}

export async function startImportAction(csv: string, mapping: Mapping, preset: string, campaignId: string | null, filename: string | null): Promise<ActionResult> {
  const user = await requireUser("member");
  const clean = Object.fromEntries(Object.entries(mapping).filter(([k, v]) => TARGET_FIELDS.includes(k as never) && v)) as Mapping;
  if (!clean.business_name) return { ok: false, error: "Map a column to Business name." };
  const id = await asUser(user, async (q) => {
    const importId = await q.value<string>(sql`
      insert into import_batches (workspace_id, campaign_id, filename, preset, mapping, created_by) values (${user.workspaceId}, ${campaignId}, ${filename}, ${preset}, ${json(clean)}, ${user.userId}) returning id`);
    await enqueue(q, { workspaceId: user.workspaceId, type: "import.csv", createdBy: user.userId, label: "Queued",
      payload: { importId, csv, mapping: clean, source: PRESETS[preset]?.source ?? "csv", campaignId } });
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "import.started", "import_batch", importId, { filename });
    return importId;
  });
  revalidatePath("/discover");
  return { ok: true, message: "Import started — you'll be notified when it's done", data: { importId: id } };
}

export async function resolveDuplicateAction(id: string, decision: "merge" | "kept_separate" | "ignored", keepId?: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    const d = await q.one<{ prospect_a: string; prospect_b: string; status: string }>(sql`select prospect_a, prospect_b, status from possible_duplicates where id = ${z.string().uuid().parse(id)}`);
    if (d.status !== "pending") return;
    if (decision === "merge") {
      const keep = keepId === d.prospect_b ? d.prospect_b : d.prospect_a;
      const drop = keep === d.prospect_a ? d.prospect_b : d.prospect_a;
      await mergeProspects(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, keep, drop);
    } else {
      await q.exec(sql`update possible_duplicates set status = ${decision}, resolved_by = ${user.userId}, resolved_at = now() where id = ${id}`);
      await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, `duplicate.${decision}`, "possible_duplicate", id);
    }
  });
  revalidatePath("/discover");
  return { ok: true, message: decision === "merge" ? "Merged" : decision === "kept_separate" ? "Kept as separate businesses" : "Ignored" };
}

export async function scanDuplicatesAction(): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => enqueue(q, { workspaceId: user.workspaceId, type: "dedupe.scan", createdBy: user.userId, dedupeKey: "dedupe.scan" }));
  return { ok: true, message: "Duplicate scan started" };
}
