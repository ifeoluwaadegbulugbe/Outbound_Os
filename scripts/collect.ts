import "./_env";
import { withSystem, withWorkspace, sql } from "@/server/db";
import { planCollection, runCollectTick, runCrawlTick, runEmailCheckTick, getCollectionSettings, saveCollectionSettings, backfillNgStates } from "@/server/collection/engine";
import { collectionMetrics } from "@/server/collection/metrics";
import { runInstagramEnrichTick, instagramConnected } from "@/server/collection/instagram-enrich";

/**
 * Long-running collector (discovery + website crawl + email DNS checks).
 *   npm run collect -- --minutes 60 --countries NG,GH,KE --sources overture,osm_country,commoncrawl
 *   npm run collect -- --status
 * Everything it does is persisted, so stopping (Ctrl+C) and starting again
 * resumes where it left off. With the embedded database, stop `npm run dev`
 * first (one process at a time); with DATABASE_URL both can run.
 */

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

const ws = arg("workspace") ?? (await withSystem((q) => q.value<string | null>(sql`select id from workspaces order by created_at limit 1`)));
if (!ws) {
  console.error("No workspace yet. Open the app once (or run npm run db:seed) first.");
  process.exit(1);
}
const run = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) => withWorkspace({ workspaceId: ws }, fn);

async function printStatus() {
  const m = await run((q) => collectionMetrics(q));
  const target = (await run((q) => getCollectionSettings(q, ws!))).target;
  console.log(
    `\n[collect] businesses ${m.businesses.toLocaleString()} (${((m.businesses / target) * 100).toFixed(1)}% of ${target.toLocaleString()}) · ` +
    `with email ${m.withEmail.toLocaleString()} · with website ${m.withWebsite.toLocaleString()} · email addresses ${m.emailAddresses.toLocaleString()}\n` +
    `          emails: mx present ${m.email.domainMxPresent} · deliverability unknown ${m.email.deliverabilityUnknown} · invalid ${m.email.invalid} · not checked ${m.email.notCheckedYet}\n` +
    `          units: ${m.units.done} done · ${m.units.pending} pending · ${m.units.failed} retrying · ${m.units.dead} dead · crawl queue ${m.crawl.pending} (done: ${m.crawl.ok} email, ${m.crawl.noEmail} none, ${m.crawl.deadDomain} dead domain, ${m.crawl.error} error) · duplicates merged ${m.duplicatesRemoved}`,
  );
  for (const s of m.unitYield) console.log(`          ${s.source.padEnd(12)} ${s.done}/${s.units} units · ${s.found} found · ${s.created} new · ${s.merged} dup · ${s.with_email} w/ email`);
  for (const c of m.byCountry.slice(0, 10)) console.log(`          ${c.country}: ${c.businesses} businesses · ${c.with_email} with email`);
  const ng = m.ngStates;
  console.log(`          Nigeria share ${(m.ngShare * 100).toFixed(1)}% · states with businesses ${ng.filter((s) => s.businesses > 0 && s.state !== "(unknown)").length}/37 · top: ${ng.slice(0, 6).map((s) => `${s.state} ${s.businesses}`).join(", ")} · lowest: ${ng.filter((s) => s.state !== "(unknown)").slice(-5).map((s) => `${s.state} ${s.businesses}`).join(", ")}`);
}

if (flag("status")) {
  await printStatus();
  process.exit(0);
}

const countries = (arg("countries") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const sources = (arg("sources") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
await run(async (q) => {
  const cur = await getCollectionSettings(q, ws!);
  const next = await saveCollectionSettings(q, ws!, {
    active: true, paused: false,
    countries: countries.length ? [...new Set([...cur.countries, ...countries])] : cur.countries,
    sources: sources.length ? sources : cur.sources,
    crawl: !flag("no-crawl"),
  });
  const added = await planCollection(q, ws!, countries.length ? countries : next.countries, next.sources);
  console.log(`[collect] planned ${added} new units · countries ${next.countries.join(", ")} · sources ${next.sources.join(", ")}`);
});
if (flag("plan-only")) process.exit(0);
console.log(`[collect] Nigerian states filled from coordinates: ${await backfillNgStates(ws)}`);
// The embedded database is single-process, so anything marked running was interrupted: resume it now.
if (!process.env.DATABASE_URL) await run((q) => q.exec(sql`update collection_units set status = 'pending', locked_at = null where status = 'running'`));

const minutes = Number(arg("minutes") ?? 60);
const deadline = Date.now() + minutes * 60_000;
let stopping = false;
const stop = () => {
  if (!stopping) console.log("\n[collect] stopping after the current step…");
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const alive = () => !stopping && Date.now() < deadline;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const activeSources = (await run((q) => getCollectionSettings(q, ws!))).sources;
// Event-loop watchdog: a gap here means something synchronous (usually a long embedded-DB query) blocked everything.
let lastTick = Date.now();
setInterval(() => {
  const gap = Date.now() - lastTick - 5000;
  if (gap > 10_000) log(`event loop was blocked for ${Math.round(gap / 1000)}s`);
  lastTick = Date.now();
}, 5000).unref();
const igOn = await instagramConnected(ws);
console.log(igOn ? "[collect] Instagram connected: reading business-profile bios for emails (official API)" : "[collect] Instagram not connected: skipping bio-email enrichment (Data Sources → Instagram)");
const loops = [
  (async () => {
    if (!igOn) return;
    const countries = (await run((q) => getCollectionSettings(q, ws!))).countries;
    while (alive()) {
      const r = await runInstagramEnrichTick(ws, { budgetMs: Math.min(120_000, deadline - Date.now()), countries, log }).catch((e) => (log(`instagram error: ${e}`), null));
      if (!r || r.checked === 0) await sleep(60_000);
    }
  })(),
  // One discovery loop per source: Overpass's 15 s spacing never delays Overture or Common Crawl.
  ...activeSources.map((src) => (async () => {
    while (alive()) {
      const r = await runCollectTick(ws, { budgetMs: Math.min(120_000, deadline - Date.now()), log, sources: [src] }).catch((e) => (log(`collect error (${src}): ${e}`), null));
      if (r && r.units === 0) await sleep(15_000);
    }
  })()),
  (async () => {
    if (flag("no-crawl")) return;
    while (alive()) {
      const r = await runCrawlTick(ws, { budgetMs: Math.min(120_000, deadline - Date.now()), concurrency: Number(arg("concurrency") ?? 8), log }).catch((e) => (log(`crawl error: ${e}`), null));
      if (r && r.crawled === 0) await sleep(20_000);
    }
  })(),
  (async () => {
    while (alive()) {
      const n = await runEmailCheckTick(ws, { budgetMs: 60_000 }).catch((e) => (log(`email check error: ${e}`), 0));
      if (n) log(`email check: ${n} addresses DNS-checked`);
      else await sleep(30_000);
    }
  })(),
  (async () => {
    while (alive()) {
      await sleep(60_000);
      if (alive()) await printStatus().catch(() => {});
    }
  })(),
];
await Promise.all(loops);
// Hand any unit we were in the middle of back to the queue.
await run((q) => q.exec(sql`update collection_units set status = 'pending', locked_at = null where status = 'running'`));
await printStatus();
console.log("[collect] stopped. Run the same command again to resume.");
process.exit(0);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))));
}
