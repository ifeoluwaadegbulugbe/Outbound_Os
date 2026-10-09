import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "@/server/db/driver";
import { withWorkspace, sql } from "@/server/db";
import { ingestProspect } from "@/server/services/ingest";
import { seedWorkspaceDefaults } from "@/server/services/workspace-defaults";
import { testDb, createWorkspace } from "../helpers";

let d: Driver;
let ws: string;
const ctx = () => ({ workspaceId: ws, actorType: "system" as const });
const run = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) => withWorkspace({ workspaceId: ws }, fn, d);

beforeAll(async () => {
  d = await testDb();
  ws = await createWorkspace(d);
  await run((q) => seedWorkspaceDefaults(q, ws));
});
afterAll(async () => d?.close());

describe("prospect ingestion", () => {
  it("creates, enriches from bio, and scores with reasons", async () => {
    const r = await run((q) =>
      ingestProspect(q, ctx(), {
        business_name: "Nails by Teni",
        instagram_handle: "@NailsByTeni",
        bio: "Nail tech in Lekki 💅 Acrylics, gel & pedicure. DM to book or WhatsApp 0803 123 4567",
        follower_count: 3100,
        last_post_date: new Date(),
        source: "test",
        external_id: "ig:1",
      }),
    );
    expect(r.outcome).toBe("created");
    const p = await run((q) => q.one<Record<string, unknown>>(sql`select * from prospects where id = ${r.prospectId}`));
    expect(p.instagram_handle).toBe("nailsbyteni");
    expect(p.category).toBe("nail_technician");
    expect(p.city).toBe("Lagos");
    expect(p.phone).toBe("+2348031234567");
    expect(p.whatsapp).toBe("+2348031234567");
    expect(p.status).toBe("QUALIFIED");
    expect(p.icp_score as number).toBeGreaterThanOrEqual(80);
    expect((p.signals as Record<string, { quote?: string }>).dmBookings.quote).toContain("DM to book");
    expect(((p.score_reasons as { reasons: unknown[] }).reasons).length).toBeGreaterThan(5);
  });

  it("merges the same Instagram account found from another source", async () => {
    const r = await run((q) =>
      ingestProspect(q, ctx(), { business_name: "Teni Nails Studio", instagram_handle: "nailsbyteni", tiktok_handle: "teninails", source: "manual" }),
    );
    expect(r.outcome).toBe("merged");
    const p = await run((q) => q.one<{ tiktok_handle: string; business_name: string; n: number }>(
      sql`select tiktok_handle, business_name, (select count(*)::int from prospect_sources s where s.prospect_id = p.id) as n from prospects p where id = ${r.prospectId}`));
    expect(p.tiktok_handle).toBe("teninails");      // filled in
    expect(p.business_name).toBe("Nails by Teni");  // not overwritten
    expect(p.n).toBe(2);
  });

  it("re-discovering by external id refreshes instead of duplicating", async () => {
    const r = await run((q) => ingestProspect(q, ctx(), { business_name: "Nails by Teni", follower_count: 3300, source: "test", external_id: "ig:1" }));
    expect(r.outcome).toBe("merged");
    const n = await run((q) => q.value<number>(sql`select count(*)::int from prospects`));
    expect(n).toBe(1);
  });

  it("flags fuzzy duplicates instead of silently merging", async () => {
    await run((q) => ingestProspect(q, ctx(), { business_name: "Joy Beauty Studio", city: "Lagos", source: "test" }));
    const r = await run((q) => ingestProspect(q, ctx(), { business_name: "Joy Beauty Lagos", city: "Lagos", source: "test" }));
    expect(r.outcome).toBe("flagged");
    expect(r.duplicateOf?.[0].confidence).toBeGreaterThanOrEqual(50);
    const pd = await run((q) => q.value<number>(sql`select count(*)::int from possible_duplicates where status = 'pending'`));
    expect(pd).toBe(1);
  });

  it("never re-adds a prospect on the do-not-contact list", async () => {
    await run((q) => q.exec(sql`insert into dnc_entries (workspace_id, kind, value, reason) values (${ws}, 'instagram', 'optedout.mua', 'opt_out')`));
    const r = await run((q) => ingestProspect(q, ctx(), { business_name: "Opted Out MUA", instagram_handle: "OptedOut.MUA", source: "test" }));
    expect(r.outcome).toBe("suppressed");
    expect(r.reason).toMatch(/do-not-contact/);
  });
});
