# Integrations — how to connect each piece

What's possible on each platform (and why) is in [integration-feasibility.md](integration-feasibility.md). This doc is the how-to. **Email sending (Gmail / Outlook), verification and domain authentication are in [email.md](email.md); source coverage and costs in [data-sources.md](data-sources.md).**

## 1. Instagram (official Graph API) — discovery

Free. Uses Meta's documented **Hashtag Search** and **Business Discovery** endpoints with Orbit's own professional account. It never logs in as you, never scrapes, never sends messages.

1. **Professional account.** In the Instagram app: Settings → Account type and tools → switch Orbit's account to **Business** (or Creator). Link it to a Facebook Page.
2. **Meta app.** At developers.facebook.com → My Apps → Create app → type *Business*. Add the **Instagram** product (Instagram API with Facebook Login).
3. **Token.** In Graph API Explorer select your app, request `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`, generate a user token, then exchange it for a **long-lived token (≈60 days)** via the Access Token Debugger.
4. **Account ID.** Run `GET /me/accounts?fields=instagram_business_account{id,username}` — the `instagram_business_account.id` is your Instagram account ID.
5. **Connect.** In Outbound OS → Integrations → *Connect Instagram*, paste the ID and token. It's verified against Meta and stored AES-256-GCM encrypted.
6. **Review.** As the app's only (admin) user, Standard Access usually works in development mode. If Meta requires **App Review** for Hashtag Search ("Instagram Public Content Access"), describe the use case truthfully: *"An internal tool for our business account to find public business profiles in our market by hashtag and mention, read their public business profile via Business Discovery, and help our team prioritise who to contact manually. We do not store media, do not send messages via the API, and do not target personal accounts."*

**Limits respected automatically:** ≤30 unique hashtags per rolling 7 days (tracked in `hashtag_queries`), ~200 calls/hour per user (default pacing 180/h, configurable), automatic pause when Meta's usage headers exceed 85%. Personal accounts are skipped (Business Discovery only covers professional accounts).

**Token expiry:** long-lived tokens last ~60 days. When it expires, discovery jobs fail with a clear message and Integrations shows the error — reconnect with a fresh token.

## 2. OpenStreetMap — discovery

Works out of the box. Data © OpenStreetMap contributors, ODbL — attribution is shown in the UI and kept in exports. For heavy use set `OVERPASS_URL` to a self-hosted or commercial Overpass instance (the public one asks for low volume). Coverage of Nigerian beauty businesses is thin — treat it as a supplement.

## 3. Foursquare Open Source Places — bulk import

Apache 2.0. Download via the FSQ Places portal (free account) or HuggingFace, then filter to Nigeria with DuckDB:

```sql
COPY (
  SELECT fsq_place_id, name, fsq_category_labels, locality, region, address, country, tel, website, email, instagram, facebook_id
  FROM read_parquet('places/*.parquet')
  WHERE country = 'NG' AND (
    fsq_category_labels::VARCHAR ILIKE '%salon%' OR fsq_category_labels::VARCHAR ILIKE '%beauty%' OR fsq_category_labels::VARCHAR ILIKE '%barber%'
    OR fsq_category_labels::VARCHAR ILIKE '%spa%' OR fsq_category_labels::VARCHAR ILIKE '%nail%' OR fsq_category_labels::VARCHAR ILIKE '%photograph%')
) TO 'ng_services.csv' (HEADER);
```

Import it in Discover → Import CSV with the **Foursquare Open Source Places** preset. Keep Foursquare's NOTICE if you redistribute the data.

## 4. Browser extension — pre-filled DMs

1. Integrations → *Browser extension* → **Create token** (shown once).
2. Chrome/Edge → `chrome://extensions` → Developer mode → **Load unpacked** → select `outbound_system/extension`.
3. Extension options → app URL (`http://localhost:3100` or your deployment) + token → *Save & test*.
4. Outreach → **Send**, press Enter (or use the extension popup → *Start Instagram session*). The DM opens with the approved message typed in. **You press Send.** Then click *Mark sent & next* in the bar at the bottom of the page.

The extension only types into the message box. It never clicks Send, never navigates on its own except to open the next DM after you click, and the server enforces each sender account's daily cap. TikTok has no direct DM link: it opens the profile, you click *Message*, and the draft fills in.

## 5. Orbit — conversion attribution

Outbound OS is separate from Orbit. Orbit reports conversions to the webhook; nothing reads Orbit's database.

**Webhook:** `POST {APP_URL}/api/v1/conversions` — header `X-Outbound-Signature: sha256=<hex HMAC-SHA256 of the raw body>` with the secret from Integrations → *Orbit conversion webhook*. Body: one event or `{ "events": [...] }`:

```json
{ "type": "signup", "external_user_id": "orbit-user-uuid", "email": "owner@example.com",
  "phone": "+2348031234567", "instagram": "nailsbyteni", "ref_code": "aB3dE5fG",
  "utm": { "utm_campaign": "lagos_beauty" }, "occurred_at": "2026-10-09T10:00:00Z" }
```

`type`: `signup` · `activated` · `paid` (with optional `plan`, `amount`, `currency`). Events are idempotent per `(type, external_user_id)`. Matching: `ref_code` → email → phone → Instagram handle; unmatched events are kept and can be matched manually from the prospect page.

**The change needed in Orbit** (`TinyCRM/web`, ~15 lines — not made by this project):

1. On the signup page, read `ob_ref` and `utm_*` from the URL (tracked links add them) and send them with the signup request.
2. In `src/app/api/auth/signup/route.ts`, after the profile is created, fire-and-forget:

```ts
import { createHmac } from "node:crypto";

async function reportToOutbound(event: Record<string, unknown>) {
  const url = process.env.OUTBOUND_WEBHOOK_URL;       // e.g. https://outbound.example.com/api/v1/conversions
  const secret = process.env.OUTBOUND_WEBHOOK_SECRET;
  if (!url || !secret) return;
  const body = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Outbound-Signature": `sha256=${sig}` }, body })
    .catch((e) => console.warn("[outbound] report failed", e));
}

// after the profile upsert:
void reportToOutbound({ type: "signup", external_user_id: userId, email, ref_code: body.obRef ?? null, utm: body.utm ?? {}, occurred_at: new Date().toISOString() });
```

3. Send `activated` when a user first creates a client or booking, and `paid` from the Paystack webhook when a subscription starts.

Until that ships, use **manual matching** on the prospect page, or a CSV of signups.

## 6. AI providers (optional, free options first)

Set in `.env.local`; first configured wins, falling back down the chain and finally to templates/rules:

| Provider | Cost | Env |
|---|---|---|
| Ollama (local) | Free | `OLLAMA_URL=http://127.0.0.1:11434`, `OLLAMA_MODEL=llama3.1:8b` |
| Groq | Free tier | `GROQ_API_KEY`, `GROQ_MODEL` |
| Google Gemini | Free tier | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| Anthropic | Paid | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`) |

Prospect data is never sent to anonymous public endpoints. See [ai-system.md](ai-system.md).

## Not integrated (by design)

TikTok APIs (no commercial discovery/messaging), LinkedIn (partner-only), Google Places (terms forbid lead lists), WhatsApp Cloud API for cold outreach (requires opt-in), transactional ESPs for cold email (AUPs forbid it), Brave Search (paid storage rights; available later as an optional adapter).
