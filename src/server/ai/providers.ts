import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM providers behind one interface: given a system prompt, a user prompt and
 * a JSON schema, return parsed JSON. Free options first (Ollama local, Groq and
 * Gemini free tiers); Anthropic optional (paid). Never send prospect data to
 * anonymous public endpoints.
 */

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface JsonResponse {
  json: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProvider {
  name: "ollama" | "groq" | "gemini" | "anthropic";
  model: string;
  generateJson(req: JsonRequest): Promise<JsonResponse>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new ProviderError("Model did not return JSON", true);
  }
}

function httpError(provider: string, status: number, body: string): ProviderError {
  return new ProviderError(`${provider} ${status}: ${body.slice(0, 200)}`, status === 429 || status >= 500, status);
}

// ── Ollama (local, free) ──────────────────────────────────────────────────
function ollama(): AiProvider | null {
  const url = process.env.OLLAMA_URL;
  if (!url) return null;
  const model = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
  return {
    name: "ollama",
    model,
    async generateJson(req) {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: req.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: req.schema, // Ollama structured outputs: constrain to JSON schema
          options: { temperature: req.temperature ?? 0.4, num_predict: req.maxTokens },
          messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        }),
      });
      const body = await res.text();
      if (!res.ok) throw httpError("ollama", res.status, body);
      const data = JSON.parse(body) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      return { json: parseJsonLoose(data.message?.content ?? ""), inputTokens: data.prompt_eval_count, outputTokens: data.eval_count };
    },
  };
}

// ── Groq (OpenAI-compatible, free tier) ────────────────────────────────────
function groq(): AiProvider | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  return {
    name: "groq",
    model,
    async generateJson(req) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: req.signal,
        body: JSON.stringify({
          model,
          temperature: req.temperature ?? 0.4,
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${req.system}\n\nRespond with a single JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}` },
            { role: "user", content: req.user },
          ],
        }),
      });
      const body = await res.text();
      if (!res.ok) throw httpError("groq", res.status, body);
      const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      return { json: parseJsonLoose(data.choices?.[0]?.message?.content ?? ""), inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
    },
  };
}

// ── Google Gemini (free tier) ──────────────────────────────────────────────
function gemini(): AiProvider | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  return {
    name: "gemini",
    model,
    async generateJson(req) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: req.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${req.system}\n\nRespond with JSON matching this schema:\n${JSON.stringify(req.schema)}` }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          generationConfig: { temperature: req.temperature ?? 0.4, maxOutputTokens: req.maxTokens, responseMimeType: "application/json" },
        }),
      });
      const body = await res.text();
      if (!res.ok) throw httpError("gemini", res.status, body);
      const data = JSON.parse(body) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return { json: parseJsonLoose(text), inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount };
    },
  };
}

// ── Anthropic (optional, paid) — official SDK + structured outputs ────────
function anthropic(): AiProvider | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
  const client = new Anthropic({ maxRetries: 2 });
  return {
    name: "anthropic",
    model,
    async generateJson(req) {
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
          },
          { signal: req.signal },
        );
        if (response.stop_reason === "refusal") throw new ProviderError("Model declined the request", false);
        const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        return { json: parseJsonLoose(text), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError("anthropic rate limited", true, 429);
        if (e instanceof Anthropic.AuthenticationError) throw new ProviderError("anthropic: invalid API key", false, 401);
        if (e instanceof Anthropic.BadRequestError) throw new ProviderError(`anthropic: ${e.message}`, false, 400);
        if (e instanceof Anthropic.APIError) throw new ProviderError(`anthropic ${e.status}: ${e.message}`, (e.status ?? 500) >= 500, e.status);
        throw new ProviderError(e instanceof Error ? e.message : String(e), true);
      }
    },
  };
}

/** Configured providers in priority order (free first). */
export function configuredProviders(): AiProvider[] {
  return [ollama(), groq(), gemini(), anthropic()].filter((p): p is AiProvider => p !== null);
}

export function aiStatus(): { enabled: boolean; providers: { name: string; model: string }[] } {
  const ps = configuredProviders();
  return { enabled: ps.length > 0, providers: ps.map((p) => ({ name: p.name, model: p.model })) };
}
