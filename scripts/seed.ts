import "./_env";
import { createDriver } from "@/server/db/driver";
import { runMigrations } from "@/server/db/migrate";
import { withSystem, withWorkspace, sql } from "@/server/db";
import { setupFirstOwner } from "@/server/auth/service";
import { loadDemoData } from "@/server/seed/demo";

/**
 * Development seed: creates the owner account (from SEED_OWNER_* in .env.local)
 * if none exists, then loads fictional demo data. Never run against production.
 */
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production.");
const email = process.env.SEED_OWNER_EMAIL;
const password = process.env.SEED_OWNER_PASSWORD;

const d = await createDriver();
await runMigrations(d);
let ws = await withSystem((q) => q.maybe<{ id: string; product_name: string }>(sql`select id, product_name from workspaces order by created_at limit 1`), d);
let userId = await withSystem((q) => q.value<string | null>(sql`select user_id from workspace_members where role = 'owner' order by created_at limit 1`), d);
if (!ws) {
  if (!email || !password) throw new Error("Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD in .env.local (see .env.example).");
  const r = await setupFirstOwner({ workspaceName: "Orbit Growth", productName: "Orbit", name: "Orbit Founder", email, password }, d);
  ws = { id: r.workspaceId, product_name: "Orbit" };
  userId = r.userId;
  console.log(`Created workspace and owner ${email}`);
}
const existing = await withWorkspace({ workspaceId: ws.id }, (q) => q.value<number>(sql`select count(*)::int from prospects where is_demo`), d);
if (existing > 0 && !process.argv.includes("--force")) {
  console.log(`Demo data already present (${existing} prospects). Use --force to add more, or db:reset.`);
} else {
  const t = Date.now();
  const s = await withWorkspace({ workspaceId: ws.id, userId }, (q) => loadDemoData(q, { workspaceId: ws.id, userId, productName: ws.product_name }), d);
  console.log(`Demo data: ${s.prospects} prospects, ${s.contacted} contacted, ${s.replies} replies, ${s.signups} signups (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
await d.close();
