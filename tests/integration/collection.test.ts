/**
 * Collection engine on a real embedded Postgres, with in-memory sources and a
 * mocked web: queue claiming, rate limits, retries/dead-letter, resumption,
 * dedup across sources, crawl outcomes, email checks, suppression, metrics.
 * Fixture records here are never counted anywhere but this throwaway DB.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Driver } from "@/server/db/driver";
import { withWorkspace, sql, type Q } from "@/server/db";
import { setupFirstOwner } from "@/server/auth/service";
import { planCollection, claimUnit, runCollectTick, runCrawlTick, runEmailCheckTick, saveCollectionSettings } from "@/server/collection/engine";
import { collectionMetrics } from "@/server/collection/metrics";
import type { CollectionSource, UnitSpec } from "@/server/collection/sources";
import type { NormalizedProspect } from "@/server/adapters/types";
import type { Fetcher } from "@/server/email/finder";
import type { Resolver } from "@/server/email/verify";
import { suppressProspects } from "@/server/services/dnc";
import { testDb } from "../helpers";

vi.stubEnv("AI_DISABLED", "true");

let d: Driver;
let ws: string;
let owner: string;
const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId: ws, userId: owner }, fn, d);

// ── In-memory sources ─────────────────────────────────────────────────────
const biz = (n: number, extra: Partial<NormalizedProspect> = {}): NormalizedProspect => ({
  business_name: `Fixture Salon ${n} ${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"][n % 6]} ${n * 7919}`,
  category: "beauty_salon", country: "NG", city: "Lagos", phone: `+23480${String(10000000 + n)}`, source: "fake_a", external_id: `a${n}`, ...extra,
});
let failuresLeft = 0;
const fakeA: CollectionSource = {
  key: "fake_a", label: "Fake A", description: "", license: "", minIntervalMs: 0, maxAttempts: 2,
  plan: (c) => [0, 1].map((i) => ({ source: "fake_a", unit_key: `a:${c.cc}:${i}`, country_code: c.cc, params: { i }, priority: 50 })),
  async run(unit) {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error("source temporarily unavailable");
    }
    const i = Number(unit.params.i);
    return { items: [0, 1, 2].map((k) => biz(i * 3 + k, { email: k === 0 ? `owner${i}@fixture-salon-${i}.test` : null, website: k === 1 ? `https://fixture-salon-${i}.test/` : null })) };
  },
};
// Same businesses again from another source (same phone) → merged, not double counted.
const fakeB: CollectionSource = {
  key: "fake_b", label: "Fake B", description: "", license: "", minIntervalMs: 60_000, maxAttempts: 3,
  plan: (c) => [{ source: "fake_b", unit_key: `b:${c.cc}`, country_code: c.cc, params: {}, priority: 40 }, { source: "fake_b", unit_key: `b2:${c.cc}`, country_code: c.cc, params: {}, priority: 39 }],
  async run() {
    return { items: [biz(0, { source: "fake_b", external_id: "b0", extra_emails: ["second@fixture-salon-0.test"] }), biz(1, { source: "fake_b", external_id: "b1" })], spawn: [] as UnitSpec[] };
  },
};
const registry = { fake_a: fakeA, fake_b: fakeB };

beforeAll(async () => {
  d = await testDb();
  (globalThis as unknown as { __obDriver?: Promise<Driver> }).__obDriver = Promise.resolve(d);
  const r = await setupFirstOwner({ workspaceName: "Collect", productName: "Orbit", name: "Ada", email: "ada@collect.test", password: "test-password-1" }, d);
  ws = r.workspaceId;
  owner = r.userId;
  await run((q) => saveCollectionSettings(q, ws, { active: true, sources: ["fake_a", "fake_b"], autoExpand: false }));
});
afterAll(async () => {
  (globalThis as unknown as { __obDriver?: Promise<Driver> }).__obDriver = undefined;
  await d?.close();
});

describe("discovery queue", () => {
  it("plans idempotently: re-planning never duplicates work", async () => {
    expect(await run((q) => planCollection(q, ws, ["NG"], ["fake_a", "fake_b"], registry))).toBe(4);
    expect(await run((q) => planCollection(q, ws, ["NG"], ["fake_a", "fake_b"], registry))).toBe(0);
  });

  it("claims each unit once and respects per-source minimum intervals", async () => {
    const a = await run((q) => claimUnit(q, ws, ["fake_b"], registry));
    expect(a?.unit_key).toBe("b:NG");
    // fake_b just started a unit and has a 60s interval → nothing else from it now.
    expect(await run((q) => claimUnit(q, ws, ["fake_b"], registry))).toBeNull();
    // A crashed worker's unit goes back to the queue after 30 minutes.
    const later = new Date(Date.now() + 31 * 60_000);
    const again = await run((q) => claimUnit(q, ws, ["fake_b"], registry, later));
    expect(again?.unit_key).toBe("b:NG");
    await run((q) => q.exec(sql`update collection_units set status = 'pending', attempts = 0, started_at = null, locked_at = null where source = 'fake_b'`));
  });

  it("retries failures with backoff, then dead-letters after maxAttempts", async () => {
    failuresLeft = 1;
    const r1 = await runCollectTick(ws, { registry, maxUnits: 1 });
    expect(r1.failed).toBe(1);
    const u = await run((q) => q.one<{ status: string; next_attempt_at: Date; last_error: string }>(sql`select status, next_attempt_at, last_error from collection_units where status = 'failed'`));
    expect(u.last_error).toContain("temporarily unavailable");
    expect(new Date(u.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Make it due, fail again → dead (maxAttempts 2).
    await run((q) => q.exec(sql`update collection_units set next_attempt_at = now() where status = 'failed'`));
    failuresLeft = 1;
    await runCollectTick(ws, { registry, maxUnits: 1 });
    expect(await run((q) => q.value<number>(sql`select count(*)::int from collection_units where status = 'dead'`))).toBe(1);
    await run((q) => q.exec(sql`update collection_units set status = 'pending', attempts = 0, next_attempt_at = now() where status = 'dead'`));
  });

  it("saves businesses, merges cross-source duplicates and counts them once", async () => {
    await runCollectTick(ws, { registry });
    // fake_b's second unit is rate-limited until its interval passes.
    await run((q) => q.exec(sql`update collection_units set started_at = now() - interval '2 minutes' where source = 'fake_b'`));
    await runCollectTick(ws, { registry });
    const m = await run((q) => collectionMetrics(q));
    expect(m.businesses).toBe(6); // 2 units × 3 businesses; fake_b's records matched by phone
    expect(m.duplicatesRemoved).toBe(2); // fake_b unit 1 matched 2 businesses by phone; its unit 2 re-sent the same records (a refresh, not new duplicates)
    expect(m.withEmail).toBe(2);
    expect(m.emailAddresses).toBe(3); // the extra address is a second email for business 0, not a new business
    expect(m.units.done).toBe(4);
    const sources = await run((q) => q.value<number>(sql`select count(distinct ps.source)::int from prospect_sources ps join prospects p on p.id = ps.prospect_id where p.phone = ${"+2348010000000"}`));
    expect(sources).toBe(2); // provenance from both sources kept
  });

  it("a network outage doesn't use up a unit's attempts", async () => {
    const down: CollectionSource = { ...fakeA, key: "down", plan: () => [], run: async () => { throw new Error("IO Error: Could not resolve hostname error for HTTP GET"); } };
    await run((q) => q.exec(sql`insert into collection_units (workspace_id, source, unit_key, params) values (${ws}, 'down', 'down:1', '{}')`));
    await run((q) => saveCollectionSettings(q, ws, { sources: ["down"] }));
    await runCollectTick(ws, { registry: { down }, isOnline: async () => false });
    const u = await run((q) => q.one<{ status: string; attempts: number }>(sql`select status, attempts from collection_units where unit_key = 'down:1'`));
    expect(u).toEqual({ status: "pending", attempts: 0 });
    await run((q) => q.exec(sql`delete from collection_units where unit_key = 'down:1'`));
    await run((q) => saveCollectionSettings(q, ws, { sources: ["fake_a", "fake_b"] }));
  });

  it("pausing stops the engine; nothing is lost", async () => {
    await run((q) => planCollection(q, ws, ["GH"], ["fake_a"], registry));
    await run((q) => saveCollectionSettings(q, ws, { paused: true }));
    const r = await runCollectTick(ws, { registry });
    expect(r.units).toBe(0);
    expect(await run((q) => q.value<number>(sql`select count(*)::int from collection_units where status = 'pending'`))).toBe(2);
    await run((q) => saveCollectionSettings(q, ws, { paused: false }));
  });

  it("never ingests suppressed businesses", async () => {
    const id = await run((q) => q.value<string>(sql`select id from prospects where phone = ${"+2348010000004"}`));
    await run((q) => suppressProspects(q, { workspaceId: ws, actorType: "user", actorId: owner }, [id], "opt_out", "asked to stop"));
    const before = await run((q) => collectionMetrics(q));
    expect(before.email.suppressed).toBe(1);
    const once: CollectionSource = { ...fakeA, key: "once", plan: () => [], run: async () => ({ items: [biz(4, { source: "once", external_id: "o4", business_name: "Totally Different Name Ltd" })] }) };
    await run((q) => q.exec(sql`insert into collection_units (workspace_id, source, unit_key, params) values (${ws}, 'once', 'once:1', '{}')`));
    await run((q) => saveCollectionSettings(q, ws, { sources: ["once"] }));
    await runCollectTick(ws, { registry: { once } });
    const u = await run((q) => q.one<{ created: number; skipped: number }>(sql`select created, skipped from collection_units where unit_key = 'once:1'`));
    expect(u).toEqual({ created: 0, skipped: 1 });
    await run((q) => saveCollectionSettings(q, ws, { sources: ["fake_a", "fake_b"] }));
  });
});

describe("website crawl and email checks", () => {
  const pages: Record<string, string> = {
    "https://fixture-salon-0.test/": `<title>Home | Glow Fixture Studio</title><a href="/contact">Contact</a>`,
    "https://fixture-salon-0.test/contact": `Write to <a href="mailto:hello@fixture-salon-0.test">hello@fixture-salon-0.test</a>`,
    "https://fixture-salon-1.test/": `<p>Call us</p>`,
  };
  const fetcher: Fetcher = async (url) => {
    if (url.includes("fixture-salon-9")) throw new Error("ECONNREFUSED");
    const body = pages[url];
    return body == null ? new Response("", { status: 404, headers: { "content-type": "text/html" } })
      : Object.defineProperty(new Response(body, { status: 200, headers: { "content-type": "text/html" } }), "url", { value: url });
  };
  const resolver: Resolver = { mx: async () => [{ exchange: "mx.fixture.test", priority: 1 }], a: async () => ["192.0.2.1"] };

  it("crawls queued websites: email found / none / error / social link skipped, and replaces domain-derived names", async () => {
    await run(async (q) => {
      await q.exec(sql`update prospects set website = 'https://fixture-salon-0.test/', email = null, email_status = 'none', name_from_domain = true where phone = ${"+2348010000001"}`);
      await q.exec(sql`update prospects set website = 'https://fixture-salon-1.test/' where phone = ${"+2348010000002"}`);
      await q.exec(sql`insert into prospects (workspace_id, business_name, normalized_name, source, website, country) values
        (${ws}, 'Down Site', 'down site', 'fake_a', 'https://fixture-salon-9.test/', 'NG'),
        (${ws}, 'Social Only', 'social only', 'fake_a', 'https://www.facebook.com/socialonly', 'NG')`);
    });
    const r = await runCrawlTick(ws, { fetcher, resolver, concurrency: 3, isOnline: async () => true });
    expect(r.crawled).toBe(4); // the suppressed business's website (fixture-salon-1 on business 4) is never crawled
    expect(await run((q) => q.value<string | null>(sql`select website_crawl_status from prospects where phone = ${"+2348010000004"}`))).toBeNull();
    const rows = await run((q) => q.many<{ business_name: string; website_crawl_status: string; email: string | null; email_status: string; email_source_url: string | null }>(sql`
      select business_name, website_crawl_status, email, email_status, email_source_url from prospects where website is not null order by business_name`));
    const by = (s: string) => rows.find((x) => x.business_name.includes(s))!;
    expect(by("Glow Fixture Studio")).toMatchObject({ website_crawl_status: "ok", email: "hello@fixture-salon-0.test", email_status: "unknown", email_source_url: "https://fixture-salon-0.test/contact" });
    expect(by("Down Site").website_crawl_status).toBe("error");
    expect(by("Social Only").website_crawl_status).toBe("skipped");
    expect(rows.find((x) => x.website_crawl_status === "no_email")).toBeTruthy();
    // Errors are retried later, not immediately.
    expect((await runCrawlTick(ws, { fetcher, resolver, isOnline: async () => true })).crawled).toBe(0);
  });

  it("records nothing about sites while our own network is down", async () => {
    await run((q) => q.exec(sql`insert into prospects (workspace_id, business_name, normalized_name, source, website, country) values (${ws}, 'Outage Case', 'outage case', 'fake_a', 'https://outage-case.test/', 'NG')`));
    const dnsFail: Fetcher = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND outage-case.test"), { code: "ENOTFOUND" }); };
    const r = await runCrawlTick(ws, { fetcher: dnsFail, resolver, isOnline: async () => false });
    expect(r.crawled).toBe(0);
    const row = await run((q) => q.one<{ website_crawl_status: string | null; website_crawl_attempts: number }>(sql`select website_crawl_status, website_crawl_attempts from prospects where business_name = 'Outage Case'`));
    expect(row).toEqual({ website_crawl_status: null, website_crawl_attempts: 0 });
  });

  it("DNS-checks emails from source data and never marks them verified", async () => {
    const n = await runEmailCheckTick(ws, { resolver });
    expect(n).toBeGreaterThan(0);
    const statuses = await run((q) => q.many<{ email_status: string }>(sql`select distinct email_status from prospects where email is not null`));
    expect(statuses.map((s) => s.email_status)).not.toContain("verified");
    expect(statuses.map((s) => s.email_status)).not.toContain("unverified");
    const m = await run((q) => collectionMetrics(q));
    expect(m.email.domainMxPresent).toBe(m.withEmail);
    expect(m.email.deliverabilityUnknown).toBeGreaterThan(0);
    expect(m.businesses).toBeGreaterThanOrEqual(8);
  });
});
