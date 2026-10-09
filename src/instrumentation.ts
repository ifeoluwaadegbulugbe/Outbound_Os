/**
 * Starts the in-process background job worker when the Node server boots.
 * Set WORKER_MODE=external when running `npm run worker` (or the cron route)
 * separately — e.g. multiple app instances on a real Postgres database.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.WORKER_MODE === "external" || process.env.NODE_ENV === "test") return;
  const { startInProcessWorker } = await import("./server/jobs/worker");
  startInProcessWorker();
}
