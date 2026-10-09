import { sql, json, textArray, type Q } from "../db";
import { generateResearch } from "../ai/tasks/research";
import type { FactProspect } from "../ai/facts";

/** Generate + store an AI research brief (AI call outside any transaction). */
export async function researchProspect(ws: <T>(fn: (q: Q) => Promise<T>) => Promise<T>, workspaceId: string, prospectId: string) {
  const data = await ws(async (q) => {
    const p = await q.maybe<FactProspect>(sql`
      select business_name, owner_name, category, services, city, area, country, bio, description, instagram_handle, tiktok_handle, follower_count,
             last_post_date, posting_frequency, booking_url, website, phone, whatsapp, email, signals
      from prospects where id = ${prospectId}`);
    const product = await q.value<string>(sql`select product_name from workspaces where id = ${workspaceId}`);
    return p ? { p, product } : null;
  });
  if (!data) return null;
  const r = await generateResearch({ ws }, workspaceId, data.p, data.product);
  return ws(async (q) => {
    const id = await q.value<string>(sql`
      insert into prospect_research (workspace_id, prospect_id, summary, statements, why_relevant, recommended_angle, value_props, confidence, generator)
      values (${workspaceId}, ${prospectId}, ${r.output.summary}, ${json({ statements: r.output.statements, facts: r.sheet.facts, unknowns: r.sheet.unknowns })},
              ${json(r.output.why_relevant)}, ${r.output.recommended_angle}, ${textArray(r.output.value_props)}, ${r.output.confidence}, ${r.usedFallback ? "rules" : r.source})
      returning id`);
    await q.exec(sql`update prospects set recommended_message_angle = ${r.output.recommended_angle} where id = ${prospectId}`);
    return id;
  });
}
