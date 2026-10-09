import { createDriver, type Driver } from "@/server/db/driver";
import { runMigrations } from "@/server/db/migrate";
import { withSystem, sql } from "@/server/db";

/** Fresh in-memory Postgres with all migrations applied. */
export async function testDb(): Promise<Driver> {
  const d = await createDriver({ databaseUrl: "", pgliteDir: "memory://" });
  await runMigrations(d);
  return d;
}

export async function createWorkspace(d: Driver, name = "Test WS"): Promise<string> {
  return withSystem(async (q) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
    return q.value<string>(sql`insert into workspaces (name, slug) values (${name}, ${slug}) returning id`);
  }, d);
}
