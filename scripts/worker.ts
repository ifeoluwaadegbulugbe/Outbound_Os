import "./_env";
import { drain, scheduleRecurring } from "@/server/jobs/worker";

/**
 * Standalone job worker for production deployments on a real Postgres
 * (set WORKER_MODE=external on the web app). Safe to run several copies.
 * Not for the embedded dev database — the dev server runs its own worker.
 */
if (!process.env.DATABASE_URL) {
  console.error("npm run worker needs DATABASE_URL. In development the dev server already runs an in-process worker.");
  process.exit(1);
}

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

let lastSchedule = 0;
console.log("[worker] started");
while (!stopping) {
  try {
    if (Date.now() - lastSchedule > 5 * 60_000) {
      lastSchedule = Date.now();
      await scheduleRecurring();
    }
    const n = await drain({ maxJobs: 20, timeBudgetMs: 30_000 });
    if (n === 0) await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    console.error("[worker] error", e);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log("[worker] stopped");
process.exit(0);
