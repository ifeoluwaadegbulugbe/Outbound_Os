/**
 * End-to-end workflow through the real services and a real (embedded)
 * Postgres — the acceptance path from the spec:
 * campaign → discover → qualify → research → generate → edit → approve →
 * mark contacted → follow-up scheduled → reply classified → signup → analytics.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Driver } from "@/server/db/driver";
import { withWorkspace, withSystem, sql, json, textArray, type Q } from "@/server/db";
import { setupFirstOwner } from "@/server/auth/service";
import { ingestMany } from "@/server/services/ingest";
import { generateDraft, editMessage, approveMessages, markSent, senderUsage } from "@/server/services/outreach";
import { researchProspect } from "@/server/services/research";
import { logInbound } from "@/server/services/inbox";
import { recordConversion } from "@/server/services/conversions";
import { createTrackedLink } from "@/server/services/links";
import { funnel } from "@/server/services/metrics";
import { breakdown } from "@/server/services/breakdowns";
import { scopeWhere } from "@/server/services/metrics";
import { mockAdapter } from "@/server/adapters/mock";
import { testDb } from "../helpers";

// AI providers off → deterministic templates/rules (no network in tests).
vi.stubEnv("AI_DISABLED", "true");

let d: Driver;
let ws: string;
let owner: string;
const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId: ws, userId: owner }, fn, d);
const actor = () => ({ workspaceId: ws, actorType: "user" as const, actorId: owner });

beforeAll(async () => {
  d = await testDb();
  const r = await setupFirstOwner({ workspaceName: "Orbit Growth", productName: "Orbit", name: "Ada Founder", email: "ada@test.local", password: "test-password-1" }, d);
  ws = r.workspaceId;
  owner = r.userId;
});
afterAll(async () => d?.close());

describe("acceptance workflow", () => {
  let campaignId: string;
  let prospectId: string;
  let messageId: string;

  it("creates the 'Lagos Beauty Businesses' campaign", async () => {
    campaignId = await run(async (q) => {
      const id = await q.value<string>(sql`
        insert into campaigns (workspace_id, name, slug, status, categories, cities, channels, constraints)
        values (${ws}, 'Lagos Beauty Businesses', 'lagos-beauty', 'active', ${textArray(["nail_technician", "hair_stylist"])}, ${textArray(["Lagos"])},
                ${textArray(["instagram", "whatsapp"])}, ${json({ maxChars: 300, noEmojis: true })}) returning id`);
      await q.exec(sql`insert into message_variants (workspace_id, campaign_id, key, name, angle) values (${ws}, ${id}, 'A', 'Problem', 'problem_first')`);
      return id;
    });
    expect(campaignId).toBeTruthy();
  });

  it("discovers prospects through an adapter and scores them", async () => {
    const items: import("@/server/adapters/types").NormalizedProspect[] = [];
    for await (const p of mockAdapter.discover({ categories: ["nail_technician"], cities: ["lagos"], limit: 5 }, { workspaceId: ws, ws: run, progress: async () => true, log: async () => {} })) items.push(p);
    // Plus one real-looking (non-demo) prospect we'll take through the whole flow.
    items.push({
      business_name: "Nails by Teni", instagram_handle: "nailsbyteni_test", source: "manual_capture", follower_count: 3400, last_post_date: new Date(),
      bio: "Nail tech in Lekki, Lagos 💅 Acrylics & gel. DM to book · WhatsApp 0803 123 4567 · deposit required",
    });
    const r = await run((q) => ingestMany(q, { workspaceId: ws, actorType: "system" }, items, { campaignId }));
    expect(r.counts.created).toBe(6);
    prospectId = r.results.at(-1)!.prospectId!;
    const p = await run((q) => q.one<{ status: string; icp_score: number }>(sql`select status, icp_score from prospects where id = ${prospectId}`));
    expect(p.status).toBe("QUALIFIED");
    expect(p.icp_score).toBeGreaterThanOrEqual(80);
  });

  it("filters ICP > 80, Lagos, beauty, active", async () => {
    const { compileFilter } = await import("@/server/domain/filters-sql");
    const n = await run((q) => q.value<number>(sql`select count(*)::int from prospects p where ${compileFilter({ op: "and", children: [
      { field: "icp_score", cmp: "gt", value: 80 }, { field: "city", cmp: "eq", value: "Lagos" },
      { field: "category", cmp: "in", value: ["nail_technician", "hair_stylist", "lash_technician", "makeup_artist"] }, { field: "active", cmp: "is_true" },
    ] })}`));
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("produces a research brief grounded in facts", async () => {
    await researchProspect(run, ws, prospectId);
    const r = await run((q) => q.one<{ summary: string; statements: { statements: { kind: string; basis: string[] }[]; facts: { id: string }[] } }>(sql`select summary, statements from prospect_research where prospect_id = ${prospectId}`));
    expect(r.summary).toContain("Nails by Teni");
    const ids = new Set(r.statements.facts.map((f) => f.id));
    for (const s of r.statements.statements) for (const b of s.basis) expect(ids.has(b)).toBe(true);
    expect(r.statements.statements.some((s) => s.kind === "inference")).toBe(true);
  });

  it("generates a validated personalised message, then edit + approve", async () => {
    const g = await generateDraft(run, { ...actor(), senderName: "Ada" }, { prospectId, campaignId, channel: "auto" });
    expect(g.status).toBe("needs_review");
    messageId = g.messageId!;
    const m = await run((q) => q.one<{ body: string; channel: string }>(sql`select body, channel from outreach_messages where id = ${messageId}`));
    expect(m.channel).toBe("instagram");
    expect(m.body.length).toBeLessThanOrEqual(300);
    expect(m.body).toMatch(/Teni|Nails by Teni/);

    // A bad edit is blocked with a reason…
    const bad = await run((q) => editMessage(q, actor(), messageId, "Dear Teni, 500+ businesses use Orbit!!!", null));
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.code)).toContain("unverified_social_proof");
    // …a good one passes.
    const good = await run((q) => editMessage(q, actor(), messageId, "Hi Teni, saw clients book you through DMs. I'm building Orbit so bookings don't get lost in your inbox. Open to trying it?", null));
    expect(good.ok).toBe(true);
    const a = await run((q) => approveMessages(q, actor(), [messageId]));
    expect(a.approved).toBe(1);
  });

  it("refuses to approve while outreach is paused", async () => {
    await run((q) => q.exec(sql`update workspaces set outreach_paused = true where id = ${ws}`));
    const g = await generateDraft(run, { ...actor(), senderName: "Ada" }, { prospectId: (await run((q) => q.value<string>(sql`select id from prospects where id <> ${prospectId} and is_demo limit 1`))), campaignId, channel: "instagram" });
    expect(g.status).toBe("blocked");
    await run((q) => q.exec(sql`update workspaces set outreach_paused = false where id = ${ws}`));
  });

  it("marks contacted, enforces the sender cap and schedules follow-ups", async () => {
    await run((q) => q.exec(sql`insert into sender_accounts (workspace_id, channel, label, daily_cap, warmup_enabled) values (${ws}, 'instagram', '@orbit.test', 1, false)`));
    const r = await run((q) => markSent(q, actor(), messageId));
    expect(r.ok).toBe(true);
    const p = await run((q) => q.one<{ status: string; contact_count: number; next_follow_up_at: Date | null }>(sql`select status, contact_count, next_follow_up_at from prospects where id = ${prospectId}`));
    expect(p.status).toBe("CONTACTED");
    expect(p.contact_count).toBe(1);
    expect(p.next_follow_up_at).not.toBeNull();
    const f = await run((q) => q.value<number>(sql`select count(*)::int from followups where prospect_id = ${prospectId} and status = 'pending'`));
    expect(f).toBe(3);
    const usage = await run((q) => senderUsage(q));
    expect(usage[0].sentToday).toBe(1);

    // Second message on the same account today → cap reached.
    const other = await run((q) => q.value<string>(sql`select id from prospects where id <> ${prospectId} and instagram_handle is not null limit 1`));
    const g2 = await generateDraft(run, { ...actor(), senderName: "Ada" }, { prospectId: other, campaignId, channel: "instagram" });
    await run((q) => approveMessages(q, actor(), [g2.messageId!]));
    const capped = await run((q) => markSent(q, actor(), g2.messageId!));
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error).toMatch(/cap/);
  });

  it("can't send a second first-message to an already contacted prospect", async () => {
    const g = await generateDraft(run, { ...actor(), senderName: "Ada" }, { prospectId, campaignId, channel: "whatsapp" });
    expect(g.status).toBe("skipped");
    expect(g.reason).toMatch(/already contacted/);
  });

  it("classifies a pricing reply, stops follow-ups, marks interested", async () => {
    const r = await logInbound(run, actor(), { prospectId, channel: "instagram", body: "This looks interesting, how much is it?" });
    expect(r.classification.intent).toBe("pricing");
    const p = await run((q) => q.one<{ status: string; replied_at: Date | null; interested_at: Date | null }>(sql`select status, replied_at, interested_at from prospects where id = ${prospectId}`));
    expect(p.status).toBe("INTERESTED");
    expect(p.replied_at).not.toBeNull();
    const pending = await run((q) => q.value<number>(sql`select count(*)::int from followups where prospect_id = ${prospectId} and status = 'pending'`));
    expect(pending).toBe(0);
  });

  it("attributes a signup from Orbit via the tracked-link ref code", async () => {
    const link = await run((q) => createTrackedLink(q, { workspaceId: ws, prospectId, campaignId, variantId: null, channel: "instagram", destination: "https://app.getorbitcrm.com/signup" }));
    const r = await run((q) => recordConversion(q, { workspaceId: ws, actorType: "webhook" }, { type: "signup", external_user_id: "orbit-1", ref_code: link.code, email: "teni@example.com" }));
    expect(r.matched).toBe(true);
    expect(r.method).toBe("ref_code");
    // Idempotent replay
    const again = await run((q) => recordConversion(q, { workspaceId: ws, actorType: "webhook" }, { type: "signup", external_user_id: "orbit-1", ref_code: link.code }));
    expect(again.duplicate).toBe(true);
    await run((q) => recordConversion(q, { workspaceId: ws, actorType: "webhook" }, { type: "paid", external_user_id: "orbit-1", ref_code: link.code, plan: "Pro" }));
    const p = await run((q) => q.one<{ status: string; signed_up: boolean; activated: boolean; paid: boolean; attribution: { campaign_id: string; channel: string } }>(sql`
      select status, signed_up, activated, paid, attribution from prospects where id = ${prospectId}`));
    expect(p).toMatchObject({ status: "PAID", signed_up: true, activated: true, paid: true });
    expect(p.attribution.campaign_id).toBe(campaignId);
    expect(p.attribution.channel).toBe("instagram");
  });

  it("keeps unmatched conversions for manual matching", async () => {
    const r = await run((q) => recordConversion(q, { workspaceId: ws, actorType: "webhook" }, { type: "signup", external_user_id: "orbit-unknown", email: "nobody@example.com" }));
    expect(r.matched).toBe(false);
  });

  it("opt-out reply suppresses forever, even after re-import", async () => {
    const other = await run((q) => q.one<{ id: string; instagram_handle: string }>(sql`select id, instagram_handle from prospects where id <> ${prospectId} and instagram_handle is not null and not do_not_contact limit 1`));
    const r = await logInbound(run, actor(), { prospectId: other.id, channel: "instagram", body: "Please don't contact me again." });
    expect(r.classification.intent).toBe("opt_out");
    const p = await run((q) => q.one<{ status: string; do_not_contact: boolean }>(sql`select status, do_not_contact from prospects where id = ${other.id}`));
    expect(p).toMatchObject({ status: "DO_NOT_CONTACT", do_not_contact: true });
    const re = await run((q) => ingestMany(q, { workspaceId: ws, actorType: "system" }, [{ business_name: "Same Biz", instagram_handle: other.instagram_handle, source: "csv" }]));
    expect(re.counts.suppressed).toBe(1);
  });

  it("analytics reflect the journey", async () => {
    const f = await run((q) => funnel(q, { campaignId }));
    // 2 replies: the pricing reply and the opt-out from another prospect in this campaign.
    expect(f).toMatchObject({ contacted: 1, replied: 2, interested: 1, signed_up: 1, activated: 1, paid: 1 });
    const rows = await run((q) => breakdown(q, "channel", scopeWhere({ campaignId }), { contactedOnly: true }));
    expect(rows.find((r) => r.key === "instagram")?.signed_up).toBe(1);
  });

  it("writes an audit trail", async () => {
    const actions = await withSystem((q) => q.many<{ action: string }>(sql`select action from audit_logs where workspace_id = ${ws}`), d);
    const set = new Set(actions.map((a) => a.action));
    for (const a of ["workspace.created", "messages.approved", "message.marked_sent", "reply.logged", "conversion.signup", "dnc.added"]) expect(set.has(a), a).toBe(true);
  });
});
