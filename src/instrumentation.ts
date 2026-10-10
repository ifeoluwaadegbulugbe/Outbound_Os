/**
 * Starts the in-process background job worker when the Node server boots.
 * Set WORKER_MODE=external when running `npm run worker` (or the cron route)
 * separately — e.g. multiple app instances on a real Postgres database.
 * Never started on Vercel (serverless).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.WORKER_MODE === "external" || process.env.NODE_ENV === "test") return;
  // Serverless (Vercel): no long-running process. Jobs and email dispatch run via GET /api/cron/worker
  // (called every minute by a scheduler); collection runs from a machine with `npm run collect`.
  if (process.env.VERCEL) return;
  const { startInProcessWorker } = await import("./server/jobs/worker");
  startInProcessWorker();
}
