import "./_env";
import fs from "node:fs";
import path from "node:path";
import { pgliteDir } from "@/server/db/paths";

/** Delete the local embedded database (development only). */
if (process.env.DATABASE_URL) throw new Error("db:reset only works on the embedded dev database. Refusing to touch DATABASE_URL.");
const dir = pgliteDir();
const lock = path.join(dir, "..", "pglite.lock");
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  let alive = false;
  try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
  if (alive) throw new Error(`Database in use by pid ${pid} (dev server?). Stop it first.`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Embedded database removed (${dir}). It will be recreated on next start.`);
