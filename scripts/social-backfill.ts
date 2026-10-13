import "./_env";
import { withSystem, withWorkspace, sql } from "@/server/db";
import { findLinkedProfiles } from "@/server/email/finder";

/**
 * Read the homepage of business websites (checked for emails already or not
 * yet) and keep the Instagram/TikTok profiles each site links to. Faster than
 * the full email crawl, which also captures them from now on.
 *
 *   npm run social:backfill -- [--countries NG] [--limit 5000] [--concurrency 8]
 */
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const countries = (arg("--countries") ?? "NG").split(",").map((c) => c.trim().toUpperCase());
const limit = Number(arg("--limit") ?? 50_000);
const concurrency = Number(arg("--concurrency") ?? 8);

// A website dropping its connection mid-read surfaces as a stray socket error; it must not stop the run.
process.on("uncaughtException", (e) => console.error(`ignored: ${e instanceof Error ? e.message : e}`));
process.on("unhandledRejection", (e) => console.error(`ignored: ${e instanceof Error ? e.message : e}`));

async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * i));
    }
  }
}

const workspaces = await withSystem((q) => q.many<{ id: string }>(sql`select id from workspaces`));
for (const w of workspaces) {
  const run = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) => withWorkspace({ workspaceId: w.id }, fn);
  const rows = await run((q) => q.many<{ id: string; website: string }>(sql`
    select id, website from prospects
    where merged_into is null and archived_at is null and not is_demo and website is not null and instagram_handle is null
      and (website_crawl_status is null or website_crawl_status in ('pending', 'ok', 'no_email')) and country = any(${`{${countries.join(",")}}`}::text[])
    order by priority_score desc nulls last limit ${limit}`));
  console.log(`${rows.length} business websites to read (${countries.join(", ")})`);
  let done = 0, ig = 0, tt = 0;
  const queue = [...rows];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const f = await findLinkedProfiles(r.website);
      if (f.instagram || f.tiktok) {
        await retry(() => run((q) => q.exec(sql`update prospects set instagram_handle = coalesce(instagram_handle, ${f.instagram}), tiktok_handle = coalesce(tiktok_handle, ${f.tiktok}) where id = ${r!.id}`)));
        if (f.instagram) ig++;
        if (f.tiktok) tt++;
      }
      if (++done % 100 === 0) console.log(`${done}/${rows.length} read · ${ig} Instagram · ${tt} TikTok`);
    }
  }));
  console.log(`done: ${done} read · ${ig} Instagram profiles · ${tt} TikTok profiles`);
}
process.exit(0);
