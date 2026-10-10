# Data sources and the collection engine

Goal: 100,000 unique African service businesses (Nigeria first), with as many publicly listed business emails as possible, using free sources that permit this use. Live, measured progress is on **Collection Progress** (`/collection`) and `npm run collect -- --status`. This page explains the sources; it does not claim results.

## Why the first version found so little

The original pipeline searched **one source (OpenStreetMap) in city bounding boxes**, with a handful of category tags. OpenStreetMap maps relatively few small service businesses in African cities, and rarely their emails. One Lagos run gave 16 businesses and 2 emails. That measured OpenStreetMap's coverage, not the market. Your manual searches found more because Google Maps and web search draw on business listings (largely Facebook business pages and Google Business Profiles) that OpenStreetMap doesn't have.

Overture Maps Places publishes exactly that kind of listing data (contributed by Meta, Microsoft and others) as an open dataset. It is now the primary source.

## Sources

| Source | What it provides | Licence / permission | How it's queried | Limits |
|---|---|---|---|---|
| **Overture Maps Places** (primary) | Name, category, address, phone, website, social links and, for many listings, a public business email. Contributed largely from public Facebook business pages (Meta) and Microsoft | CDLA Permissive 2.0 (free, commercial use and storage allowed, with attribution) | DuckDB reads the public GeoParquet on S3 per 2° tile per country; only overlapping row groups are downloaded. Releases auto-detected (`OVERTURE_RELEASE` to pin) | Network bandwidth; tens of seconds per tile |
| **OpenStreetMap, country-wide** | Tagged businesses per category over the whole national boundary, plus a whole-word name-pattern pass ("… Barbing Salon") over shops/crafts/offices that lack the category tag | ODbL (attribution) | Overpass `area["ISO3166-1"=…]` queries, ≥15 s apart, fallback mirror (`OVERPASS_URL` takes a comma-separated list) | Public Overpass fair use; large countries can time out (retried with backoff, then dead-lettered and shown) |
| **Common Crawl URL index** | Business websites on national domains (`*.com.ng`, `*.co.ke`, `*.co.za`, …) whose hostname contains a service word ("salon", "barber", "catering"…). Emails come from the website crawler | Common Crawl terms of use (open index) | One unit per index page (e.g. 47 pages for `*.com.ng`) | Only businesses with a website on the national domain |
| **Website crawler** (enrichment) | Public emails on each business's own site (homepage + up to 4 contact/about/booking pages): `mailto:`, text, "[at]" obfuscation, Cloudflare-protected addresses; booking links; the site's real name | Respects robots.txt; public pages only | Persistent queue, 6–8 sites in parallel, 400 ms between pages per site, 12 s timeouts, retry ×3 with backoff | Sites that block robots or don't publish an email |
| **DNS email check** | Syntax, disposable domains, MX records | Free | Batched; domain results cached | Can't confirm a mailbox exists → "deliverability unknown" |
| CSV import / Quick capture | Lists you have rights to, Google Maps finds you collect by hand, the bookmarklet | Your data | Discover → Import CSV / Quick capture | Manual |
| Instagram Graph API | Business Discovery profiles | Meta platform terms | Discover → Instagram | 30 hashtags/week |
| ZeroBounce (optional) | Mailbox-level verification | Paid after 100 free/month | On demand only, never in bulk automatically | Credits |

## Not automated, and why

| Source | Reason | Alternative in the app |
|---|---|---|
| Google Maps / Places API | Places API terms prohibit storing Places content (beyond place IDs) and building lead lists; scraping Maps violates Google's terms | Manual research queries on Collection Progress (they open in Maps), then Quick capture or CSV import |
| Google / Bing / DuckDuckGo results pages | Their terms prohibit automated querying; the Bing Search API was retired; Google's Custom Search JSON API is closed to new customers | Same manual query list; Common Crawl covers websites in bulk |
| Brave Search API free tier | The free plan doesn't include rights to store results | Can be added as an adapter on a plan with storage rights |
| Foursquare Open Source Places | Its public S3 bucket is now empty; access moved behind Foursquare's portal | Add later via its official download after registering |
| Paid directories / data vendors | Cost, and their terms usually forbid extraction | CSV import of licensed lists |
| Facebook / Instagram / TikTok pages directly | Platform terms prohibit scraping | Overture already includes Meta's open contribution of business-page data |

## Email status categories

Shown on Collection Progress, one row per business:

| Category | Meaning |
|---|---|
| Publicly found | Taken from the business's own public listing or website; the source URL is stored |
| Syntax-valid | Well-formed and not marked invalid |
| Domain has MX | The domain has mail servers (free DNS check) |
| Deliverability unknown | Passed the free checks; the mailbox itself isn't confirmed |
| Catch-all or uncertain | Verification provider couldn't confirm it, or flagged it risky |
| Verified | Mailbox confirmed by a verification provider (never from DNS alone) |
| Invalid / bounced | Bad domain, no mail server, or bounced |
| Needs review | The same address is listed for several businesses (a shared agency or mall inbox); check before emailing |
| Suppressed | Opted out or on do-not-contact |
| No public email found | No email in the listing, and the website (if any) had none |

No address is ever guessed (no `info@domain` patterns), and no probe or test emails are sent.

## Deduplication and counting

- Each source record keeps its source, external id and URL (`prospect_sources`), so one business found by Overture, OpenStreetMap and Common Crawl is **one** business with three provenance rows.
- Automatic merges happen only on exact identity (same social handle, same source URL, or same phone/email plus a similar name). Shared contact details with unrelated names are flagged for review, never merged.
- Business counts exclude demo data and merged duplicates. Email counts are separate: a business with three emails counts once as a business and three times as an email address.

## Running it

- **In the app:** Collection Progress → choose countries and sources → **Start collection**. The background worker runs discovery, crawling and email checks continuously. Pause, resume, stop, and **Retry failed work** are on the same page.
- **Unattended / long runs:** `npm run collect -- --minutes 240 --countries NG,GH,KE` (Ctrl+C stops after the current step; rerun to resume). `npm run collect -- --status` prints progress. With the embedded database, stop `npm run dev` first (only one process can hold it); with `DATABASE_URL` both can run.
- **Auto-expand:** when every planned unit is done and the target isn't reached, the next country in the list (Nigeria → Ghana → Kenya → South Africa → Uganda → Tanzania → Rwanda → …) is planned automatically.
