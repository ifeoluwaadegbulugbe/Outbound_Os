import { z } from "zod";
import type { Q } from "../../db";
import { runTask, type TaskResult, type AiLogTarget } from "../run";
import { buildFacts, factsBlock, type FactProspect, type FactSheet } from "../facts";
import { categoryLabel, MESSAGE_ANGLES, VALUE_PROPS } from "../../domain/taxonomy";
import { recommendAngle, valuePropsFor } from "../../services/scoring-service";

const ANGLE_KEYS = MESSAGE_ANGLES.map((a) => a.key) as [string, ...string[]];
const VP_KEYS = Object.keys(VALUE_PROPS) as [string, ...string[]];

export const researchOutput = z.object({
  summary: z.string().min(20).max(700),
  statements: z
    .array(z.object({ text: z.string().min(3).max(240), kind: z.enum(["fact", "inference"]), basis: z.array(z.string()).max(6) }))
    .min(1)
    .max(10),
  why_relevant: z.array(z.string().min(3).max(160)).min(1).max(5),
  recommended_angle: z.enum(ANGLE_KEYS),
  value_props: z.array(z.enum(VP_KEYS)).min(1).max(3),
  confidence: z.number().int().min(0).max(100),
});
export type ResearchOutput = z.infer<typeof researchOutput>;

interface ResearchInput {
  sheet: FactSheet;
  prospect: FactProspect & { accepts_bookings?: boolean | null; accepts_whatsapp_bookings?: boolean | null; has_booking_link?: boolean | null };
  productName: string;
}

const SYSTEM = `You write short, accurate research briefs about small service businesses for a sales team selling a business-management app.

Hard rules:
- Use ONLY the KNOWN FACTS provided. Every statement of kind "fact" must cite the fact ids it relies on in "basis".
- Anything you conclude that is not directly stated is kind "inference" and must still cite the facts it is inferred from.
- Never state anything from the UNKNOWN list as fact. Do not invent numbers, names, services, prices, locations or tools.
- The summary must only contain claims supported by the statements. Plain, neutral English. No hype.
- confidence (0-100) reflects how much evidence there is, not how good a prospect it is.`;

export async function generateResearch(q: AiLogTarget, workspaceId: string, prospect: ResearchInput["prospect"], productName: string): Promise<TaskResult<ResearchOutput> & { sheet: FactSheet }> {
  const sheet = buildFacts(prospect);
  const ids = new Set(sheet.facts.map((f) => f.id));
  const allFactText = sheet.facts.map((f) => f.text).join(" ").toLowerCase();
  const res = await runTask(q, workspaceId, {
    task: "research",
    input: { sheet, prospect, productName },
    output: researchOutput,
    system: SYSTEM,
    maxTokens: 900,
    temperature: 0.2,
    buildPrompt: (i) => `${factsBlock(i.sheet)}

The app is ${i.productName}. It helps service businesses: ${Object.values(VALUE_PROPS).map((v) => v.short).join("; ")}.

Return JSON with: summary (2-3 sentences), statements, why_relevant (why ${i.productName} could help, each grounded in facts), recommended_angle (one of ${ANGLE_KEYS.join(", ")}), value_props (most relevant of ${VP_KEYS.join(", ")}), confidence.`,
    validate: (o) => {
      for (const s of o.statements) {
        if (s.basis.length === 0) return `Statement "${s.text}" has no basis — cite fact ids.`;
        const bad = s.basis.find((b) => !ids.has(b));
        if (bad) return `Statement "${s.text}" cites unknown fact id ${bad}. Only use: ${[...ids].join(", ")}.`;
      }
      // Numbers in the summary must appear in the facts (blocks invented stats).
      for (const n of o.summary.match(/\d[\d,.]*/g) ?? []) {
        if (!allFactText.includes(n.replace(/[.,]$/, "").toLowerCase())) return `Summary mentions "${n}", which is not in the facts.`;
      }
      return null;
    },
    fallback: (i) => ruleBrief(i),
  });
  return { ...res, sheet };
}

/** Deterministic brief built purely from facts — used without AI. */
export function ruleBrief(i: ResearchInput): ResearchOutput {
  const { sheet, prospect: p, productName } = i;
  const f = (prefix: string) => sheet.facts.find((x) => x.text.startsWith(prefix));
  const statements: ResearchOutput["statements"] = [];
  const cat = f("Category:");
  const loc = f("Located in");
  const ig = f("Instagram:");
  const posted = f("Last posted");
  const freq = f("Posts about");
  const dm = f("Asks clients to book via DM");
  const wa = f("Takes bookings or enquiries on WhatsApp");
  const book = f("Takes bookings/appointments");
  const pay = f("Asks for deposits");
  const tool = f("Already uses a booking tool");
  const link = f("Has a booking link");
  if (cat) statements.push({ text: cat.text, kind: "fact", basis: [cat.id] });
  if (loc) statements.push({ text: loc.text, kind: "fact", basis: [loc.id] });
  if (ig) statements.push({ text: ig.text, kind: "fact", basis: [ig.id] });
  if (posted) statements.push({ text: posted.text, kind: "fact", basis: [posted.id] });
  if (dm) statements.push({ text: dm.text, kind: "fact", basis: [dm.id] });
  if (wa) statements.push({ text: wa.text, kind: "fact", basis: [wa.id] });
  if (dm || wa) statements.push({ text: "Likely manages bookings manually through messages", kind: "inference", basis: [dm?.id, wa?.id].filter(Boolean) as string[] });
  if (pay) statements.push({ text: "Collects deposits manually (transfers)", kind: "fact", basis: [pay.id] });
  if (tool) statements.push({ text: tool.text, kind: "fact", basis: [tool.id] });
  if (posted && freq) statements.push({ text: "Actively posting and acquiring clients", kind: "inference", basis: [posted.id, freq.id] });
  if (statements.length === 0) statements.push({ text: `Business name: ${p.business_name}`, kind: "fact", basis: ["f1"] });

  const why: string[] = [];
  if (book || dm || wa) why.push("Takes appointments");
  if ((p.services?.length ?? 0) >= 2) why.push("Offers multiple service types");
  if (dm || wa) why.push("Booking workflow looks manual (DMs/WhatsApp)");
  if (pay) why.push("Handles payments by hand");
  if (posted && freq) why.push("Active customer acquisition on social media");
  if (tool) why.push(`Already uses ${tool.text.split(": ")[1]} — pitch what ${productName} adds beyond bookings`);
  if (link && !tool) why.push("Has a booking link — likely values organised bookings");
  if (why.length === 0) why.push("Appointment-based service business");

  const parts = [
    `${p.business_name} is ${withArticle(`${p.city ? `${p.city}-based ` : ""}${p.category ? categoryLabel(p.category).toLowerCase() : "service business"}`)}${ig && p.follower_count != null ? ` with an Instagram presence` : ""}.`,
    posted ? `${posted.text.replace("Last posted", "They last posted")}${freq ? ` and post about ${Math.round(p.posting_frequency ?? 0)} times a week` : ""}.` : "",
    dm || wa ? `Their bio asks clients to book ${dm && wa ? "via DM or WhatsApp" : dm ? "via DM" : "on WhatsApp"}, which suggests bookings are handled manually (AI inference).` : "",
  ].filter(Boolean);

  const evidence = sheet.facts.length;
  return {
    summary: parts.join(" "),
    statements: statements.slice(0, 10),
    why_relevant: why.slice(0, 5),
    recommended_angle: recommendAngle({ ...(p as unknown as Record<string, unknown>), signals: p.signals } as never),
    value_props: valuePropsFor(p.category).slice(0, 2) as ResearchOutput["value_props"],
    confidence: Math.min(95, 30 + evidence * 6),
  };
}

function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}
