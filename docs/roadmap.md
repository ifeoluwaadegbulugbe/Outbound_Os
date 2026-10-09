# Roadmap

## Built (v0.1)

Phases 1–6 of the brief, plus the compliant parts of phase 7: foundation (auth, roles, RLS, design system, navigation, command palette), campaigns & goals, prospects (filters, saved views, natural-language filters, bulk actions, export), discovery (Instagram Graph API snowball, OpenStreetMap, CSV/Foursquare, quick capture + bookmarklet, mock), dedup review & merge, transparent scoring, research briefs, message generation & variants, validator, review queue, send session, browser extension, sender caps & warm-up, follow-ups, inbox & reply assistant, opt-out/DNC, tracked links, conversion webhook & manual matching, analytics, experiments with significance, insights, notifications, audit log, system health, docs and tests.

## Next

1. **Verify the browser extension on live Instagram/TikTok web** with a real account (selectors for the DM composer change occasionally; `extension/composer.js` keeps them in one list).
2. **Ship the Orbit webhook change** (`docs/integrations.md` §5) so signups attribute automatically.
3. **Connect Instagram** and tune the default hashtag sets per city/category from real yield (`hashtag_queries.results`).
4. **Retention job:** delete prospects with no engagement after 12 months (NDPA minimisation); keep suppression entries.
5. **Activation definition from Orbit:** send `activated` when a user creates their first client or booking.
6. **Playwright browser E2E** alongside the existing service-level workflow test.

## Later

- WhatsApp Cloud API replies **for prospects who message first** (permitted; within the 24h window).
- Instagram Messaging API replies for inbound DMs to Orbit's account (24h window / human agent tag).
- Lead-gen inbound: Click-to-WhatsApp and Instagram lead ads feed straight into the inbox with opt-in recorded.
- Optional Brave Search adapter (paid storage-rights plan) for profile discovery.
- Per-user sender assignment and round-robin queues for teams.
- Multi-workspace SaaS: billing, workspace invites, per-workspace product config (schema and RLS already support it).
- Email sending from a connected Gmail/Workspace mailbox (OAuth, verification required).
