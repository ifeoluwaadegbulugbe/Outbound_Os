/**
 * Email-first acceptance tests. Every send goes to the local test sink
 * (stored in test_outbox, never delivered). DNS and websites are mocked, so
 * nothing leaves the machine.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Driver } from "@/server/db/driver";
import { withWorkspace, sql, json, textArray, type Q } from "@/server/db";
import { setupFirstOwner } from "@/server/auth/service";
import { generateDraft } from "@/server/services/outreach";
import { sendEmailMessage, sendTestEmail, queueEmails, dispatchQueuedEmails, preflight } from "@/server/email/send";
import { getEmailSettings } from "@/server/email/policy";
import { processInbound } from "@/server/email/sync";
import { processUnsubscribe } from "@/server/email/unsubscribe";
import { verifyBasic, type Resolver } from "@/server/email/verify";
import { findEmailsOnWebsite, type Fetcher } from "@/server/email/finder";
import { enrichProspectEmail } from "@/server/email/enrich";
import { extractEmails } from "@/server/email/address";
import { emailFunnel, emailStats } from "@/server/services/email-metrics";
import type { Run } from "@/server/email/providers";
import { testDb } from "../helpers";

vi.stubEnv("AI_DISABLED", "true");
vi.stubEnv("APP_URL", "http://localhost:3000");

// OSM discovery: serve canned Overpass responses instead of the network.
const overpassCalls: string[] = [];
vi.mock("@/server/adapters/http", async (orig) => {
  const mod = await orig<typeof import("@/server/adapters/http")>();
  return {
    ...mod,
    integrationFetch: async (_url: string, init: RequestInit) => {
      const q = decodeURIComponent(String(init.body).replace(/^data=/, ""));
      overpassCalls.push(q);
      const base = q.includes('"shop"="barber"') ? 200 : 100;
      const elements = [1, 2, 3].map((n) => ({ type: "node", id: base + n, lat: 6.5, lon: 3.4, tags: { name: `Biz ${base + n}`, shop: "hairdresser", "contact:email": n === 1 ? `hello${base}@biz${base}.ng` : undefined } }));
      return new Response(JSON.stringify({ elements }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
});

let d: Driver;
let ws: string;
let owner: string;
let accountId: string;
let campaignId: string;
const run: Run = (fn) => withWorkspace({ workspaceId: ws, userId: owner }, fn, d);
const actor = () => ({ workspaceId: ws, actorType: "user" as const, actorId: owner });

const okResolver: Resolver = { mx: async () => [{ exchange: "mx.example.net", priority: 10 }], a: async () => ["192.0.2.1"] };

async function prospect(q: Q, name: string, email: string | null, extra: { country?: string; status?: string; website?: string } = {}): Promise<string> {
  const id = await q.value<string>(sql`
    insert into prospects (workspace_id, business_name, normalized_name, category, city, country, email, email_status, website, source, status, icp_score, priority_score)
    values (${ws}, ${name}, ${name.toLowerCase()}, 'nail_technician', 'Lagos', ${extra.country ?? "NG"}, ${email}, ${extra.status ?? (email ? "unknown" : "none")}, ${extra.website ?? null}, 'manual', 'QUALIFIED', 80, 70)
    returning id`);
  await q.exec(sql`insert into campaign_prospects (workspace_id, campaign_id, prospect_id) values (${ws}, ${campaignId}, ${id}) on conflict do nothing`);
  return id;
}

async function draftFor(prospectId: string): Promise<string> {
  const r = await generateDraft(run, { ...actor(), senderName: "Ada" }, { prospectId, campaignId, channel: "email", kind: "initial" });
  expect(r.messageId, r.reason).toBeTruthy();
  // Templates always include a subject; make sure the body passes validation for the test.
  await run((q) => q.exec(sql`update outreach_messages set subject = coalesce(nullif(subject, ''), 'Quick question about bookings') where id = ${r.messageId}`));
  return r.messageId!;
}

const outboxCount = () => run((q) => q.value<number>(sql`select count(*)::int from test_outbox`));

beforeAll(async () => {
  d = await testDb();
  (globalThis as unknown as { __obDriver?: Promise<Driver> }).__obDriver = Promise.resolve(d);
  const r = await setupFirstOwner({ workspaceName: "Orbit Growth", productName: "Orbit", name: "Ada Founder", email: "ada@test.local", password: "test-password-1" }, d);
  ws = r.workspaceId;
  owner = r.userId;
  await run(async (q) => {
    await q.exec(sql`update workspaces set settings = settings || ${json({ sender: { senderName: "Ada Founder", company: "Orbit", address: "1 Test Street, Lagos, Nigeria" } })} where id = ${ws}`);
    accountId = await q.value<string>(sql`
      insert into sender_accounts (workspace_id, user_id, channel, label, provider, email_address, from_name, daily_cap, warmup_enabled, min_interval_seconds)
      values (${ws}, ${owner}, 'email', 'Test mailbox', 'test_sink', 'ada@orbit.test', 'Ada', 50, false, 30) returning id`);
    campaignId = await q.value<string>(sql`
      insert into campaigns (workspace_id, name, slug, code, status, categories, cities, channels, followup_days, compliance)
      values (${ws}, 'Lagos email', 'lagos-email', 'lagos_email', 'active', ${textArray(["nail_technician"])}, ${textArray(["Lagos"])}, ${textArray(["email"])}, '{3,7}',
        ${json({ relevanceConfirmed: true, sourcesPermitUse: true, countryRulesReviewed: true, liaDocumented: true })}) returning id`);
  });
});
afterAll(async () => {
  (globalThis as unknown as { __obDriver?: Promise<Driver> }).__obDriver = undefined;
  await d?.close();
});

describe("sending through the provider", () => {
  let pid: string;
  let mid: string;

  it("sends, records the provider id, adds footer + unsubscribe, schedules follow-ups", async () => {
    pid = await run((q) => prospect(q, "Nails by Teni", "teni@nailsbyteni.ng"));
    mid = await draftFor(pid);
    const r = await sendEmailMessage(run, actor(), mid);
    expect(r.ok).toBe(true);
    const m = await run((q) => q.one<{ status: string; provider_message_id: string; to_email: string; unsubscribe_token: string; delivery_status: string }>(sql`
      select status, provider_message_id, to_email, unsubscribe_token, delivery_status from outreach_messages where id = ${mid}`));
    expect(m.status).toBe("sent");
    expect(m.provider_message_id).toMatch(/^sink_/);
    expect(m.to_email).toBe("teni@nailsbyteni.ng");
    expect(m.delivery_status).toBe("accepted");
    const mail = await run((q) => q.one<{ raw_mime: string }>(sql`select raw_mime from test_outbox order by created_at desc limit 1`));
    expect(mail.raw_mime).toContain(`List-Unsubscribe: <http://localhost:3000/u/${m.unsubscribe_token}>`);
    expect(mail.raw_mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const body = Buffer.from(mail.raw_mime.split("Content-Transfer-Encoding: base64")[1].trim().split(/\r?\n\r?\n|--/)[0].replace(/\s/g, ""), "base64").toString("utf8");
    expect(body).toContain("1 Test Street, Lagos, Nigeria");
    expect(body).toMatch(/unsubscribe/i);
    const fu = await run((q) => q.many<{ step: number }>(sql`select step from followups where prospect_id = ${pid} and status = 'pending' order by step`));
    expect(fu.length).toBeGreaterThan(0);
  });

  it("never sends the same message twice (idempotent), even when triggered concurrently", async () => {
    const before = await outboxCount();
    const again = await sendEmailMessage(run, actor(), mid);
    expect(again.ok).toBe(false);
    const p2 = await run((q) => prospect(q, "Glow Spa", "hello@glowspa.ng"));
    const m2 = await draftFor(p2);
    const [a, b] = await Promise.all([sendEmailMessage(run, actor(), m2), sendEmailMessage(run, actor(), m2)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await outboxCount()).toBe(before + 1);
  });

  it("refuses a second first-email to the same prospect", async () => {
    const dup = await run((q) => q.value<string>(sql`
      insert into outreach_messages (workspace_id, prospect_id, campaign_id, channel, kind, subject, body, generator, status)
      values (${ws}, ${pid}, ${campaignId}, 'email', 'initial', 'Hello again', 'Hi Teni, following up on bookings for Nails by Teni.\n\nThanks,\nAda', 'human', 'approved') returning id`));
    const s = await run((q) => getEmailSettings(q, ws));
    const pre = await run((q) => preflight(q, dup, s));
    expect(pre.ok).toBe(false);
  });

  it("keeps the draft and shows the real error when the provider fails", async () => {
    const p = await run((q) => prospect(q, "Fail Salon", "fail-transient@failsalon.ng"));
    const m = await draftFor(p);
    const r = await sendEmailMessage(run, actor(), m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("simulated transient");
    const row = await run((q) => q.one<{ status: string; sent_at: Date | null; error: string }>(sql`select status, sent_at, error from outreach_messages where id = ${m}`));
    expect(row.status).toBe("approved");
    expect(row.sent_at).toBeNull();
    expect(row.error).toContain("simulated transient");
    const failed = await run((q) => q.value<number>(sql`select count(*)::int from email_events where message_id = ${m} and type = 'failed'`));
    expect(failed).toBe(1);
  });

  it("blocks and suppresses a recipient the provider rejects", async () => {
    const p = await run((q) => prospect(q, "Nobody Here", "fail-invalid_recipient@nobody.ng"));
    const m = await draftFor(p);
    expect((await sendEmailMessage(run, actor(), m)).ok).toBe(false);
    const st = await run((q) => q.one<{ status: string; email_status: string; dnc: boolean }>(sql`
      select m.status, p.email_status, exists(select 1 from dnc_entries where kind = 'prospect' and value = ${p}) or p.do_not_contact as dnc
      from outreach_messages m join prospects p on p.id = m.prospect_id where m.id = ${m}`));
    expect(st.status).toBe("blocked");
    expect(st.email_status).toBe("invalid");
  });

  it("sends a test copy without changing the draft", async () => {
    const p = await run((q) => prospect(q, "Test Copy Studio", "owner@testcopy.ng"));
    const m = await draftFor(p);
    const r = await sendTestEmail(run, actor(), m, "ada@test.local");
    expect(r.ok).toBe(true);
    const mail = await run((q) => q.one<{ to_email: string; subject: string }>(sql`select to_email, subject from test_outbox order by created_at desc limit 1`));
    expect(mail.to_email).toBe("ada@test.local");
    expect(mail.subject.startsWith("[Test]")).toBe(true);
    const st = await run((q) => q.value<string>(sql`select status from outreach_messages where id = ${m}`));
    expect(st).toBe("needs_review");
  });

  it("blocks countries where cold email needs consent", async () => {
    const p = await run((q) => prospect(q, "Cape Town Brows", "hi@ctbrows.co.za", { country: "ZA" }));
    const m = await draftFor(p);
    const r = await sendEmailMessage(run, actor(), m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/consent/i);
  });

  it("blocks campaigns whose compliance checklist isn't complete", async () => {
    await run((q) => q.exec(sql`update campaigns set compliance = '{}'::jsonb where id = ${campaignId}`));
    const p = await run((q) => prospect(q, "Checklist Nails", "hi@checklistnails.ng"));
    const m = await draftFor(p);
    const r = await sendEmailMessage(run, actor(), m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Compliance check/);
    await run((q) => q.exec(sql`update campaigns set compliance = ${json({ relevanceConfirmed: true, sourcesPermitUse: true, countryRulesReviewed: true, liaDocumented: true })} where id = ${campaignId}`));
  });
});

describe("queue, caps and stop conditions", () => {
  it("queues approved emails and the dispatcher sends them within the daily cap", async () => {
    const ids: string[] = [];
    for (const n of [1, 2]) ids.push(await draftFor(await run((q) => prospect(q, `Queue Biz ${n}`, `owner@queuebiz${n}.ng`))));
    const q1 = await run((q) => queueEmails(q, actor(), ids));
    expect(q1.queued).toBe(2);
    // Cap = what's already been sent today + 1 → exactly one more may go out.
    const sentToday = await run((q) => q.value<number>(sql`select count(*)::int from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and not is_test`));
    await run((q) => q.exec(sql`update sender_accounts set daily_cap = ${sentToday + 1}, last_sent_at = null where id = ${accountId}`));
    expect(await dispatchQueuedEmails(ws, new Date(), { ignoreWindow: true })).toBe(1);
    await run((q) => q.exec(sql`update sender_accounts set last_sent_at = null where id = ${accountId}`));
    expect(await dispatchQueuedEmails(ws, new Date(), { ignoreWindow: true })).toBe(0); // cap reached
    const left = await run((q) => q.value<number>(sql`select count(*)::int from outreach_messages where id = any(${textArray(ids)}::uuid[]) and status = 'queued'`));
    expect(left).toBe(1);
    // Respects the minimum interval between sends.
    await run((q) => q.exec(sql`update sender_accounts set daily_cap = 500, last_sent_at = now() where id = ${accountId}`));
    expect(await dispatchQueuedEmails(ws, new Date(), { ignoreWindow: true })).toBe(0);
    await run((q) => q.exec(sql`update sender_accounts set last_sent_at = null where id = ${accountId}`));
    expect(await dispatchQueuedEmails(ws, new Date(), { ignoreWindow: true })).toBe(1);
  });

  it("stops follow-ups when the prospect replies", async () => {
    const p = await run((q) => prospect(q, "Reply Lashes", "hi@replylashes.ng"));
    const m = await draftFor(p);
    expect((await sendEmailMessage(run, actor(), m)).ok).toBe(true);
    const thread = await run((q) => q.value<string>(sql`select provider_thread_id from outreach_messages where id = ${m}`));
    expect(await run((q) => q.value<number>(sql`select count(*)::int from followups where prospect_id = ${p} and status = 'pending'`))).toBeGreaterThan(0);
    const r = await processInbound(run, ws, accountId, { providerId: "in-1", threadId: thread, from: "hi@replylashes.ng", subject: "Re: hello", text: "Interesting, how much does it cost?", receivedAt: new Date(), isBounce: false, isAutoReply: false });
    expect(r).toBe("reply");
    expect(await run((q) => q.value<number>(sql`select count(*)::int from followups where prospect_id = ${p} and status = 'pending'`))).toBe(0);
    // The same inbound message processed twice is ignored.
    expect(await processInbound(run, ws, accountId, { providerId: "in-1", threadId: thread, from: "x", subject: "", text: "", receivedAt: new Date(), isBounce: false, isAutoReply: false })).toBe("duplicate");
  });

  it("postpones (doesn't cancel) follow-ups on an out-of-office reply", async () => {
    const p = await run((q) => prospect(q, "Away Studio", "hi@awaystudio.ng"));
    const m = await draftFor(p);
    expect((await sendEmailMessage(run, actor(), m)).ok).toBe(true);
    const thread = await run((q) => q.value<string>(sql`select provider_thread_id from outreach_messages where id = ${m}`));
    const before = await run((q) => q.value<Date>(sql`select min(due_at) from followups where prospect_id = ${p} and status = 'pending'`));
    expect(await processInbound(run, ws, accountId, { providerId: "in-ooo", threadId: thread, from: "hi@awaystudio.ng", subject: "Out of office", text: "I'm away until Monday.", receivedAt: new Date(), isBounce: false, isAutoReply: true })).toBe("auto_reply");
    const after = await run((q) => q.value<Date>(sql`select min(due_at) from followups where prospect_id = ${p} and status = 'pending'`));
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("unsubscribe suppresses the address, cancels follow-ups and blocks future sends", async () => {
    const p = await run((q) => prospect(q, "Unsub Barbers", "hi@unsubbarbers.ng"));
    const m = await draftFor(p);
    expect((await sendEmailMessage(run, actor(), m)).ok).toBe(true);
    const token = await run((q) => q.value<string>(sql`select unsubscribe_token from outreach_messages where id = ${m}`));
    expect((await processUnsubscribe(token)).ok).toBe(true);
    expect((await processUnsubscribe(token)).ok).toBe(true); // idempotent
    const st = await run((q) => q.one<{ unsubscribed: boolean; pending: number; dnc: number }>(sql`
      select p.unsubscribed, (select count(*) from followups f where f.prospect_id = p.id and f.status = 'pending')::int as pending,
        (select count(*) from dnc_entries where kind = 'email' and value = 'hi@unsubbarbers.ng')::int as dnc
      from prospects p where p.id = ${p}`));
    expect(st).toEqual({ unsubscribed: true, pending: 0, dnc: 1 });
    const fu = await run((q) => q.value<string>(sql`
      insert into outreach_messages (workspace_id, prospect_id, campaign_id, channel, kind, step, subject, body, generator, status)
      values (${ws}, ${p}, ${campaignId}, 'email', 'followup', 1, 'Re: hi', 'Hi again from Ada about Unsub Barbers bookings.\n\nThanks,\nAda', 'human', 'approved') returning id`));
    const r = await sendEmailMessage(run, actor(), fu);
    expect(r.ok).toBe(false);
  });

  it("a bounce suppresses the address and the safety check pauses the account", async () => {
    await run((q) => q.exec(sql`update workspaces set settings = settings || ${json({ safety: { maxBounceRate: 0.05, maxComplaintRate: 0.003, minSample: 3 } })} where id = ${ws}`));
    const p = await run((q) => prospect(q, "Bounce Braids", "nobody@bouncebraids.ng"));
    const m = await draftFor(p);
    expect((await sendEmailMessage(run, actor(), m)).ok).toBe(true);
    const r = await processInbound(run, ws, accountId, { providerId: "in-bounce", threadId: "x", from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)",
      text: "550 5.1.1 The email account that you tried to reach does not exist.", receivedAt: new Date(), isBounce: true, isAutoReply: false, bouncedRecipient: "nobody@bouncebraids.ng" });
    expect(r).toBe("bounce");
    const st = await run((q) => q.one<{ bounced: boolean; email_status: string; delivery_status: string; status: string; paused_reason: string | null }>(sql`
      select p.bounced, p.email_status, m.delivery_status, a.status, a.paused_reason from prospects p, outreach_messages m, sender_accounts a
      where p.id = ${p} and m.id = ${m} and a.id = ${accountId}`));
    expect(st.bounced).toBe(true);
    expect(st.email_status).toBe("invalid");
    expect(st.delivery_status).toBe("bounced");
    // 1 bounce in ~10 sends > 5% → paused automatically.
    expect(st.status).toBe("paused");
    expect(st.paused_reason).toMatch(/bounce/i);
    const f = await run((q) => emailFunnel(q, {}));
    const s = await run((q) => emailStats(q, {}));
    expect(f.sent).toBeGreaterThan(0);
    expect(s.bounced).toBe(1);
    expect(s.rates.bounce).toBeGreaterThan(0);
  });
});

describe("finding and verifying emails", () => {
  it("DNS verification never claims 'verified' and flags dead domains", async () => {
    expect((await verifyBasic("info@livebiz-a.ng", okResolver)).status).toBe("unknown");
    expect((await verifyBasic("info@deadbiz-b.ng", { mx: async () => [], a: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } })).status).toBe("invalid");
    expect((await verifyBasic("x@mailinator.com", okResolver)).status).toBe("risky");
    expect((await verifyBasic("not-an-email", okResolver)).status).toBe("invalid");
  });

  it("extracts plain, mailto, obfuscated and Cloudflare-protected addresses", () => {
    const html = `<a href="mailto:Bookings@Salon.ng?subject=x">Book</a> reach us: hello [at] salon [dot] ng <span class="__cf_email__" data-cfemail="${cf("team@salon.ng")}"></span> logo@2x.png`;
    const found = extractEmails(html).map((e) => e.email);
    expect(found).toEqual(expect.arrayContaining(["bookings@salon.ng", "hello@salon.ng", "team@salon.ng"]));
    expect(found).not.toContain("logo@2x.png");
  });

  it("website finder respects robots.txt and records the source page", async () => {
    const pages: Record<string, string> = {
      "https://glamstudio.ng/robots.txt": "User-agent: *\nDisallow: /about",
      "https://glamstudio.ng/": `<a href="/contact">Contact</a> <a href="/about">About us</a>`,
      "https://glamstudio.ng/contact": `Email us: <a href="mailto:hello@glamstudio.ng">hello@glamstudio.ng</a>`,
      "https://glamstudio.ng/about": `secret@glamstudio.ng`,
    };
    const fetched: string[] = [];
    const fetcher: Fetcher = async (url) => {
      fetched.push(url);
      const body = pages[url];
      return body == null ? new Response("nope", { status: 404, headers: { "content-type": "text/html" } })
        : Object.defineProperty(new Response(body, { status: 200, headers: { "content-type": url.endsWith(".txt") ? "text/plain" : "text/html" } }), "url", { value: url });
    };
    const r = await findEmailsOnWebsite("glamstudio.ng", fetcher);
    expect(r.emails.map((e) => e.email)).toEqual(["hello@glamstudio.ng"]);
    expect(r.emails[0].sourceUrl).toBe("https://glamstudio.ng/contact");
    expect(r.blockedByRobots).toContain("https://glamstudio.ng/about");
    expect(fetched).not.toContain("https://glamstudio.ng/about");
  });

  it("enrichment stores every address with provenance and verifies the primary", async () => {
    const p = await run((q) => prospect(q, "Enrich Nails", null, { website: "https://enrichnails.ng" }));
    const fetcher: Fetcher = async (url) => url.endsWith("robots.txt")
      ? new Response("", { status: 404, headers: { "content-type": "text/plain" } })
      : Object.defineProperty(new Response(`<p>Bookings: info@enrichnails.ng</p>`, { status: 200, headers: { "content-type": "text/html" } }), "url", { value: url });
    const r = await enrichProspectEmail(run, ws, p, { fetcher, resolver: okResolver });
    expect(r.outcome).toBe("found");
    const row = await run((q) => q.one<{ email: string; email_status: string; email_source: string; email_source_url: string; email_discovered_at: Date | null; contacts: number }>(sql`
      select email, email_status, email_source, email_source_url, email_discovered_at,
        (select count(*) from prospect_contacts c where c.prospect_id = p.id and c.kind = 'email' and c.source_url is not null)::int as contacts
      from prospects p where id = ${p}`));
    expect(row.email).toBe("info@enrichnails.ng");
    expect(row.email_status).toBe("unknown");
    expect(row.email_source).toBe("website");
    expect(row.email_source_url).toMatch(/^https:\/\/enrichnails\.ng/);
    expect(row.email_discovered_at).not.toBeNull();
    expect(row.contacts).toBe(1);
    // A website with no email → "No email found", nothing invented.
    const p2 = await run((q) => prospect(q, "Quiet Spa", null, { website: "https://quietspa.ng" }));
    const none: Fetcher = async (url) => Object.defineProperty(new Response("<p>Call us</p>", { status: 200, headers: { "content-type": "text/html" } }), "url", { value: url });
    expect((await enrichProspectEmail(run, ws, p2, { fetcher: none, resolver: okResolver })).outcome).toBe("none_found");
    expect(await run((q) => q.value<string | null>(sql`select email from prospects where id = ${p2}`))).toBeNull();
  });
});

describe("resumable discovery", () => {
  it("resumes from the checkpoint without duplicating prospects", async () => {
    const { runDiscovery } = await import("@/server/services/discovery");
    const params = { adapter: "osm_overpass", categories: ["hair_stylist", "barber"], cities: ["ng_lagos"], limit: 100, campaignId: null };
    const runId = await run((q) => q.value<string>(sql`insert into discovery_runs (workspace_id, adapter, params, target) values (${ws}, 'osm_overpass', ${json(params)}, 100) returning id`));
    const ctx = (cancelAfter: number | null) => {
      let calls = 0;
      return {
        job: { id: crypto.randomUUID(), workspace_id: ws, type: "discovery.run", status: "running", payload: { runId, ...params }, attempts: 1, max_attempts: 3, created_by: owner },
        workspaceId: ws, userId: owner, ws: run, log: async () => {},
        // Simulate a pause after the first unit: progress() returning false stops the adapter.
        progress: async () => (cancelAfter == null ? true : calls++ < cancelAfter),
      };
    };
    await runDiscovery(ctx(1) as never);
    const afterFirst = await run((q) => q.one<{ checkpoint: { done: string[] }; n: number }>(sql`
      select checkpoint, (select count(*) from prospects where source = 'osm_overpass')::int as n from discovery_runs where id = ${runId}`));
    expect(afterFirst.checkpoint.done).toEqual(["osm:ng_lagos:hair_stylist"]);
    expect(afterFirst.n).toBe(3);
    const callsBefore = overpassCalls.length;
    await run((q) => q.exec(sql`update discovery_runs set status = 'queued' where id = ${runId}`));
    await runDiscovery(ctx(null) as never);
    expect(overpassCalls.length - callsBefore).toBe(1); // only the unfinished unit is queried again
    const final = await run((q) => q.one<{ status: string; n: number; emails_found: number; done: number }>(sql`
      select status, (select count(*) from prospects where source = 'osm_overpass')::int as n, emails_found, jsonb_array_length(checkpoint->'done')::int as done
      from discovery_runs where id = ${runId}`));
    expect(final).toEqual({ status: "succeeded", n: 6, emails_found: 2, done: 2 });
    // Running the same search again matches existing records instead of creating duplicates.
    const runId2 = await run((q) => q.value<string>(sql`insert into discovery_runs (workspace_id, adapter, params) values (${ws}, 'osm_overpass', ${json(params)}) returning id`));
    const c2 = ctx(null);
    c2.job.payload = { ...c2.job.payload, runId: runId2 };
    await runDiscovery(c2 as never);
    expect(await run((q) => q.value<number>(sql`select count(*)::int from prospects where source = 'osm_overpass'`))).toBe(6);
  });
});

/** Cloudflare email-protection encoding (for the extractor test). */
function cf(email: string): string {
  const key = 0x5a;
  return key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
}
