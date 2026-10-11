import { describe, it, expect } from "vitest";
import { templateMessage, greetingName } from "@/server/domain/templates";
import { validateMessage } from "@/server/domain/validator";
import { verdict, type VariantResult } from "@/server/services/experiments";
import { MESSAGE_ANGLES } from "@/server/domain/taxonomy";

const base: { id: string; first_name: string | null; category: string; city: string; booking_url: string | null; instagram_handle: string } = { id: "11111111-1111-1111-1111-111111111111", first_name: null, category: "nail_technician", city: "Lagos", booking_url: null, instagram_handle: "nailsbyteni" };

describe("message templates", () => {
  it("only uses a first name when it's explicit", () => {
    expect(greetingName({ ...base, business_name: "Nails by Teni", signals: {} })).toBe("Teni");
    expect(greetingName({ ...base, business_name: "Teni's Nail Bar", signals: {} })).toBe("Teni");
    expect(greetingName({ ...base, business_name: "Glossy Tips Lagos", signals: {} })).toBeNull();
    expect(greetingName({ ...base, first_name: "Ada", business_name: "Glow Studio", signals: {} })).toBe("Ada");
  });

  it("every angle produces a message that passes validation", () => {
    for (const a of MESSAGE_ANGLES) {
      const cases: (typeof base & { business_name: string; signals: Record<string, { value: unknown }> })[] = [
        { ...base, business_name: "Nails by Teni", signals: { dmBookings: { value: true } } },
        { ...base, business_name: "Glossy Tips Lagos", signals: {} },
      ];
      for (const p of cases) {
        const m = templateMessage({ prospect: p, angle: a.key, channel: "instagram", kind: "initial", productName: "Orbit", noEmojis: true });
        expect(m.body, `${a.key}`).not.toMatch(/Hi!,|\s,|undefined|null|\{\{/);
        const v = validateMessage({
          body: m.body, channel: "instagram", kind: "initial",
          prospect: { ...p, owner_name: null, status: "QUALIFIED", do_not_contact: false, accepts_whatsapp_bookings: null, follower_count: 1000, tiktok_handle: null, whatsapp: null, phone: null, email: null },
          context: { workspacePaused: false }, constraints: { maxChars: 500, noEmojis: true },
        });
        expect(v.issues.filter((i) => i.severity === "block"), `${a.key}: ${m.body}`).toEqual([]);
        expect(v.issues.map((i) => i.code), `${a.key}: ${m.body}`).not.toContain("not_personalized");
      }
    }
  });

  it("only mentions DMs when the bio says so", () => {
    const withoutSignal = templateMessage({ prospect: { ...base, business_name: "Glossy Tips Lagos", signals: {} }, angle: "problem_first", channel: "instagram", kind: "initial", productName: "Orbit" });
    expect(withoutSignal.body).not.toMatch(/through (your )?DMs|book you through/i);
  });
});

describe("experiment significance", () => {
  const v = (key: string, contacted: number, replied: number): VariantResult => ({ id: key, key, name: key, config: {}, contacted, replied, interested: 0, signed_up: 0, activated: 0, paid: 0 });
  it("waits for enough data", () => {
    expect(verdict([v("A", 20, 5), v("B", 40, 4)], "reply_rate").status).toBe("insufficient");
  });
  it("declares a winner only when significant", () => {
    expect(verdict([v("A", 400, 80), v("B", 400, 40)], "reply_rate")).toMatchObject({ status: "leading", leader: "A" });
    expect(verdict([v("A", 60, 9), v("B", 60, 7)], "reply_rate").status).toBe("no_difference");
  });
});
