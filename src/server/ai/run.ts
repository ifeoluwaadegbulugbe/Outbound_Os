import { z } from "zod";
import { sql, type Q } from "../db";
import { configuredProviders, ProviderError, type AiProvider } from "./providers";

/**
 * Runs one AI task with: input/output schemas, validation, retry with the
 * validation error fed back, a per-process concurrency limit, logging to
 * ai_runs, and a deterministic fallback. The caller always gets a result
 * plus an honest label of where it came from.
 */

export interface TaskSpec<I, O> {
  task: string;
  input: I;
  output: z.ZodType<O>;
  system: string;
  buildPrompt: (input: I) => string;
  /** Extra semantic checks (e.g. "statement cites unknown fact"). Return an error string or null. */
  validate?: (output: O, input: I) => string | null;
  /** Deterministic result when AI is unavailable or fails. */
  fallback: (input: I) => O;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface TaskResult<O> {
  output: O;
  source: string;        // "ai:groq/llama-3.3-70b-versatile" | "rules"
  usedFallback: boolean;
  error?: string;
}

const MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENCY ?? 3);
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}

/** Providers on cooldown after rate limits / repeated failures (in-memory). */
const cooldownUntil = new Map<string, number>();

function strictSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Where to record ai_runs: an open transaction, or a function that opens one. */
export type AiLogTarget = Q | { ws: <T>(fn: (q: Q) => Promise<T>) => Promise<T> } | null;

async function log(target: AiLogTarget, workspaceId: string, row: { task: string; provider: string; model: string | null; status: string; attempts: number; latency: number; inTok?: number; outTok?: number; error?: string }) {
  if (!target) return;
  const write = (q: Q) => q.exec(sql`insert into ai_runs (workspace_id, task, provider, model, status, attempts, latency_ms, input_tokens, output_tokens, error)
      values (${workspaceId}, ${row.task}, ${row.provider}, ${row.model}, ${row.status}, ${row.attempts}, ${row.latency}, ${row.inTok ?? null}, ${row.outTok ?? null}, ${row.error?.slice(0, 500) ?? null})`);
  try {
    if ("ws" in target) await target.ws(write);
    else await write(target);
  } catch {
    /* logging must never break the task */
  }
}

export async function runTask<I, O>(q: AiLogTarget, workspaceId: string, spec: TaskSpec<I, O>, opts: { disableAi?: boolean } = {}): Promise<TaskResult<O>> {
  const providers = opts.disableAi || process.env.AI_DISABLED === "true" ? [] : configuredProviders().filter((p) => (cooldownUntil.get(p.name) ?? 0) < Date.now());
  const schema = strictSchema(spec.output);
  const errors: string[] = [];

  for (const provider of providers) {
    const r = await attempt(q, workspaceId, provider, spec, schema);
    if (r.ok) return { output: r.output, source: `ai:${provider.name}/${provider.model}`, usedFallback: false };
    errors.push(`${provider.name}: ${r.error}`);
  }

  const output = spec.fallback(spec.input);
  await log(q, workspaceId, { task: spec.task, provider: "rules", model: null, status: "fallback", attempts: 0, latency: 0, error: errors.join(" | ") || undefined });
  return { output, source: "rules", usedFallback: true, error: errors.length ? errors.join(" | ") : undefined };
}

async function attempt<I, O>(q: AiLogTarget, workspaceId: string, provider: AiProvider, spec: TaskSpec<I, O>, schema: Record<string, unknown>): Promise<{ ok: true; output: O } | { ok: false; error: string }> {
  let userPrompt = spec.buildPrompt(spec.input);
  const started = Date.now();
  let lastError = "";
  for (let i = 1; i <= 2; i++) {
    await acquire();
    try {
      const res = await provider.generateJson({
        system: spec.system,
        user: userPrompt,
        schema,
        maxTokens: spec.maxTokens ?? 800,
        temperature: spec.temperature,
        signal: AbortSignal.timeout(spec.timeoutMs ?? 30_000),
      });
      const parsed = spec.output.safeParse(res.json);
      if (!parsed.success) {
        lastError = `Invalid output: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`;
      } else {
        const semantic = spec.validate?.(parsed.data, spec.input) ?? null;
        if (!semantic) {
          await log(q, workspaceId, { task: spec.task, provider: provider.name, model: provider.model, status: "ok", attempts: i, latency: Date.now() - started, inTok: res.inputTokens, outTok: res.outputTokens });
          return { ok: true, output: parsed.data };
        }
        lastError = semantic;
      }
      // Retry once with the problem stated explicitly.
      userPrompt = `${spec.buildPrompt(spec.input)}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON only.`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof ProviderError && e.status === 429) cooldownUntil.set(provider.name, Date.now() + 60_000);
      if (e instanceof ProviderError && !e.retryable) break;
      if (e instanceof Error && e.name === "TimeoutError") break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    } finally {
      release();
    }
  }
  await log(q, workspaceId, { task: spec.task, provider: provider.name, model: provider.model, status: lastError.startsWith("Invalid output") ? "invalid_output" : "error", attempts: 2, latency: Date.now() - started, error: lastError });
  return { ok: false, error: lastError };
}

/** Short label for UI badges: "AI · groq" / "Template". */
export function sourceLabel(source: string): string {
  if (source.startsWith("ai:")) return `AI · ${source.slice(3).split("/")[0]}`;
  if (source === "rules") return "Rules";
  if (source === "template") return "Template";
  return source;
}
