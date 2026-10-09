# Integration Feasibility Audit

_Last researched: 2026-10-07. Platform rules change often — re-verify against the official docs linked below before enabling any integration in production._

This audit decides **what Orbit Outbound OS is allowed to automate**, what it can only assist with, and what must stay entirely human. Every adapter in `src/server/adapters/` maps to a row in this document. If a capability is not marked **Automated (permitted)** here, the code must not automate it.

## Summary matrix

| Source / channel | Discover businesses | Read public profile | Get contact info | Send messages | Automate messages | Build status in this system |
|---|---|---|---|---|---|---|
| **TikTok** | ❌ No commercial API | ❌ Only for users who OAuth into your app | ❌ | ❌ Cold DMs not available | ❌ | **Human-assisted**: manual capture + copy/open-profile/mark-sent |
| **Instagram (Meta)** | ❌ No keyword/location search. Hashtag search returns **no usernames** | ⚠️ Business Discovery: Pro accounts only, **by known username** | ⚠️ Website/bio only if public on Pro accounts | ❌ Cannot start a conversation | ⚠️ Replies only, within 24h of the user's last message (7 days with `HUMAN_AGENT`) | **Human-assisted** outreach. Enrichment adapter stub that needs Meta App Review |
| **LinkedIn** | ❌ Partner Program only (<10% approval) | ❌ | ❌ | ❌ Partner-only | ❌ | **Manual only**. No adapter. Scraping is prohibited and litigated |
| **Google Maps / Places** | ⚠️ Text Search exists, but... | ⚠️ | ⚠️ | n/a | n/a | **Not used for lead databases.** Terms prohibit building lead lists and storing Places content (only `place_id` may be stored). Manual "look up on Maps" links only |
| **OpenStreetMap (Overpass)** | ✅ Query by tag + area (e.g. `shop=hairdresser` in Lagos) | ✅ Name, tags, sometimes phone/website/socials | ⚠️ When mappers added it | n/a | n/a | **Automated (permitted)**: working adapter with strict rate limits and ODbL attribution |
| **Foursquare OS Places** | ✅ Bulk dataset, 100M+ POIs, 1,000+ categories | ✅ Name, category, address, sometimes phone/website/socials | ⚠️ Partial | n/a | n/a | **Bulk import (permitted)**: CSV import preset. Apache 2.0, attribution required |
| **CSV import** | ✅ Your own lists | ✅ | ✅ | n/a | n/a | **Automated**: mapping, preview, dedup, import |
| **Business websites** | n/a | ✅ Public pages | ⚠️ Contact pages | n/a | n/a | **Assisted**: one polite fetch of a URL you already have, respecting robots.txt. No crawling of platforms |
| **Email (Resend / Postmark / SendGrid-type ESPs)** | n/a | n/a | n/a | ✅ | ❌ **Cold outreach banned by their AUPs** | Not used for prospecting |
| **Email (your own mailbox: Gmail / Workspace / Outlook)** | n/a | n/a | n/a | ✅ | ✅ 1:1, human-reviewed, capped per mailbox | **Primary channel.** Sends via Gmail API / Microsoft Graph with OAuth after human review; replies/bounces read from your own threads. See docs/email.md |
| **WhatsApp Business Platform (Cloud API)** | n/a | n/a | n/a | ✅ Templates | ❌ **Opt-in required before business-initiated messages** | Not used for cold outreach. Can be enabled later **only for prospects who opted in** (e.g. they messaged first) |
| **WhatsApp (personal / Business app via `wa.me` link)** | n/a | n/a | n/a | ✅ Human sends each one | ❌ | **Human-assisted**: open `wa.me` with prefilled text, human presses send, marks sent |
| **Orbit (conversion source)** | n/a | n/a | n/a | n/a | n/a | **Automated**: signed webhook + CSV + manual match. Orbit is treated as an external product |

Legend: ✅ available · ⚠️ limited or conditional · ❌ not available or not permitted

---

## 1. TikTok

**Official surfaces:** Login Kit, Display API, Content Posting API, Research API, Marketing API (TikTok API for Business), Business Messaging API.

| Question | Finding |
|---|---|
| What data can be accessed? | Display API: **only the authorized user's** profile basics (avatar, display name; more fields need pre-approval) and their own videos. Marketing API: your own ad accounts and owned content. |
| Can businesses be searched? | **No.** The Research API supports search but is restricted to non-profit academic researchers. TikTok's FAQ says commercial users are ineligible. |
| Public profile info for arbitrary accounts? | **No** official commercial route. |
| Contact info? | No. |
| Can messages be sent? | Business Messaging API covers one-to-one conversations between a TikTok user and a Business Account, built around user-initiated threads. **No cold-DM capability.** |
| Can messages be automated? | Only replies in existing conversations, through approved partners. |
| Permissions / approval | App review per scope. Research API needs academic approval. |
| Rate limits | Per-endpoint, per-app. Irrelevant here because no discovery endpoint is usable. |
| Limitations | Scraping TikTok violates its terms. Third-party "TikTok scraping APIs" are **not** permitted sources and are **not** integrated. |
| **Compliant fallback** | **Manual capture:** a team member finds a business on TikTok while browsing normally, pastes the profile URL and bio text into _Discover → Add manually_, and the system parses handle, links, phone and booking signals from the pasted text. **Outreach:** AI drafts → human reviews → _Open profile_ → human sends in the TikTok app → _Mark sent_. |

## 2. Instagram / Meta

**Official surfaces:** Instagram API with Facebook Login (Graph API), Instagram API with Instagram Login, Messaging API (Instagram), Business Discovery, Hashtag Search.

| Question | Finding |
|---|---|
| What data can be accessed? | Your own professional account's data. Through **Business Discovery**, basic public metadata of **other professional (Business/Creator) accounts**: followers_count, media_count, biography, website, recent media. Age-gated accounts are excluded. |
| Can businesses be searched? | **No** keyword, category or location search. Business Discovery needs the **exact username**. Hashtag Search allows max **30 unique hashtags per rolling 7 days** and **does not return usernames** or any PII of the posters. |
| Public profile info? | Yes for Pro accounts **when you already know the username** (enrichment, not discovery). |
| Contact info? | Only what's in the public bio/website field. Business contact buttons (email/phone) are not exposed via Business Discovery. |
| Can messages be sent? | **Only after the user messages you first.** You then have 24h to reply, or 7 days with the `HUMAN_AGENT` tag when a human is replying. |
| Can messages be automated? | Replies within the window only. Send API ~100 calls/s per account; Conversations API 2 calls/s. Automated cold outreach is **not possible**. |
| Permissions | `instagram_basic` / `instagram_business_basic`, `pages_show_list`, `instagram_manage_messages` (messaging), Business Discovery feature access. **App Review + Business Verification** required for Advanced Access. |
| Rate limits | Business Discovery and Hashtag Search use Platform Rate Limits (rolling 1-hour window, scales with app users). |
| Limitations | No discovery, no cold DMs, scraping prohibited. |
| **Compliant fallback** | Manual capture plus the **Instagram enrichment adapter** (stub, disabled until App Review), which enriches known handles with followers/bio/website through Business Discovery. Outreach is human-assisted (open profile, copy, send, mark sent). If a prospect DMs Orbit's account first, a future Messaging adapter can reply within the 24h window. |

## 3. LinkedIn

| Question | Finding |
|---|---|
| Data access | Sign In with LinkedIn (OIDC) basic profile of the authorizing user. Everything else (profile data of others, messaging, Sales Navigator) needs the **LinkedIn Partner Program**. |
| Search businesses | No public API. |
| Messaging | Partner-only. Approval rate reportedly <10%, 3–6 month timeline. |
| Scraping | Prohibited. LinkedIn actively enforces, and Proxycurl shut down in 2025 after being sued. |
| **Compliant fallback** | `linkedin_url` is a field on the prospect. Outreach on LinkedIn is fully manual (open profile, copy message, mark sent). **No adapter is built.** For Orbit's ICP (Nigerian beauty and service SMBs) LinkedIn is a low-value channel anyway. |

## 4. Google Maps Platform (Places API)

| Question | Finding |
|---|---|
| Data access | Text Search / Nearby Search / Place Details: name, address, phone, website, rating, hours, etc. Text Search Pro ≈ $32 per 1,000 calls (Essentials IDs-only is free). |
| Search businesses | Technically yes. |
| **Terms** | The Google Maps Platform ToS **prohibit extracting, exporting, caching or storing Places content** for use outside Google Maps, and explicitly **prohibit building lead lists, telemarketing lists or substitute directories**. Only `place_id` may be stored indefinitely; lat/lng for up to 30 days. |
| Messaging | n/a |
| **Decision** | **No Google Places discovery adapter.** Building a 30k-prospect database from Places would breach the terms. |
| **Compliant fallback** | Each prospect gets a "Look up on Google Maps" link (opens a normal Maps search for a human to verify). Optionally a future feature stores only `place_id` and renders details live through an embedded Google Map, which is permitted but adds little for outbound. |

## 5. OpenStreetMap (Overpass API)

| Question | Finding |
|---|---|
| Data access | All OSM features: names, tags such as `shop=hairdresser`, `shop=beauty`, `beauty=nails`, `craft=photographer`, `amenity=spa`, and often `phone`, `website`, `contact:instagram`, `opening_hours`. |
| Search businesses | ✅ By tag within an area (Lagos State, Abuja FCT, etc.). |
| Contact info | When mappers added it (coverage in Nigeria is partial). |
| Storage | ✅ Allowed under the **ODbL**, with attribution "© OpenStreetMap contributors". A derivative database that's publicly distributed must stay under ODbL (share-alike). Internal use is fine. |
| Rate limits | Public overpass-api.de: keep regular automated use under ~100 queries/day and ~10MB/day. No parallel requests. On 429/504 back off ≥30s. **Commercial/heavy use should use a self-hosted or paid Overpass instance** (configurable via `OVERPASS_URL`). |
| **Build status** | **Working adapter** (`OsmOverpassAdapter`) that runs through the job queue with a 1-request-at-a-time limiter, exponential backoff and a configurable endpoint. Attribution shown in the UI and exports. |

## 5b. Web search APIs (primary automated discovery for social profiles)

**Decision (2026-10-07):** social-first service businesses (Instagram/TikTok-only nail techs, lash techs, MUAs) are found by querying an **official web search API** for public profile pages, e.g. `site:instagram.com "nail tech" Lagos "DM to book"`. This uses the search provider's licensed API. It does **not** scrape Instagram or TikTok. We store the profile URL, handle and snippet, then enrich Instagram handles via the official Business Discovery API.

| Provider | Status | Notes |
|---|---|---|
| **Brave Search API** | ✅ **Chosen** | Official, commercial use permitted. Plans restructured early 2026 (free tier retired). **Storing results requires a plan that explicitly grants storage rights** ("Data with Storage Rights"). Buy that plan before persisting snippets. Rate limit depends on plan (e.g. 2 req/s on some plans) and is honoured by the adapter's limiter. |
| Google Custom Search JSON API | ❌ | **Closed to new customers; retires 1 Jan 2027.** Its suggested successor (Vertex AI / Agent Search) searches your own content, not the public web. |
| Bing Web Search API | ❌ | Retired by Microsoft (Aug 2025). |
| SERP-scraping services (SerpAPI-style) | ❌ Not used | They scrape Google results, which is outside Google's terms. |

**Pipeline:** query planner (categories × cities × booking phrases) → `WebSearchAdapter` (Brave) → parse handle/phone/booking link from URL + snippet → dedupe → (Instagram) Business Discovery enrichment → score → AI draft → review queue.

**Yield:** each query returns a limited number of results (paged), so the planner rotates many query combinations and tracks yield per query to retire unproductive ones. Expected volume is measured, not promised.

**Message delivery for discovered profiles:** WhatsApp `wa.me?text=` fully pre-fills the message. Instagram (`ig.me/m/<handle>`) and TikTok have no official pre-fill, so the system copies the message to the clipboard and opens the DM/profile, and the human pastes and sends. Browser-extension auto-typing into platform composers is deliberately **not** built, because it risks being treated as automation.

Sources: [Brave Search API](https://api.search.brave.com), [Brave pricing/plans](https://api-docs.search.brave.software/pricing), [storage-rights summary](https://parallel.ai/articles/brave-search-api-vs-parallel), [Google CSE shutdown](https://brave.com/learn/google-api-shutdown/), [CSE closed to new customers](https://cloro.dev/blog/google-custom-search-api-shutdown/)

## 6. Foursquare Open Source Places

| Question | Finding |
|---|---|
| Data | 100M+ POIs, 22 core attributes, 1,000+ categories. Some rows have phone, website, Instagram/Facebook/Twitter handles. |
| License | **Apache 2.0**, free with attribution (keep the NOTICE when redistributing). |
| Access | Places portal (token + Iceberg catalog), Snowflake, HuggingFace (Parquet). |
| **Build status** | **CSV import preset** (`foursquare_os`). Filter the Parquet to Nigeria plus relevant categories with DuckDB (command in `docs/integrations.md`), export to CSV, then import with automatic column mapping. |

## 7. Email

| Question | Finding |
|---|---|
| Transactional ESPs (Resend, Postmark, etc.) | Their acceptable-use policies **prohibit unsolicited cold outreach**. Not used. |
| Own mailbox (Gmail API) | `gmail.send` scope is "sensitive" and needs Google OAuth verification. Workspace limit 2,000 messages/day per user (3,000 external recipients/day). |
| Own mailbox (Microsoft Graph) | `Mail.Send`. ~30 messages/minute, 10,000/day per mailbox. |
| Gmail/Yahoo sender rules | SPF/DKIM/DMARC, a clear opt-out, user-reported spam rate under 0.1% (never above 0.3%). One-click List-Unsubscribe is mandated for bulk senders (5,000+/day to Gmail). |
| Contact info | Only addresses found in public business sources or your own lists. No email-guessing/verification services by default. |
| **Build status** | **Implemented.** Send from the composer or the paced queue through the Gmail API / Microsoft Graph (OAuth, encrypted refresh token, no passwords). Marked sent only after the provider returns a message id. Footer with sender identity, postal address and one-click unsubscribe (List-Unsubscribe headers) is added automatically. Caps: default 50/day (personal) or 100/day (business), warm-up +10/week, never above the provider limit; 90s minimum between sends; automatic pause on bounce >5% or complaints >0.3%. Google External apps in Testing mode issue 7-day tokens; publishing with gmail.readonly needs Google verification. |

## 8. WhatsApp

| Question | Finding |
|---|---|
| WhatsApp Business Platform (Cloud API) | Business-initiated messages need **approved templates** and **prior opt-in** from the recipient (WhatsApp Business Messaging Policy). For Nigeria, opt-in should name WhatsApp and the message type. Marketing template ≈ US$0.06 per message for Nigerian numbers (per-message pricing since July 2025). Service replies within the 24h customer service window are free. |
| Cold outreach via API | ❌ **Not permitted**: cold prospects have not opted in. |
| `wa.me` click-to-chat | Public deep link. Opens WhatsApp with prefilled text, and a human presses send. Still subject to WhatsApp's terms against bulk/unsolicited messaging, so volume caps and quality matter. |
| **Build status** | **Human-assisted**: _Open WhatsApp_ generates `https://wa.me/<number>?text=<message>`. Daily per-channel caps (default 60) and the DNC/opt-out system apply. The Cloud API adapter is a stub that can only be enabled for **opted-in** prospects (e.g. after they reply "yes, send me details"). |

## 9. Orbit (conversion source)

Orbit is an **external product** to this system (see `docs/architecture.md`). Conversions arrive via:

1. **Signed webhook** `POST /api/v1/conversions` (HMAC-SHA256 with `CONVERSION_WEBHOOK_SECRET`). Events: `signup`, `activated`, `paid`. Matching uses ref code → email → phone.
2. **CSV import** of signups (for backfills).
3. **Manual match** from the prospect page.

Tracked links go through this system's redirector `/r/<code>`, which logs the click and redirects to Orbit's signup URL with UTM parameters and an opaque `ob_ref` code. No PII goes in URLs. Orbit needs a small change to pass `ob_ref`/UTMs back in its webhook; see `docs/integrations.md`.

## 10. Legal: Nigeria Data Protection Act 2023 (NDPA)

- Prospecting businesses whose contact details are publicly listed **for bookings** can rely on **legitimate interest** (NDPA s.25), but the NDPC's GAID requires a **documented Legitimate Interest Assessment (LIA)**. An undocumented reliance won't survive audit. A template is included in `docs/outreach-compliance.md`.
- Honour objections and opt-outs immediately and permanently (built-in DNC system).
- Data minimisation: store only fields useful for qualification and outreach. No sensitive personal data.
- Retention: prospects with no engagement are flagged for deletion after a configurable period (default 12 months).
- A 2025 Federal High Court decision confirmed individuals can successfully sue over unsolicited direct marketing under the NDPA. Quality and opt-out handling are a legal requirement as well as a growth one.

_This is engineering research, not legal advice. Have Nigerian counsel review the LIA before scaling outreach._

---

## What this means for the product

1. **Discovery at scale** = OSM + Foursquare OS + your own CSV lists + fast manual capture from TikTok/Instagram browsing. That's realistic for reaching 30k Nigerian service businesses, with manual capture likely producing the highest-quality social-first leads.
2. **Outreach** = AI drafts every message. The system routes it through the most permitted path available per channel, which today is **human-sends for every channel**. The queue is built so a human can review and send ~100–200 high-quality messages a day with keyboard shortcuts.
3. **Automation boundaries are encoded in code**: `src/server/channels/registry.ts` declares each channel's `mode` (`automated` | `assisted` | `manual`) and caps. The validator blocks any send that doesn't match.

## Sources

- TikTok Research API eligibility: [xpoz.ai guide](https://www.xpoz.ai/blog/guides/tiktok-research-api-limits-access-and-alternatives/), [datashake](https://www.datashake.com/blog/tiktok-data-coverage-in-2026-what-social-intelligence-teams-need-to-know); Display API / Login Kit: [developers.tiktok.com](https://developers.tiktok.com/docs/en/display-api-get-started), [Login Kit](https://developers.tiktok.com/docs/en/login-kit-overview); Business Messaging: [TikTok API for Business](https://ads.tiktok.com/help/article/marketing-api)
- Instagram Business Discovery: [Meta docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery); Hashtag Search limits: [Meta docs](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search.md); messaging window: [Sinch Instagram channel docs](https://developers.sinch.com/docs/conversation/channel-support/instagram/properties); rate limits: [getphyllo](https://www.getphyllo.com/post/instagram-api-rate-limits-explained-and-how-to-scale-beyond-them-2026)
- LinkedIn: [salesforge](https://www.salesforge.ai/blog/linkedin-api), [unipile](https://www.unipile.com/linkedin-api-a-comprehensive-guide-to-integration/)
- Google Maps Platform terms: [pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [no-scraping provision summary](https://conductatlas.com/platform/google-maps/google-maps-platform-terms-of-service/no-scraping-or-content-extraction/), [caching policy comparison](https://openplacesapi.com/blog/can-you-store-places-api-results)
- OSM Overpass usage policy: [OSM wiki](https://wiki.openstreetmap.org/wiki/Overpass_API), [Overpass manual](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
- Foursquare OS Places: [docs](https://docs.foursquare.com/data-products/docs/fsq-places-open-source), [blog](https://foursquare.com/resources/blog/data/evolving-fsq-open-source-places/)
- Email: [Resend AUP](https://resend.com/legal/acceptable-use), [Gmail sender requirements](https://blog.google/products/gmail/gmail-security-authentication-spam-protection/), [Workspace sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)
- WhatsApp: [pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [opt-in policy (cm.com)](https://www.cm.com/blog/whatsapp-updates-opt-in-and-quality-rating-policy/), [Nigeria pricing (Innovation Village)](https://innovation-village.com/whatsapp-to-charge-nigerian-businesses-for-customer-replies/), [Nigeria guide](https://chatdaddy.tech/blog/whatsapp-marketing-nigeria)
- NDPA: [KPMG summary](https://assets.kpmg.com/content/dam/kpmg/ng/pdf/the-nigeria-data-protection-act-2023.pdf), [legitimate interest (Mondaq)](https://www.mondaq.com/nigeria/privacy-protection/1390208/legitimate-interest-as-a-new-basis-for-processing-personal-data-in-nigeria-how-does-it-compare-to-existing-lawful-bases-and-data-subject-rights), [consent vs LI](https://globallawexperts.com/consent-vs-legitimate-interest-nigeria/)
