import { sql, json, withWorkspace } from "../db";

/**
 * Rate-limit-aware fetch for external integrations: serialised per key with a
 * minimum interval, exponential backoff on 429/5xx (honouring Retry-After),
 * timeouts, and an integration log row per call. Never hammers an API.
 */

const lastCall = new Map<string, number>();
const chains = new Map<string, Promise<unknown>>();

export class IntegrationError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = "IntegrationError";
  }
}

export interface FetchOpts {
  workspaceId: string;
  integration: string;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Redact secrets from logged URLs. */
  redact?: (url: string) => string;
}

export async function integrationFetch(url: string, init: RequestInit, o: FetchOpts): Promise<Response> {
  // Serialise calls per integration so concurrent jobs can't burst.
  const prev = chains.get(o.integration) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  chains.set(o.integration, prev.then(() => mine));
  await prev;
  try {
    return await doFetch(url, init, o);
  } finally {
    release();
  }
}

async function doFetch(url: string, init: RequestInit, o: FetchOpts): Promise<Response> {
  const maxRetries = o.maxRetries ?? 3;
  const logUrl = (o.redact ?? ((u: string) => u.replace(/(access_token|key|token)=[^&]+/gi, "$1=REDACTED")))(url);
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(o.integration) ?? 0) + (o.minIntervalMs ?? 1000) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(o.integration, Date.now());
    const started = Date.now();
    let res: Response | null = null;
    let error: string | null = null;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const status = res?.status ?? null;
    const retryable = error !== null || status === 429 || (status !== null && status >= 500);
    await logCall(o, retryable && attempt < maxRetries ? "warn" : res?.ok ? "info" : "error", `${init.method ?? "GET"} ${logUrl.slice(0, 300)} → ${status ?? error}`, status, Date.now() - started);
    if (res?.ok) return res;
    if (!retryable || attempt >= maxRetries) {
      const body = res ? await res.text().catch(() => "") : "";
      throw new IntegrationError(`${o.integration}: ${status ?? error} ${body.slice(0, 300)}`, status, retryable);
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt + Math.random() * 500));
  }
}

async function logCall(o: FetchOpts, level: "info" | "warn" | "error", message: string, status: number | null, ms: number) {
  try {
    await withWorkspace({ workspaceId: o.workspaceId }, async (q) => {
      await q.exec(sql`insert into integration_logs (workspace_id, integration_key, level, message, response_status, duration_ms)
                       values (${o.workspaceId}, ${o.integration}, ${level}, ${message}, ${status}, ${ms})`);
      if (level === "info") await q.exec(sql`update integrations set last_success_at = now(), status = case when status = 'error' then 'connected' else status end where key = ${o.integration}`);
      if (level === "error") await q.exec(sql`update integrations set last_error = ${message.slice(0, 500)}, last_error_at = now() where key = ${o.integration}`);
    });
  } catch {
    /* logging is best-effort */
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export { json };
