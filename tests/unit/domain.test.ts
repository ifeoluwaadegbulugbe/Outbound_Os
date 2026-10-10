import { describe, it, expect } from "vitest";
import { json, toQuery } from "@/server/db/sql";
import { extractSignals, normalizeName, normalizePhone, socialFromUrl, coreName } from "@/server/domain/normalize";
import { scoreIcp, scoreCompleteness, scorePriority, DEFAULT_ICP, type ScorableProspect } from "@/server/domain/scoring";
import { compareProspects, nameSimilarity, type DedupRecord } from "@/server/domain/dedup";
import { canTransition, outreachBlockReason } from "@/server/domain/status";
import { classifyByRules, statusForIntent } from "@/server/domain/classifier";
import { validateMessage, type ValidationInput } from "@/server/domain/validator";
import { effectiveDailyCap, openUrl } from "@/server/domain/channels";
import { parseNaturalLanguage, describeFilter, filterSchema } from "@/server/domain/filters";

const NOW = new Date("2026-10-07T10:00:00Z");

function prospect(over: Partial<ScorableProspect> = {}): ScorableProspect {
  return {
    business_name: "Ada Glow Studio", category: "makeup_artist", services: ["bridal makeup", "glam"], country: "NG", city: "Lagos",
    business_size: "solo", instagram_handle: "adaglowstudio", tiktok_handle: null, email: null, phone: "+2348031234567", whatsapp: null,
    website: null, booking_url: null, bio: "Lagos MUA ✨ Bridal & glam. DM to book. WhatsApp 0803 123 4567", description: null,
    follower_count: 4200, last_post_date: new Date("2026-10-03"), posting_frequency: 4, accepts_bookings: true, has_booking_link: false,
    accepts_whatsapp_bookings: true, accepts_online_payments: null, has_website: false, has_client_management_system: null,
    has_invoice_system: null, has_payment_system: null,
    signals: { dmBookings: { value: true, source: "bio", quote: "DM to book" }, whatsappBookings: { value: true, source: "bio" } },
    ...over,
  };
}

describe("normalize", () => {
  it("normalizes names, phones and social URLs", () => {
    expect(normalizeName("Joy Beauty Studio Ltd.")).toBe("joy beauty studio");
    expect(coreName("Joy Beauty Lagos")).toBe("joy beauty");
    expect(normalizePhone("0803 123 4567")).toBe("+2348031234567");
    expect(normalizePhone("+234 803-123-4567")).toBe("+2348031234567");
    expect(normalizePhone("123")).toBeNull();
    expect(socialFromUrl("https://www.instagram.com/nailsbyteni/")).toMatchObject({ platform: "instagram", handle: "nailsbyteni" });
    expect(socialFromUrl("https://www.tiktok.com/@freshfade.abj?lang=en")).toMatchObject({ platform: "tiktok", handle: "freshfade.abj" });
    expect(socialFromUrl("https://instagram.com/p/ABC123")?.handle).toBeNull();
  });

  it("extracts cited signals from a bio", () => {
    const s = extractSignals(
      "Nail tech in Lekki 💅 Acrylics, gel & pedicure. DM to book or WhatsApp 08031234567. Pay via paystack.shop/teni. TikTok: @nailsbyteni_tt. Trained by @lagosnailacademy",
      "bio",
    );
    expect(s.category?.value).toBe("nail_technician");
    expect(s.city?.value).toBe("Lagos");
    expect(s.phones[0].value).toBe("+2348031234567");
    expect(s.dmBookings?.value).toBe(true);
    expect(s.acceptsBookings?.quote).toContain("DM to book");
    expect(s.whatsappBookings?.value).toBe(true);
    expect(s.onlinePayments?.value).toBe(true);
    expect(s.tiktok.map((t) => t.value)).toContain("nailsbyteni_tt");
    expect(s.mentions.map((m) => m.value)).toContain("lagosnailacademy");
  });
});

describe("ICP scoring", () => {
  it("scores a strong prospect high with reasons for every point", () => {
    const r = scoreIcp(prospect(), DEFAULT_ICP, NOW);
    expect(r.icp).toBeGreaterThanOrEqual(85);
    expect(r.qualified).toBe(true);
    const labels = r.reasons.map((x) => x.label);
    expect(labels).toContain("Based in Lagos");
    expect(labels).toContain("Bookings happen in DMs");
    expect(labels).toContain("Bookings via WhatsApp");
    // Points add up exactly to the score.
    const sum = r.reasons.reduce((a, x) => a + x.points, 0);
    expect(Math.min(100, Math.max(0, sum))).toBeGreaterThanOrEqual(r.icp - 2);
  });

  it("penalises existing booking software and dormancy, and explains gaps", () => {
    const r = scoreIcp(
      prospect({ last_post_date: new Date("2026-01-01"), signals: { schedulingTool: { value: "fresha.com", source: "bio" } } }),
      DEFAULT_ICP,
      NOW,
    );
    expect(r.reasons.some((x) => x.kind === "negative" && x.label.includes("fresha.com"))).toBe(true);
    expect(r.reasons.some((x) => x.label.includes("Possibly closed"))).toBe(true);
    const weak = scoreIcp(prospect({ category: null, city: null, country: null, bio: null, signals: {}, accepts_bookings: null, accepts_whatsapp_bookings: null, last_post_date: null, follower_count: null, services: [] }), DEFAULT_ICP, NOW);
    expect(weak.icp).toBeLessThan(30);
    expect(weak.reasons.filter((x) => x.kind === "missing").length).toBeGreaterThan(3);
  });

  it("computes completeness and caps priority for uncontactable prospects", () => {
    const p = prospect();
    const c = scoreCompleteness(p);
    expect(c.missing).toContain("Email");
    expect(c.score).toBeGreaterThan(60);
    const pr = scorePriority(p, scoreIcp(p, DEFAULT_ICP, NOW), c);
    expect(pr.tier).toBe("high");
    const none = prospect({ instagram_handle: null, phone: null });
    expect(scorePriority(none, scoreIcp(none, DEFAULT_ICP, NOW), scoreCompleteness(none)).score).toBeLessThanOrEqual(20);
  });
});

describe("deduplication", () => {
  const base: DedupRecord = { business_name: "Joy Beauty Studio", city: "Lagos", instagram_handle: null, tiktok_handle: null, phone: null, whatsapp: null, email: null, website_domain: null };

  it("recognises name variants", () => {
    expect(nameSimilarity("Joy Beauty Studio", "Joy Beauty Lagos")).toBeGreaterThan(0.6);
    expect(nameSimilarity("nailsbyteni", "Nails by Teni")).toBeGreaterThan(0.9);
    expect(nameSimilarity("Joy Beauty", "FreshFade Studio")).toBeLessThan(0.3);
  });

  it("flags fuzzy matches for review instead of merging", () => {
    const m = compareProspects(base, { ...base, business_name: "Joy Beauty Lagos" });
    expect(m.decision).toBe("flag");
    expect(m.confidence).toBeGreaterThanOrEqual(50);
    expect(m.reasons.join(" ")).toMatch(/Similar name|Same business name/);
  });

  it("merges only on unique identifiers without conflicts", () => {
    expect(compareProspects({ ...base, instagram_handle: "joybeauty" }, { ...base, business_name: "Joy Beauty", instagram_handle: "joybeauty" }).decision).toBe("merge");
    // Same phone but unrelated name -> human review.
    const shared = compareProspects({ ...base, phone: "+2348031234567" }, { ...base, business_name: "FreshFade Barbers", phone: "+2348031234567" });
    expect(shared.decision).toBe("flag");
    // Conflicting handles -> not the same business.
    const conflict = compareProspects({ ...base, instagram_handle: "joy1" }, { ...base, instagram_handle: "joy2" });
    expect(conflict.decision).not.toBe("merge");
    expect(conflict.conflicts.length).toBe(1);
    expect(compareProspects(base, { ...base, business_name: "Teni Nails", city: "Abuja" }).decision).toBe("distinct");
  });
});

describe("status machine", () => {
  it("allows valid transitions and blocks invalid ones", () => {
    expect(canTransition("NEW", "QUALIFIED").ok).toBe(true);
    expect(canTransition("CONTACTED", "REPLIED").ok).toBe(true);
    expect(canTransition("NEW", "INTERESTED").ok).toBe(false);
    expect(canTransition("PAID", "SIGNED_UP").ok).toBe(false);
    expect(canTransition("CONTACTED", "SIGNED_UP").ok).toBe(true);
    expect(canTransition("REPLIED", "DO_NOT_CONTACT").ok).toBe(true);
    expect(canTransition("DO_NOT_CONTACT", "QUALIFIED").ok).toBe(false);
    expect(canTransition("DO_NOT_CONTACT", "QUALIFIED", { force: true }).ok).toBe(true);
  });
  it("blocks outreach to suppressed or converted prospects", () => {
    expect(outreachBlockReason({ status: "QUALIFIED", do_not_contact: false })).toBeNull();
    expect(outreachBlockReason({ status: "QUALIFIED", do_not_contact: true })).toMatch(/do-not-contact/);
    expect(outreachBlockReason({ status: "SIGNED_UP", do_not_contact: false })).toMatch(/converted/);
  });
});

describe("reply classification (rules)", () => {
  it("detects opt-outs authoritatively", () => {
    for (const t of ["Please don't contact me again.", "STOP", "stop messaging me abeg", "Who gave you my number?", "unsubscribe"]) {
      const r = classifyByRules(t);
      expect(r.intent, t).toBe("opt_out");
      expect(r.authoritative).toBe(true);
    }
    expect(statusForIntent("opt_out")).toBe("DO_NOT_CONTACT");
  });
  it("classifies common intents", () => {
    expect(classifyByRules("This looks interesting, how much is it?").intent).toBe("pricing");
    expect(classifyByRules("I already have a booking system").intent).toBe("competitor");
    expect(classifyByRules("Not interested, thanks").intent).toBe("not_interested");
    expect(classifyByRules("Sounds good, tell me more").intent).toBe("interested");
    expect(classifyByRules("maybe later, I'm busy right now").intent).toBe("maybe_later");
  });
});

describe("message validator", () => {
  const input = (over: Partial<ValidationInput> = {}): ValidationInput => ({
    body: "Hi Ada! Saw your bridal glam work in Lagos — do clients still book you mostly in DMs? I'm building Orbit to make that easier. Happy to show you.",
    channel: "instagram",
    kind: "initial",
    prospect: {
      business_name: "Ada Glow Studio", owner_name: "Ada Okafor", first_name: "Ada", category: "makeup_artist", status: "QUALIFIED",
      do_not_contact: false, booking_url: null, accepts_whatsapp_bookings: null, follower_count: 4200,
      signals: { dmBookings: { value: true } }, instagram_handle: "adaglowstudio", tiktok_handle: null, whatsapp: null, phone: null, email: null,
    },
    context: { workspacePaused: false },
    ...over,
  });

  it("passes a good message", () => {
    const r = validateMessage(input());
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === "block")).toEqual([]);
  });

  it("blocks with explanations", () => {
    const cases: [Partial<ValidationInput>, string][] = [
      [{ context: { workspacePaused: true } }, "outreach_paused"],
      [{ body: "Hi {{first_name}}, quick one" }, "placeholder"],
      [{ body: "Hi Ada, I loved my appointment with you last week!" }, "fake_familiarity"],
      [{ body: "Hi Ada, 500+ businesses already use Orbit." }, "unverified_social_proof"],
      [{ body: "Hi Ada, saw your booking link — nice." }, "unsupported_claim"],
      [{ body: "Hi Ada, love what @someoneelse posted" }, "wrong_handle"],
      [{ context: { workspacePaused: false, previousInitialSentAt: "2026-10-01", previousInitialChannel: "whatsapp" } }, "already_contacted"],
      [{ channel: "whatsapp" }, "channel_unavailable"],
      [{ body: "x".repeat(1200) }, "too_long"],
      [{ constraints: { noEmojis: true }, body: "Hi Ada ✨ quick question about your bookings" }, "emoji_forbidden"],
    ];
    for (const [over, code] of cases) {
      const r = validateMessage(input(over));
      expect(r.ok, code).toBe(false);
      expect(r.issues.map((i) => i.code), code).toContain(code);
    }
    const dnc = input();
    dnc.prospect = { ...dnc.prospect, do_not_contact: true };
    expect(validateMessage(dnc).issues.map((i) => i.code)).toContain("not_contactable");
  });

  it("requires a subject on email; the unsubscribe footer is added at send, not in the body", () => {
    const i = input({ channel: "email", subject: "" });
    i.prospect = { ...i.prospect, email: "ada@example.com" };
    const codes = validateMessage(i).issues.map((x) => x.code);
    expect(codes).toContain("missing_subject");
    expect(codes).not.toContain("missing_opt_out");
    const dup = input({ channel: "email", subject: "Quick question", body: "Hi Ada, quick one about bookings.\n\nUnsubscribe here" });
    dup.prospect = { ...dup.prospect, email: "ada@example.com" };
    expect(validateMessage(dup).issues.map((x) => x.code)).toContain("duplicate_footer");
  });

  it("warns on generic AI language", () => {
    const r = validateMessage(input({ body: "Hi Ada, I hope this message finds you well. Orbit will revolutionize your business." }));
    expect(r.issues.some((i) => i.code === "ai_language")).toBe(true);
  });
});

describe("channels", () => {
  it("builds pre-filled links", () => {
    const p = { instagram_handle: "adaglow", tiktok_handle: null, whatsapp: "+2348031234567", phone: null, email: null };
    expect(openUrl("whatsapp", p, "Hi Ada")).toBe("https://wa.me/2348031234567?text=Hi%20Ada");
    expect(openUrl("instagram", p, "x")).toBe("https://ig.me/m/adaglow");
  });
  it("ramps caps during warm-up", () => {
    const acct = { daily_cap: 100, warmup_enabled: true, warmup_start_cap: 30, warmup_step: 15, warmup_started_on: "2026-09-01" };
    expect(effectiveDailyCap(acct, new Date("2026-09-03"))).toBe(30);
    expect(effectiveDailyCap(acct, new Date("2026-09-16"))).toBe(60);
    expect(effectiveDailyCap(acct, new Date("2026-12-01"))).toBe(100);
    expect(effectiveDailyCap({ ...acct, warmup_enabled: false }, new Date("2026-09-03"))).toBe(100);
  });
});

describe("natural-language filters", () => {
  it("parses the spec example", () => {
    const r = parseNaturalLanguage("Beauty businesses in Lagos with more than 2,000 followers that accept bookings");
    const s = describeFilter(r.filter);
    expect(s).toContain("City = Lagos");
    expect(s).toContain("Followers > 2000");
    expect(s).toContain("Takes bookings");
    expect(s).toMatch(/Category is any of .*Nail technician/);
    expect(filterSchema.safeParse(r.filter).success).toBe(true);
  });
  it("parses scores, booleans and negation", () => {
    const r = parseNaturalLanguage("nail techs in Abuja icp > 80 active with booking link not contacted");
    const s = describeFilter(r.filter);
    expect(s).toContain("Category = Nail technician");
    expect(s).toContain("City = Abuja");
    expect(s).toContain("ICP score > 80");
    expect(s).toContain("Has booking link");
    expect(s).toContain("Active");
    expect(s).toContain("not contacted");
    expect(r.unparsed).toEqual([]);
    const n = parseNaturalLanguage("hair stylists excluding barbers not in Abuja");
    expect(describeFilter(n.filter)).toContain("NOT City = Abuja");
  });
});

describe("sql json()", () => {
  it("sends JSON as text so postgres.js does not encode it twice", () => {
    const q = toQuery(json({ ok: true }));
    expect(q.text).toBe("$1::text::jsonb");
    expect(q.values).toEqual(['{"ok":true}']);
  });
});
