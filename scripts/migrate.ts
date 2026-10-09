import "./_env";
import { createDriver } from "@/server/db/driver";
import { runMigrations } from "@/server/db/migrate";

const d = await createDriver();
const ran = await runMigrations(d);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
await d.close();
