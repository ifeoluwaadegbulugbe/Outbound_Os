# AI system

AI is a writing and judgement assistant, never the source of truth. The system works fully without any AI provider (templates and rules), and every AI output is validated before it's used.

## Where AI is (and isn't) used

| Task | AI? | Fallback | Notes |
|---|---|---|---|
| ICP / priority / completeness scoring | **No** | — | Deterministic, every point explained (`domain/scoring.ts`) |
| Deduplication | **No** | — | `domain/dedup.ts` |
| Opt-out detection | **No** | — | Deterministic regex, authoritative — AI can never override it |
| Insights | **No** | — | SQL statistics with minimum samples (`services/insights.ts`) |
| Research brief | Yes | Facts-only rule brief | Must cite fact ids |
| Message drafts | Yes | Templates per angle | Must pass the validator |
| Reply intent | Yes (refines rules) | Rule classifier | |
| Reply suggestions | Yes | Intent templates | Product facts only |
| Natural-language filters | Only when the rule parser leaves words unparsed | Rule parser | Field/value whitelist |

## Task runner (`src/server/ai/run.ts`)

Each task declares: input, **output schema (zod → JSON Schema)**, system prompt, prompt builder, optional **semantic validator**, and a deterministic **fallback**.

1. Try configured providers in order (Ollama → Groq → Gemini → Anthropic), skipping any on rate-limit cooldown.
2. Constrain output to JSON (Ollama `format` schema, Groq `json_object`, Gemini `application/json`, Anthropic `output_config.format` structured outputs).
3. Validate with zod, then the semantic validator. On failure, retry once with the rejection reason in the prompt.
4. Exhausted → fallback. The result is always labelled (`ai:groq/…` or `rules`/`template`) and shown in the UI.
5. Every attempt is logged to `ai_runs` (provider, model, status, latency, tokens, error) → Settings → System health.

Concurrency is capped per process (`AI_MAX_CONCURRENCY`, default 3). AI calls run **outside** database transactions.

## Hallucination protection

`ai/facts.ts` turns a prospect into numbered **KNOWN FACTS** (each traceable to a field or a quoted bio fragment) plus an explicit **UNKNOWN** list (e.g. "Whether they take bookings on WhatsApp").

- **Research briefs** return statements `{ text, kind: fact | inference, basis: [fact ids] }`. The validator rejects statements citing nonexistent ids and summaries containing numbers that aren't in the facts. The UI shows ✓ facts, 💡 *AI inference* badges, and the unknowns.
- **Messages** pass `domain/validator.ts`, which blocks: fake familiarity ("loved my appointment"), unverified social proof ("500+ businesses use Orbit" unless listed in Settings), claims about a booking link that isn't on record, wrong @handles, placeholders, banned phrases; and warns on unverified workflow claims (DMs/WhatsApp), generic AI phrasing, corporate tone, emojis, length, spam triggers, category mismatch, missing personalisation.
- **Reply suggestions** may only state product facts from Settings → Workspace.

## Data minimisation

Prompts include only the fields needed (name, category, city, handle, public bio, signals). No conversation history beyond the thread being answered. No prospect data is sent to anonymous public endpoints (the Orbit app's Pollinations fallback is intentionally not used here).

## Changing models

Set `*_MODEL` env vars. For Anthropic the default is `claude-opus-5-5` with low effort and structured outputs; refusals (`stop_reason: refusal`) are treated as a non-retryable provider failure and fall back.
