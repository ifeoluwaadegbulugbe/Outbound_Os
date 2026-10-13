import "./_env";
import { withSystem, sql } from "@/server/db";
import { runInstagramEnrichTick, instagramConnected } from "@/server/collection/instagram-enrich";

/**
 * Read the public business profiles of prospects with an Instagram handle
 * through the official Graph API (Business Discovery), at the connected
 * account's hourly quota. Keeps emails, websites and TikTok handles the owner
 * published in the bio. Stops on Meta's rate limit; run again to continue.
 *
 *   npm run instagram:lookup -- [--countries NG,GH,KE,ZA] [--hours 24]
 */
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const countries = (arg("--countries") ?? "NG,GH,KE,ZA").split(",").map((c) => c.trim().toUpperCase());
const deadline = Date.now() + Number(arg("--hours") ?? 24) * 3_600_000;

const workspaces = await withSystem((q) => q.many<{ id: string }>(sql`select id from workspaces`));
for (const w of workspaces) {
  if (!(await instagramConnected(w.id))) { console.log("Instagram isn't connected (Integrations → Instagram)."); continue; }
  const total = { checked: 0, emails: 0, websites: 0, tiktoks: 0 };
  while (Date.now() < deadline) {
    const r = await runInstagramEnrichTick(w.id, { budgetMs: Math.min(30 * 60_000, deadline - Date.now()), countries, log: (m) => console.log(m) })
      .catch((e) => { console.error(`lookup error: ${e instanceof Error ? e.message : e}`); return null; });
    if (!r) { await new Promise((res) => setTimeout(res, 60_000)); continue; }
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
    console.log(`total: ${total.checked} profiles · ${total.emails} emails · ${total.websites} websites · ${total.tiktoks} TikTok`);
    if (r.checked === 0) break; // nothing left, or Meta's rate limit: run again later
  }
}
process.exit(0);
