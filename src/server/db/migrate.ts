import fs from "node:fs";
import path from "node:path";
import type { Driver } from "./driver";

/**
 * Forward-only SQL migrations from db/migrations/NNN_name.sql, applied in
 * order and recorded in outbound.schema_migrations. Each file runs in its own
 * transaction-equivalent script.
 */
export async function runMigrations(driver: Driver, dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "db", "migrations")): Promise<string[]> {
  await driver.execScript(`
    create schema if not exists outbound;
    create table if not exists outbound.schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const applied = new Set(
    (await driver.query<{ id: string }>("select id from outbound.schema_migrations")).map((r) => r.id),
  );
  const files = fs
    .readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, file), "utf8");
    // Wrap in a transaction so a failing migration leaves no partial state.
    try {
      await driver.execScript(
        `begin;\n${text}\ninsert into outbound.schema_migrations (id) values ('${file.replace(/'/g, "")}');\ncommit;`,
      );
    } catch (err) {
      await driver.execScript("rollback;").catch(() => {});
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ran.push(file);
  }
  return ran;
}
