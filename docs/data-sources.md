# Data sources: what's integrated, what it costs, what it can realistically reach

The goal is 100,000+ African service businesses with email (Nigeria first). This page states what is actually integrated and tested today, and what would be needed to get there. **No claim of 100k reachable emails is made until sources that can deliver them are integrated and tested.**

## Integrated and working

| Source | What it gives | Cost | Limits | Email coverage |
|---|---|---|---|---|
| **OpenStreetMap (Overpass)** | Mapped businesses by category × city across the built-in African locations and any city you add, with name, address, phone, website, sometimes email/Instagram | Free (ODbL, attribution required) | Public endpoint: low volume, one request at a time (the adapter waits 5s between queries). Heavy use: self-host Overpass or use a paid instance via `OVERPASS_URL` | Low. In a real Lagos test run, 2 of 16 businesses had an email in OSM and 1 had a website. Coverage varies a lot by city |
| **Website email finder** | Public emails on a business's own site (homepage + up to 4 contact/about/booking pages), each stored with source URL and timestamp | Free | Respects robots.txt, 5 pages max, 1.5 MB/page, 400 ms between pages, blocks private IPs, skips social/directory hosts | Only for businesses that have a website and publish an address |
| **CSV / list import** | Your own lists or open datasets (e.g. Foursquare Open Places) with column mapping, dedup and scoring | Free | 50k rows per import | Whatever the list contains. Only import data you have the right to use |
| **Quick capture + bookmarklet** | Profiles you find while browsing | Free | Manual | Manual |
| **Instagram Graph API** | Hashtag → mentions → Business Discovery profiles (bio, website, sometimes public email) | Free | 30 unique hashtags / 7 days; rate-limited by Meta (the app paces at 180 calls/hour by default); needs a Meta app + Instagram professional account | Partial (public business email on some profiles) |
| **DNS verification** | Syntax, disposable domain and MX check | Free | DNS must be reachable from the server | n/a (max status: deliverability unknown) |
| **ZeroBounce** | Mailbox-level verification | 100 free/month (business-domain signup), then pay-as-you-go | API key required | n/a |

Per-source counts (businesses, with website, with email, verified, countries) are shown live under **Discover Businesses → Runs → What each source has contributed**.

## Realistic reach today

The only measured result so far is one Lagos OpenStreetMap run: 16 businesses, 2 with an email (13%), 1 with a website. OpenStreetMap coverage of small service businesses in African cities is thin, so free sources alone will reach far fewer than 100,000 businesses with email. Run discovery across your target cities and read the real totals from the contribution table before planning volume.

## What would be needed for 100k+ (not integrated, mostly paid)

| Option | Notes |
|---|---|
| **Licensed business directories / data vendors** (e.g. local directories such as VConnect or BusinessList.com.ng under a data licence, Africa-focused B2B data vendors) | Paid; requires a licence that permits outreach use. Import via CSV, or add an adapter |
| **Foursquare Places API / Open Places** | Open Places dataset is free (Apache 2.0) but has few emails; the API is paid beyond the free tier. Combine with the website finder |
| **Self-hosted Overpass** | Removes public-endpoint throttling; still limited by OSM coverage |
| **Google Places API** | Not used: Google's terms prohibit building lead lists or caching Places data |
| **Email finder services** (Hunter, Apollo, etc.) | Free tiers are small (Hunter: roughly 50–100 lookups/month); pattern-guessed addresses must not be marked verified |

New sources plug in as adapters (`src/server/adapters/*`, the `SourceAdapter` interface) or through CSV import. Discovery is resumable: each city × category unit is checkpointed, so a 100k-scale run can be paused, resumed or cancelled without duplicates.
