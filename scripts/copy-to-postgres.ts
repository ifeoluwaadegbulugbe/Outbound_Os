import "./_env";
import postgres from "postgres";
import { createDriver } from "@/server/db/driver";
import { runMigrations } from "@/server/db/migrate";
import { pgliteDir } from "@/server/db/paths";

/**
 * One-time copy of the local embedded database (~/.outbound-os) into a hosted
 * Postgres (Neon / Supabase), e.g. before deploying to Vercel.
 *
 *   TARGET_DATABASE_URL=postgres://… npm run db:copy            (copies everything)
 *   TARGET_DATABASE_URL=postgres://… npm run db:copy -- --dry   (counts only)
 *
 * Runs the migrations on the target first, then copies every table in
 * foreign-key order, keeping ids. Refuses to write into a target that already
 * has data. Stop `npm run dev` first (the local database is single-process).
 */

const target = process.env.TARGET_DATABASE_URL;
if (!target) {
  console.error("Set TARGET_DATABASE_URL to the hosted Postgres connection string (direct connection, not the pooler).");
  process.exit(1);
}
const dry = process.argv.includes("--dry");

const src = await createDriver({ databaseUrl: "", pgliteDir: pgliteDir() });
const dstDriver = await createDriver({ databaseUrl: target });
console.log("[copy] applying migrations to the target…");
const applied = await runMigrations(dstDriver);
console.log(`[copy] migrations applied: ${applied.length ? applied.join(", ") : "none needed"}`);
await dstDriver.close();

const dst = postgres(target, { max: 1, prepare: !target.includes(":6543"), onnotice: () => {} });
// Bypass row-level security for the copy (policies allow app.system = on).
await dst`select set_config('app.system', 'on', false)`;
await dst`set search_path to outbound, public`;

type Row = Record<string, unknown>;
const tables = (await src.query<{ table_name: string }>(
  "select table_name from information_schema.tables where table_schema = 'outbound' and table_type = 'BASE TABLE' and table_name <> 'schema_migrations'",
)).map((r) => r.table_name);

// Foreign-key order: parents before children.
const fks = await src.query<{ child: string; parent: string }>(`
  select tc.table_name as child, ccu.table_name as parent from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'outbound' and ccu.table_name <> tc.table_name`);
const order: string[] = [];
const visiting = new Set<string>();
const visit = (t: string) => {
  if (order.includes(t) || visiting.has(t)) return;
  visiting.add(t);
  for (const f of fks.filter((x) => x.child === t)) if (tables.includes(f.parent)) visit(f.parent);
  visiting.delete(t);
  order.push(t);
};
tables.forEach(visit);

const existing = await dst<{ n: number }[]>`select count(*)::int as n from outbound.workspaces`;
if (!dry && existing[0].n > 0) {
  console.error("[copy] the target already has workspaces. Refusing to merge into a database with data; use an empty database.");
  process.exit(1);
}

let total = 0;
for (const t of order) {
  const [{ n }] = await src.query<{ n: number }>(`select count(*)::int as n from outbound."${t}"`);
  if (dry || n === 0) {
    console.log(`[copy] ${t}: ${n} rows${dry ? " (dry run)" : ""}`);
    continue;
  }
  const cols = (await src.query<{ column_name: string; data_type: string; is_generated: string }>(
    `select column_name, data_type, is_generated from information_schema.columns where table_schema = 'outbound' and table_name = $1 order by ordinal_position`, [t],
  )).filter((c) => c.is_generated !== "ALWAYS");
  const names = cols.map((c) => c.column_name);
  const jsonCols = new Set(cols.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name));
  // Postgres allows at most 65,535 bind parameters per statement: size batches by column count.
  const batch = Math.max(1, Math.min(1000, Math.floor(60_000 / names.length)));
  for (let offset = 0; offset < n; offset += batch) {
    const rows = await src.query<Row>(`select ${names.map((c) => `"${c}"`).join(", ")} from outbound."${t}" order by 1 limit ${batch} offset ${offset}`);
    const prepared = rows.map((r) => {
      const o: Row = {};
      for (const c of names) o[c] = jsonCols.has(c) && r[c] != null ? dst.json(r[c] as never) : r[c];
      return o;
    });
    await dst`insert into ${dst(`outbound.${t}`)} ${dst(prepared as never, names)} on conflict do nothing`;
  }
  total += n;
  console.log(`[copy] ${t}: ${n} rows`);
}

// Move id sequences past the copied rows.
const seqs = await dst<{ tbl: string; col: string; seq: string }[]>`
  select c.table_name as tbl, c.column_name as col, pg_get_serial_sequence('outbound.' || c.table_name, c.column_name) as seq
  from information_schema.columns c where c.table_schema = 'outbound' and c.column_default like 'nextval(%'`;
for (const s of seqs) if (s.seq) await dst.unsafe(`select setval('${s.seq}', coalesce((select max("${s.col}") from outbound."${s.tbl}"), 0) + 1, false)`);

console.log(dry ? "[copy] dry run finished." : `[copy] done: ${total.toLocaleString()} rows copied into the hosted database.`);
await dst.end();
await src.close();
process.exit(0);
