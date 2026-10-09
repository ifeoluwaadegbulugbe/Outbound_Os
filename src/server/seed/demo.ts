import { sql, raw, join, json, textArray, values, type Q, type SqlFragment } from "../db";
import { prepare } from "../services/ingest";
import { scoreIcp, scoreCompleteness, scorePriority, DEFAULT_ICP, SCORER_VERSION } from "../domain/scoring";
import { recommendAngle } from "../services/scoring-service";
import { templateMessage } from "../domain/templates";
import { validateMessage } from "../domain/validator";
import { DEFAULT_FOLLOWUP_STEPS } from "../services/workspace-defaults";
import type { Channel } from "../domain/taxonomy";

/**
 * Demo data: FICTIONAL businesses only. Every row is flagged is_demo so it
 * can be removed in one click, handles end in ".demo" and phone numbers use
 * the non-mobile +234 800 555 range, so nothing here can reach a real person.
 * The outreach history is simulated, but all dashboards compute from it
 * exactly as they would from real data.
 */

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ada", "Teni", "Chioma", "Bisi", "Funmi", "Zainab", "Amaka", "Tolu", "Kemi", "Ngozi", "Halima", "Yemi", "Ife", "Dami", "Simi", "Bukola", "Ronke", "Nneka", "Efe", "Ese", "Mide", "Lola", "Tayo", "Uche", "Femi", "Seun", "Kunle", "Tunde", "Emeka", "Musa", "Sade", "Joke", "Gbemi", "Ireti", "Morayo", "Adaeze", "Chidinma", "Oge", "Ebun", "Remi", "Wura", "Fola", "Titi", "Jumoke", "Kike", "Hauwa", "Aisha", "Precious", "Blessing", "Joy", "Favour", "Grace", "Peace", "Somto", "Obinna", "Kelechi", "Yinka", "Bayo", "Damola", "Toyin"];
const LAST = ["Okafor", "Adeyemi", "Balogun", "Eze", "Ibrahim", "Okonkwo", "Bello", "Nwosu", "Adebayo", "Ogunleye", "Danjuma", "Umeh", "Afolabi", "Lawal", "Obi", "Akande", "Usman", "Chukwu", "Oyelaran", "Etim"];

const TEMPLATES: Record<string, string[]> = {
  nail_technician: ["Nails by {F}", "{F}'s Nail Bar", "Polished by {F}", "{F} Nail Studio", "Glossy Tips {C}", "Claws & Co by {F}", "Tips by {F}"],
  hair_stylist: ["{F} Hair Lounge", "Braids by {F}", "{F}'s Wig Studio", "Crown Hair {C}", "Silk & Strands by {F}", "Knotless by {F}", "{F} Hair Studio"],
  lash_technician: ["Lashes by {F}", "{F} Lash Studio", "Flutter Lash Bar {C}", "Brows & Lashes by {F}", "Lash Lab by {F}"],
  makeup_artist: ["{F} Glow Studio", "Glam by {F}", "{F} Beauty", "Beat by {F}", "Bridal Glam by {F}", "Face by {F}"],
  barber: ["{F}'s Cuts", "Sharp Lines Barbershop {C}", "Fade Kings {C}", "Clean Cut by {F}", "{F} Grooming Lounge"],
  photographer: ["{F} Captures", "Lens by {F}", "Frame & Light {C}", "{F} Photography", "Shot by {F}"],
  event_planner: ["{F} Events", "Owambe Planners by {F}", "Petals & Plans {C}", "{F} Decor & Events"],
  fashion_designer: ["House of {F}", "{F} Couture", "Stitched by {F}", "{F} Bespoke", "Aso Ebi by {F}"],
  skincare: ["{F} Skin Clinic", "Glow Lab by {F}", "{F} Aesthetics"],
  spa_wellness: ["{F} Wellness Spa", "Calm Spa {C}", "Unwind by {F}"],
  fitness_trainer: ["Fit with {F}", "{F} Fitness", "Train with {F}"],
  coach: ["Coach {F}", "Grow with {F}", "{F} Coaching"],
};

const CRAFT_PHRASE: Record<string, string[]> = {
  nail_technician: ["Nail tech", "Acrylic & gel nails", "Nail artist", "Manicure & pedicure"],
  hair_stylist: ["Hair stylist", "Braids, wigs & installs", "Knotless braids specialist", "Wig revamps & frontal installs"],
  lash_technician: ["Lash tech", "Lash extensions & brows", "Classic, hybrid & volume lashes"],
  makeup_artist: ["Makeup artist", "Bridal & soft glam MUA", "Gele & makeup"],
  barber: ["Barber", "Fades, beards & lineups", "Barbing salon"],
  photographer: ["Photographer", "Portrait & event photography", "Photoshoots & studio sessions"],
  event_planner: ["Event planner", "Weddings, owambe & decor", "Event decor & planning"],
  fashion_designer: ["Fashion designer", "Bespoke aso ebi & ready-to-wear", "Tailor — made to measure"],
  skincare: ["Esthetician", "Facials & skincare clinic"],
  spa_wellness: ["Spa", "Massage & wellness therapist"],
  fitness_trainer: ["Personal trainer", "Fitness coach"],
  coach: ["Business coach", "Life coach"],
};

const AREAS: Record<string, string[]> = {
  Lagos: ["Lekki", "Yaba", "Ikeja", "Surulere", "Ajah", "VI", "Gbagada", "Magodo", "Ikoyi", "Festac"],
  Abuja: ["Wuse", "Garki", "Gwarinpa", "Jabi", "Kubwa", "Maitama"],
  "Port Harcourt": ["GRA", "Rumuola", "Trans Amadi"],
  Ibadan: ["Bodija", "Akobo", "Challenge"],
  "Benin City": ["Ugbowo", "GRA"],
  Enugu: ["Independence Layout", "New Haven"],
  Kano: ["Nassarawa"],
};

const CITY_W: [string, number][] = [["Lagos", 0.55], ["Abuja", 0.2], ["Port Harcourt", 0.1], ["Ibadan", 0.07], ["Benin City", 0.05], ["Enugu", 0.02], ["Kano", 0.01]];
const CAT_W: [string, number][] = [
  ["hair_stylist", 0.19], ["nail_technician", 0.15], ["makeup_artist", 0.12], ["lash_technician", 0.1], ["barber", 0.1], ["fashion_designer", 0.08],
  ["photographer", 0.07], ["event_planner", 0.06], ["skincare", 0.04], ["spa_wellness", 0.03], ["fitness_trainer", 0.03], ["coach", 0.03],
];
// Simulated response propensities (what the insights engine should rediscover).
const CAT_REPLY: Record<string, number> = { nail_technician: 1.7, lash_technician: 1.45, hair_stylist: 1.2, makeup_artist: 1.1, barber: 0.9, fashion_designer: 0.85, photographer: 0.55, event_planner: 0.7, skincare: 1, spa_wellness: 0.8, fitness_trainer: 0.8, coach: 0.6 };
const ANGLE_REPLY: Record<string, number> = { problem_first: 1.4, curiosity: 1.1, product_intro: 0.75, feedback_request: 1.0 };
const VARIANTS = [
  { key: "A", name: "Problem-focused", angle: "problem_first" },
  { key: "B", name: "Curiosity", angle: "curiosity" },
  { key: "C", name: "Casual introduction", angle: "product_intro" },
  { key: "D", name: "Feedback request", angle: "feedback_request" },
];
const INTENTS: [string, number][] = [["interested", 0.28], ["pricing", 0.2], ["question", 0.12], ["not_interested", 0.15], ["competitor", 0.07], ["maybe_later", 0.08], ["opt_out", 0.05], ["demo_request", 0.05]];
const REPLY_TEXT: Record<string, string[]> = {
  interested: ["This sounds interesting, tell me more", "Okay I'd like to try it", "Yes please send me the details", "Looks nice. How does it work?"],
  pricing: ["How much is it?", "This looks interesting, how much is it?", "Is it free or there's a monthly fee?", "What's the price per month?"],
  question: ["Does it work with WhatsApp?", "Can my clients pay through it?", "Can I use it on my phone?", "Does it send reminders automatically?"],
  not_interested: ["Not interested, thanks", "No thank you, I'm good", "I don't need it for now, thanks"],
  competitor: ["I already have a booking system", "I already use Fresha", "We already have a booking app"],
  maybe_later: ["Maybe later, I'm busy right now", "Not now, maybe next month", "Can you remind me next week?"],
  opt_out: ["Please don't contact me again.", "Stop messaging me please", "Who gave you my number? Don't message me"],
  demo_request: ["Can you show me how it works? Maybe a call", "Can we do a quick video call?"],
};

function weighted<T>(r: () => number, items: [T, number][]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    if ((x -= w) <= 0) return v;
  }
  return items[items.length - 1][0];
}
const pickR = <T,>(r: () => number, arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
const handleOf = (name: string) => `${name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 22)}.demo`;
const DAY = 86_400_000;

async function insertBatch(q: Q, table: string, cols: string[], rows: unknown[][], returning?: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150);
    const res = await q.many(sql`insert into ${raw(table)} (${join(cols.map(raw))}) values ${values(chunk)} ${returning ? raw(`returning ${returning}`) : sql``}`);
    out.push(...res);
  }
  return out;
}

export interface DemoSummary {
  prospects: number;
  contacted: number;
  replies: number;
  signups: number;
}

export async function loadDemoData(q: Q, ctx: { workspaceId: string; userId: string | null; productName: string }, opts: { count?: number; seed?: number } = {}): Promise<DemoSummary> {
  const r = rng(opts.seed ?? 20261007);
  const ws = ctx.workspaceId;
  const now = Date.now();
  const N = opts.count ?? 1200;

  // ── Campaigns, sequence, ICP ──
  const seqId = await q.value<string>(sql`select id from followup_sequences where is_default order by created_at limit 1`);
  const icpId = await q.value<string>(sql`select id from icp_profiles where is_default order by created_at limit 1`);
  const mkCampaign = (name: string, slug: string, status: string, cats: string[], cities: string[], channels: string[], goal: number, startDaysAgo: number) =>
    q.value<string>(sql`
      insert into campaigns (workspace_id, name, slug, status, target_description, categories, country, cities, channels, prospect_goal, objective, offer, tone,
                             instructions, constraints, icp_profile_id, followup_sequence_id, start_date, end_date, created_by)
      values (${ws}, ${name}, ${slug}, ${status}, ${"Appointment-based beauty and grooming businesses that take bookings in DMs or on WhatsApp."},
              ${textArray(cats)}, 'NG', ${textArray(cities)}, ${textArray(channels)}, ${goal}, 'Get Orbit signups', 'Free Orbit account',
              'Casual, conversational, human, Nigerian — not corporate',
              'Keep messages under 300 characters. Sound like a Nigerian founder casually reaching out. Mention the booking link only if they have one.',
              ${json({ maxChars: 300, mentionBookingLinkOnlyIfPresent: true })}, ${icpId}, ${seqId},
              ${new Date(now - startDaysAgo * DAY)}, ${new Date("2026-10-31")}, ${ctx.userId})
      returning id`);
  const cLagos = await mkCampaign("Lagos Beauty Businesses", "lagos-beauty-demo", "active", ["nail_technician", "hair_stylist", "makeup_artist", "lash_technician"], ["Lagos"], ["instagram", "whatsapp", "tiktok"], 5000, 24);
  const cAbuja = await mkCampaign("Abuja & PH Grooming", "abuja-grooming-demo", "active", ["barber", "hair_stylist", "skincare"], ["Abuja", "Port Harcourt"], ["instagram", "whatsapp"], 1500, 18);
  const cCreative = await mkCampaign("Creative Services Pilot", "creative-pilot-demo", "paused", ["photographer", "event_planner", "fashion_designer"], ["Lagos", "Abuja", "Ibadan"], ["instagram", "email"], 800, 12);
  const campaignFor = (cat: string, city: string) =>
    ["photographer", "event_planner", "fashion_designer", "coach"].includes(cat) ? cCreative : city === "Lagos" ? cLagos : ["Abuja", "Port Harcourt"].includes(city) ? cAbuja : cLagos;

  const variantIds: Record<string, Record<string, string>> = {};
  for (const c of [cLagos, cAbuja, cCreative]) {
    variantIds[c] = {};
    for (const v of VARIANTS) {
      variantIds[c][v.key] = await q.value<string>(sql`
        insert into message_variants (workspace_id, campaign_id, key, name, angle) values (${ws}, ${c}, ${v.key}, ${v.name}, ${v.angle}) returning id`);
    }
  }

  // ── Sender accounts ──
  const senders: Record<string, string> = {};
  for (const [ch, label, cap] of [["instagram", "@orbit.hq (demo)", 100], ["whatsapp", "Orbit Business +234 800 555 0000 (demo)", 80], ["tiktok", "@orbit.hq (demo)", 50]] as const) {
    senders[ch] = await q.value<string>(sql`
      insert into sender_accounts (workspace_id, user_id, channel, label, daily_cap, warmup_started_on)
      values (${ws}, ${ctx.userId}, ${ch}, ${label}, ${cap}, ${new Date(now - 30 * DAY)}) returning id`);
  }

  // ── Prospects ──
  type P = { id?: string; row: Record<string, unknown>; cat: string; city: string; discovered: number; icp: number; priority: number; signals: Record<string, { value: unknown }>; hasBooking: boolean; campaign: string };
  const people: P[] = [];
  const usedNames = new Set<string>();
  const fixed = [
    { name: "Ada Glow Studio", cat: "makeup_artist", city: "Lagos", first: "Ada", last: "Okafor" },
    { name: "Nails by Teni", cat: "nail_technician", city: "Lagos", first: "Teni", last: "Adeyemi" },
    { name: "FreshFade Studio", cat: "barber", city: "Abuja", first: "Musa", last: "Ibrahim" },
  ];
  for (let i = 0; i < N; i++) {
    const f = fixed[i];
    const cat = f?.cat ?? weighted(r, CAT_W);
    const city = f?.city ?? weighted(r, CITY_W);
    const first = f?.first ?? pickR(r, FIRST);
    const last = f?.last ?? pickR(r, LAST);
    let name = f?.name ?? pickR(r, TEMPLATES[cat]).replace("{F}", first).replace("{C}", city === "Port Harcourt" ? "PH" : city.split(" ")[0]);
    if (usedNames.has(name)) name = `${name} ${pickR(r, AREAS[city] ?? ["Studio"])}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    const area = pickR(r, AREAS[city] ?? [""]);
    const handle = handleOf(name);
    const phone = `+234800555${String(1000 + i).slice(-4)}`;
    const localPhone = `0800 555 ${String(1000 + i).slice(-4)}`;
    const bits: string[] = [`${pickR(r, CRAFT_PHRASE[cat])} in ${area}, ${city}${r() < 0.5 ? " ✨" : ""}`];
    const dm = r() < 0.58;
    const wa = r() < 0.5;
    const hasBooking = r() < 0.22;
    const fresha = !hasBooking && r() < 0.05;
    if (dm) bits.push(pickR(r, ["DM to book", "DM for bookings", "Bookings open — DM to book"]));
    if (wa) bits.push(`WhatsApp ${localPhone}`);
    if (r() < 0.3) bits.push("Home service available");
    if (r() < 0.25) bits.push(pickR(r, ["Deposit required to secure your slot", "50% deposit before booking", "No deposit no booking"]));
    if (hasBooking) bits.push(`Book via selar.co/${handle.replace(".demo", "")}`);
    if (fresha) bits.push(`Book on fresha.com/${handle.replace(".demo", "")}`);
    if (r() < 0.2) bits.push(pickR(r, ["Training available", "Products available", "Est. 2019", "Open Mon–Sat"]));
    const lastPost = (() => {
      const x = r();
      if (x < 0.7) return now - Math.floor(r() * 14) * DAY;
      if (x < 0.85) return now - (15 + Math.floor(r() * 45)) * DAY;
      if (x < 0.95) return now - (60 + Math.floor(r() * 150)) * DAY;
      return null;
    })();
    const followers = Math.round(Math.exp(5.3 + r() * 5.2));
    const discoveredDaysAgo = Math.floor(Math.pow(r(), 1.3) * 24);
    const prep = prepare({
      business_name: name,
      owner_name: r() < 0.7 ? `${first} ${last}` : null,
      bio: bits.join(" · "),
      city,
      area,
      country: "NG",
      instagram_handle: r() < 0.93 ? handle : null,
      tiktok_handle: r() < 0.35 ? handle : null,
      phone: wa || r() < 0.3 ? phone : null,
      follower_count: followers,
      last_post_date: lastPost ? new Date(lastPost) : null,
      posting_frequency: lastPost && now - lastPost < 14 * DAY ? Math.round((1 + r() * 6) * 10) / 10 : Math.round(r() * 10) / 10,
      category: cat,
      source: pickR(r, ["instagram_graph", "instagram_graph", "instagram_graph", "osm_overpass", "csv", "manual_capture"]),
      is_demo: true,
    });
    const sc = { ...prep.row, signals: prep.signals } as never;
    const icp = scoreIcp(sc, DEFAULT_ICP, new Date(now));
    const comp = scoreCompleteness(sc);
    const pr = scorePriority(sc, icp, comp);
    prep.row.icp_score = icp.icp;
    prep.row.fit_score = icp.fit;
    prep.row.intent_score = icp.intent;
    prep.row.priority_score = pr.score;
    prep.row.completeness_score = comp.score;
    prep.row.outreach_priority = pr.tier;
    prep.row.score_reasons = { reasons: icp.reasons, components: icp.components, completeness: comp, priority: pr.parts };
    prep.row.recommended_message_angle = recommendAngle(sc);
    prep.row.status = icp.qualified ? "QUALIFIED" : "NEW";
    const discovered = now - discoveredDaysAgo * DAY - Math.floor(r() * DAY);
    prep.row.discovered_at = new Date(discovered);
    prep.row.qualified_at = icp.qualified ? new Date(discovered + 60_000) : null;
    prep.row.scored_at = new Date(discovered + 60_000);
    people.push({ row: prep.row, cat, city, discovered, icp: icp.icp, priority: pr.score, signals: prep.signals, hasBooking, campaign: campaignFor(cat, city) });
  }

  const PCOLS = [
    "workspace_id", "business_name", "normalized_name", "owner_name", "first_name", "last_name", "category", "services", "bio", "country", "state", "city", "area",
    "timezone", "instagram_handle", "instagram_url", "tiktok_handle", "tiktok_url", "phone", "whatsapp", "website", "website_domain", "booking_url",
    "has_booking_link", "accepts_bookings", "accepts_whatsapp_bookings", "accepts_online_payments", "has_client_management_system", "follower_count",
    "last_post_date", "posting_frequency", "signals", "source", "is_demo", "icp_score", "fit_score", "intent_score", "priority_score", "completeness_score",
    "outreach_priority", "score_reasons", "recommended_message_angle", "status", "discovered_at", "qualified_at", "scored_at", "created_at",
  ];
  const prow = (p: P): unknown[] =>
    PCOLS.map((c): unknown => {
      if (c === "workspace_id") return ws;
      if (c === "services") return textArray((p.row.services as string[]) ?? []);
      if (c === "signals" || c === "score_reasons") return json(p.row[c] ?? {});
      if (c === "created_at") return new Date(p.discovered);
      return p.row[c] ?? null;
    });
  const inserted = await insertBatch(q, "prospects", PCOLS, people.map(prow), "id");
  people.forEach((p, i) => (p.id = inserted[i].id as string));

  await insertBatch(q, "campaign_prospects", ["workspace_id", "campaign_id", "prospect_id", "added_at"], people.map((p) => [ws, p.campaign, p.id, new Date(p.discovered)]));
  await insertBatch(q, "prospect_sources", ["workspace_id", "prospect_id", "source", "discovered_at"], people.map((p) => [ws, p.id, p.row.source, new Date(p.discovered)]));
  await insertBatch(q, "prospect_scores", ["workspace_id", "prospect_id", "icp_profile_id", "icp_score", "fit_score", "intent_score", "priority_score", "completeness_score", "breakdown", "scorer_version", "computed_at"],
    people.map((p) => [ws, p.id, icpId, p.row.icp_score, p.row.fit_score, p.row.intent_score, p.row.priority_score, p.row.completeness_score, json(p.row.score_reasons), SCORER_VERSION, new Date(p.discovered + 60_000)]));
  await insertBatch(q, "outreach_events", ["workspace_id", "prospect_id", "campaign_id", "type", "data", "actor_type", "created_at"],
    people.map((p) => [ws, p.id, p.campaign, "prospect.discovered", json({ source: p.row.source }), "system", new Date(p.discovered)]));

  // ── Simulated outreach history ──
  const msgs: unknown[][] = [];
  const events: unknown[][] = [];
  const convos: { prospect: P; channel: string; started: number; inbound: { at: number; text: string; intent: string }; outbound: { at: number; body: string }[]; respondedByUs: boolean }[] = [];
  const followups: unknown[][] = [];
  const conversions: unknown[][] = [];
  const updates: { id: string; set: Record<string, unknown> }[] = [];
  const dnc: unknown[][] = [];
  let contacted = 0, replies = 0, signups = 0;

  for (const p of people) {
    if (p.row.status !== "QUALIFIED") continue;
    const age = (now - p.discovered) / DAY;
    if (age < 1.5 || r() > 0.6) continue;
    const variant = pickR(r, VARIANTS);
    const sentAt = Math.min(now - 3_600_000, p.discovered + (0.5 + r() * 2.5) * DAY);
    const channel: Channel = p.row.instagram_handle && r() < 0.68 ? "instagram" : p.row.whatsapp ? "whatsapp" : p.row.tiktok_handle ? "tiktok" : p.row.instagram_handle ? "instagram" : "whatsapp";
    if (channel === "whatsapp" && !p.row.whatsapp && !p.row.phone) continue;
    const tp = { id: p.id!, business_name: p.row.business_name as string, first_name: p.row.first_name as string | null, category: p.cat, city: p.city, booking_url: p.row.booking_url as string | null, signals: p.signals, instagram_handle: p.row.instagram_handle as string | null };
    const msg = templateMessage({ prospect: tp, angle: variant.angle, channel, kind: "initial", productName: ctx.productName, noEmojis: true });
    contacted++;
    const msgId = crypto.randomUUID();
    msgs.push([msgId, ws, p.id, p.campaign, channel, "initial", 0, variantIds[p.campaign][variant.key], variant.angle, textArray(msg.valueProps), msg.body, msg.body, "template", "sent", json({ ok: true, issues: [] }), "assisted", senders[channel] ?? null, ctx.userId, new Date(sentAt - 600_000), ctx.userId, new Date(sentAt), new Date(sentAt - 3_600_000)]);
    events.push([ws, p.id, p.campaign, msgId, "message.sent", channel, json({ variant: variant.key }), "user", ctx.userId, new Date(sentAt)]);
    const set: Record<string, unknown> = { first_contacted_at: new Date(sentAt), last_contacted_at: new Date(sentAt), contact_count: 1, last_channel: channel, status: "CONTACTED" };

    // Reply?
    const pReply = 0.085 * (CAT_REPLY[p.cat] ?? 1) * (ANGLE_REPLY[variant.angle] ?? 1) * (p.signals.dmBookings || p.signals.whatsappBookings ? 1.25 : 0.85) * (p.hasBooking ? 0.8 : 1);
    const daysSinceSent = (now - sentAt) / DAY;
    const viaFollowup = r() < 0.3;
    const replied = r() < pReply * 1.15;
    const outbound = [{ at: sentAt, body: msg.body }];
    if (!replied || viaFollowup) {
      // Follow-up 1 at day 3
      const fuAt = sentAt + 3 * DAY;
      if (fuAt < now) {
        const fu = templateMessage({ prospect: tp, angle: variant.angle, channel, kind: "followup", step: 1, productName: ctx.productName, noEmojis: true });
        const fuId = crypto.randomUUID();
        msgs.push([fuId, ws, p.id, p.campaign, channel, "followup", 1, variantIds[p.campaign][variant.key], "bump", textArray([]), fu.body, fu.body, "template", "sent", json({ ok: true, issues: [] }), "assisted", senders[channel] ?? null, ctx.userId, new Date(fuAt), ctx.userId, new Date(fuAt), new Date(fuAt)]);
        events.push([ws, p.id, p.campaign, fuId, "message.sent", channel, json({ followup: 1 }), "user", ctx.userId, new Date(fuAt)]);
        outbound.push({ at: fuAt, body: fu.body });
        set.contact_count = 2;
        set.last_contacted_at = new Date(fuAt);
        followups.push([ws, p.id, p.campaign, seqId, 1, channel, new Date(fuAt), "done", fuId, new Date(fuAt)]);
        if (!replied) {
          const nextDue = sentAt + DEFAULT_FOLLOWUP_STEPS[1].day * DAY;
          followups.push([ws, p.id, p.campaign, seqId, 2, channel, new Date(nextDue), nextDue < now - DAY * 3 ? "done" : "pending", null, null]);
          set.next_follow_up_at = new Date(nextDue);
          set.status = "FOLLOW_UP";
        }
      } else if (!replied) {
        followups.push([ws, p.id, p.campaign, seqId, 1, channel, new Date(fuAt), "pending", null, null]);
        set.next_follow_up_at = new Date(fuAt);
      }
    }

    if (replied) {
      const base = viaFollowup && outbound.length > 1 ? outbound[1].at : sentAt;
      const replyAt = Math.min(now - 600_000, base + (0.1 + r() * 2) * DAY);
      if (replyAt > sentAt) {
        replies++;
        const intent = weighted(r, INTENTS);
        const text = pickR(r, REPLY_TEXT[intent]);
        set.replied_at = new Date(replyAt);
        events.push([ws, p.id, p.campaign, null, "reply.received", channel, json({}), "user", ctx.userId, new Date(replyAt)]);
        events.push([ws, p.id, p.campaign, null, "reply.classified", channel, json({ intent, confidence: 90 }), "ai", null, new Date(replyAt + 30_000)]);
        set.next_follow_up_at = null;
        const positive = ["interested", "pricing", "demo_request"].includes(intent) || (intent === "question" && r() < 0.5);
        const respondedByUs = daysSinceSent > 1.2 && r() < 0.85;
        if (intent === "opt_out") {
          set.status = "DO_NOT_CONTACT";
          set.do_not_contact = true;
          set.dnc_reason = "opt_out";
          set.dnc_at = new Date(replyAt);
          if (p.row.instagram_handle) dnc.push([ws, "instagram", p.row.instagram_handle, "opt_out", p.id, new Date(replyAt)]);
        } else if (positive) {
          set.status = intent === "demo_request" ? "DEMO" : "INTERESTED";
          set.interested_at = new Date(replyAt);
          const pSignup = 0.48 * Math.min(1.4, CAT_REPLY[p.cat] ?? 1) * (p.hasBooking ? 1.3 : 1);
          if (respondedByUs && r() < pSignup && replyAt < now - DAY * 0.5) {
            signups++;
            const su = replyAt + (0.2 + r() * 1.5) * DAY;
            if (su < now) {
              set.status = "SIGNED_UP";
              set.signed_up = true;
              set.signup_at = new Date(su);
              set.attribution = json({ campaign_id: p.campaign, variant: variant.key, channel, source: p.row.source });
              conversions.push([ws, p.id, "signup", `demo-user-${p.id}`, "ref_code", `ob_${p.id!.slice(0, 8)}`, new Date(su), p.campaign, variantIds[p.campaign][variant.key], channel, "webhook"]);
              events.push([ws, p.id, p.campaign, null, "conversion.signup", channel, json({ match: "ref_code" }), "webhook", null, new Date(su)]);
              const act = su + (0.5 + r() * 3) * DAY;
              if (act < now && r() < 0.6) {
                set.status = "ACTIVATED";
                set.activated = true;
                set.activation_at = new Date(act);
                conversions.push([ws, p.id, "activated", `demo-user-${p.id}`, "ref_code", `ob_${p.id!.slice(0, 8)}`, new Date(act), p.campaign, variantIds[p.campaign][variant.key], channel, "webhook"]);
                events.push([ws, p.id, p.campaign, null, "conversion.activated", channel, json({}), "webhook", null, new Date(act)]);
                const paid = act + (2 + r() * 8) * DAY;
                if (paid < now && r() < 0.32) {
                  set.status = "PAID";
                  set.paid = true;
                  set.paid_at = new Date(paid);
                  set.subscription_plan = "Pro Monthly";
                  conversions.push([ws, p.id, "paid", `demo-user-${p.id}`, "ref_code", `ob_${p.id!.slice(0, 8)}`, new Date(paid), p.campaign, variantIds[p.campaign][variant.key], channel, "webhook"]);
                  events.push([ws, p.id, p.campaign, null, "conversion.paid", channel, json({ plan: "Pro Monthly" }), "webhook", null, new Date(paid)]);
                }
              }
            }
          }
        } else if (intent === "not_interested" || intent === "competitor") set.status = "NOT_INTERESTED";
        else if (intent === "maybe_later") {
          set.status = "FOLLOW_UP";
          const due = replyAt + 14 * DAY;
          followups.push([ws, p.id, p.campaign, seqId, 9, channel, new Date(due), "pending", null, null]);
          set.next_follow_up_at = new Date(due);
        } else set.status = "REPLIED";
        convos.push({ prospect: p, channel, started: sentAt, inbound: { at: replyAt, text, intent }, outbound, respondedByUs: respondedByUs && intent !== "opt_out" });
      }
    }
    updates.push({ id: p.id!, set });
  }

  await insertBatch(q, "outreach_messages",
    ["id", "workspace_id", "prospect_id", "campaign_id", "channel", "kind", "step", "variant_id", "angle", "value_props", "body", "original_body", "generator", "status", "validation", "send_mode", "sender_account_id", "approved_by", "approved_at", "sent_by", "sent_at", "created_at"],
    msgs);
  await insertBatch(q, "outreach_events", ["workspace_id", "prospect_id", "campaign_id", "message_id", "type", "channel", "data", "actor_type", "actor_id", "created_at"], events);
  if (followups.length)
    await insertBatch(q, "followups", ["workspace_id", "prospect_id", "campaign_id", "sequence_id", "step", "channel", "due_at", "status", "message_id", "completed_at"], followups);
  if (conversions.length)
    await insertBatch(q, "conversions", ["workspace_id", "prospect_id", "type", "external_user_id", "match_method", "ref_code", "occurred_at", "campaign_id", "variant_id", "channel", "source"], conversions);
  if (dnc.length) await insertBatch(q, "dnc_entries", ["workspace_id", "kind", "value", "reason", "prospect_id", "created_at"], dnc);

  // Apply per-prospect updates (grouped by identical column sets for speed).
  for (const u of updates) {
    const sets: SqlFragment[] = Object.entries(u.set).map(([k, v]) => sql`${raw(k)} = ${v as never}`);
    await q.exec(sql`update prospects set ${join(sets)} where id = ${u.id}`);
  }

  // Conversations
  for (const c of convos) {
    const status = c.inbound.intent === "opt_out" || c.inbound.intent === "not_interested" ? "closed" : c.respondedByUs ? "waiting" : "needs_response";
    const lastAt = c.respondedByUs ? c.inbound.at + 3_600_000 : c.inbound.at;
    const convId = await q.value<string>(sql`
      insert into conversations (workspace_id, prospect_id, campaign_id, channel, status, intent, intent_confidence, summary, next_action, priority, unread, last_message_at, last_inbound_at, created_at)
      values (${ws}, ${c.prospect.id}, ${c.prospect.campaign}, ${c.channel}, ${status}, ${c.inbound.intent}, 90,
              ${`Replied to the first message: "${c.inbound.text}"`}, ${status === "needs_response" ? "Reply today" : null},
              ${["interested", "pricing", "demo_request"].includes(c.inbound.intent) ? "high" : "normal"}, ${status === "needs_response"},
              ${new Date(lastAt)}, ${new Date(c.inbound.at)}, ${new Date(c.started)})
      returning id`);
    const rows: unknown[][] = c.outbound.map((o) => [ws, convId, "outbound", o.body, new Date(o.at), null]);
    rows.push([ws, convId, "inbound", c.inbound.text, new Date(c.inbound.at), json({ intent: c.inbound.intent, confidence: 90, source: "rules" })]);
    if (c.respondedByUs) rows.push([ws, convId, "outbound", "Thanks! Here's the link to get started — takes about 2 minutes.", new Date(c.inbound.at + 3_600_000), null]);
    await insertBatch(q, "conversation_messages", ["workspace_id", "conversation_id", "direction", "body", "occurred_at", "classification"], rows);
  }

  // ── Review queue: drafts for top uncontacted prospects ──
  const ready = people
    .filter((p) => p.row.status === "QUALIFIED" && !updates.some((u) => u.id === p.id))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 60);
  const drafts: unknown[][] = [];
  for (const p of ready) {
    const variant = pickR(r, VARIANTS);
    const channel: Channel = p.row.instagram_handle ? "instagram" : p.row.whatsapp ? "whatsapp" : "tiktok";
    if (channel === "tiktok" && !p.row.tiktok_handle) continue;
    const tp = { id: p.id!, business_name: p.row.business_name as string, first_name: p.row.first_name as string | null, category: p.cat, city: p.city, booking_url: p.row.booking_url as string | null, signals: p.signals, instagram_handle: p.row.instagram_handle as string | null };
    const msg = templateMessage({ prospect: tp, angle: variant.angle, channel, kind: "initial", productName: ctx.productName, noEmojis: true });
    const v = validateMessage({
      body: msg.body, channel, kind: "initial",
      prospect: { ...tp, owner_name: p.row.owner_name as string | null, status: "QUALIFIED", do_not_contact: false, accepts_whatsapp_bookings: p.row.accepts_whatsapp_bookings as boolean | null, follower_count: p.row.follower_count as number | null, tiktok_handle: p.row.tiktok_handle as string | null, whatsapp: p.row.whatsapp as string | null, phone: p.row.phone as string | null, email: null },
      context: { workspacePaused: false }, constraints: { maxChars: 300, mentionBookingLinkOnlyIfPresent: true },
    });
    drafts.push([ws, p.id, p.campaign, channel, "initial", 0, variantIds[p.campaign][variant.key], variant.angle, textArray(msg.valueProps), msg.body, msg.body, "template", v.ok ? "needs_review" : "blocked", json(v), new Date(now - Math.floor(r() * 6) * 3_600_000)]);
  }
  await insertBatch(q, "outreach_messages", ["workspace_id", "prospect_id", "campaign_id", "channel", "kind", "step", "variant_id", "angle", "value_props", "body", "original_body", "generator", "status", "validation", "created_at"], drafts);
  await q.exec(sql`update prospects set status = 'READY' where id in (select prospect_id from outreach_messages where status = 'needs_review') and status = 'QUALIFIED'`);

  // ── Near-duplicates for the review queue ──
  const dupBase = people.slice(10, 16);
  for (const b of dupBase) {
    const variantName = `${b.row.business_name as string} ${b.city === "Port Harcourt" ? "PH" : b.city.split(" ")[0]}`;
    const dupId = await q.value<string>(sql`
      insert into prospects (workspace_id, business_name, normalized_name, category, city, country, source, is_demo, icp_score, priority_score, completeness_score, status, discovered_at)
      values (${ws}, ${variantName}, ${variantName.toLowerCase()}, ${b.cat}, ${b.city}, 'NG', 'osm_overpass', true, ${Math.max(0, b.icp - 25)}, ${Math.max(0, b.priority - 30)}, 35, 'NEW', ${new Date(now - 2 * DAY)})
      returning id`);
    const [a, c] = [b.id!, dupId].sort();
    await q.exec(sql`insert into possible_duplicates (workspace_id, prospect_a, prospect_b, confidence, reasons)
                     values (${ws}, ${a}, ${c}, 74, ${json({ reasons: ["Similar name (88% match)", `Both in ${b.city}`], conflicts: [] })})`);
  }

  // ── Goals, experiments, discovery runs, notifications ──
  await q.exec(sql`insert into goals (workspace_id, name, metric, target, start_date, end_date, campaign_id)
                   values (${ws}, 'Qualify 1,000 service businesses (demo scale)', 'qualified', 1000, ${new Date(now - 24 * DAY)}, '2026-10-31', null),
                          (${ws}, '60 signups from Lagos Beauty', 'signed_up', 60, ${new Date(now - 24 * DAY)}, '2026-10-31', ${cLagos})`);
  const expId = await q.value<string>(sql`insert into experiments (workspace_id, campaign_id, name, hypothesis, kind, primary_metric, status, started_at)
    values (${ws}, ${cLagos}, 'Problem-first vs curiosity openers', 'Naming a specific friction (DM/WhatsApp bookings) gets more replies than a curious question.', 'message', 'reply_rate', 'running', ${new Date(now - 20 * DAY)}) returning id`);
  await q.exec(sql`insert into experiment_variants (workspace_id, experiment_id, key, name, config) values
    (${ws}, ${expId}, 'A', 'Problem-first', ${json({ angle: "problem_first" })}), (${ws}, ${expId}, 'B', 'Curiosity', ${json({ angle: "curiosity" })})`);
  const exp2 = await q.value<string>(sql`insert into experiments (workspace_id, name, hypothesis, kind, primary_metric, status, started_at)
    values (${ws}, 'Nail techs vs hair stylists', 'Nail techs sign up at a higher rate because bookings are their main pain.', 'icp', 'signup_rate', 'running', ${new Date(now - 20 * DAY)}) returning id`);
  await q.exec(sql`insert into experiment_variants (workspace_id, experiment_id, key, name, config) values
    (${ws}, ${exp2}, 'A', 'Nail technicians', ${json({ category: "nail_technician" })}), (${ws}, ${exp2}, 'B', 'Hair stylists', ${json({ category: "hair_stylist" })})`);
  const exp3 = await q.value<string>(sql`insert into experiments (workspace_id, name, hypothesis, kind, primary_metric, status, started_at)
    values (${ws}, 'Instagram vs WhatsApp first touch', 'WhatsApp gets faster replies; Instagram gets more signups.', 'channel', 'reply_rate', 'running', ${new Date(now - 20 * DAY)}) returning id`);
  await q.exec(sql`insert into experiment_variants (workspace_id, experiment_id, key, name, config) values
    (${ws}, ${exp3}, 'A', 'Instagram', ${json({ channel: "instagram" })}), (${ws}, ${exp3}, 'B', 'WhatsApp', ${json({ channel: "whatsapp" })})`);

  await q.exec(sql`insert into discovery_runs (workspace_id, campaign_id, adapter, params, status, found, created, merged, duplicates_flagged, created_by, created_at, finished_at)
    values (${ws}, ${cLagos}, 'mock_source', ${json({ categories: ["nail_technician", "lash_technician"], cities: ["lagos"], limit: 500, demo: true })}, 'succeeded', 512, 480, 26, 6, ${ctx.userId}, ${new Date(now - 20 * DAY)}, ${new Date(now - 20 * DAY + 600_000)})`);

  await q.exec(sql`insert into notifications (workspace_id, type, title, body, link, created_at) values
    (${ws}, 'signup', '🎉 A prospect from Lagos Beauty Businesses just signed up', 'Demo data — conversions are simulated.', '/analytics', ${new Date(now - 3 * 3_600_000)}),
    (${ws}, 'reply', 'New interested reply', 'A prospect asked about pricing.', '/inbox?f=needs_response', ${new Date(now - 5 * 3_600_000)}),
    (${ws}, 'milestone', 'Demo data loaded', ${`${people.length} fictional prospects with simulated outreach history. Remove it any time in Settings.`}, '/settings', ${new Date(now)})`);

  return { prospects: people.length, contacted, replies, signups };
}

/** Remove every demo row (cascades to messages, events, conversations, etc). */
export async function clearDemoData(q: Q): Promise<number> {
  const n = await q.value<number>(sql`select count(*)::int from prospects where is_demo`);
  await q.exec(sql`delete from prospects where is_demo`);
  await q.exec(sql`delete from campaigns where slug like '%-demo'`);
  await q.exec(sql`delete from sender_accounts where label like '%(demo)'`);
  await q.exec(sql`delete from goals where name like '%(demo scale)%' or campaign_id is null and name = '60 signups from Lagos Beauty'`);
  await q.exec(sql`delete from experiments where name in ('Problem-first vs curiosity openers', 'Nail techs vs hair stylists', 'Instagram vs WhatsApp first touch')`);
  await q.exec(sql`delete from discovery_runs where params->>'demo' = 'true'`);
  await q.exec(sql`delete from notifications where body like 'Demo data%' or title = 'Demo data loaded'`);
  return n;
}
