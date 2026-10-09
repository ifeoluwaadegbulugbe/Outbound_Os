# Outreach compliance

_Engineering guidance, not legal advice. Have Nigerian counsel review the Legitimate Interest Assessment before scaling._

## Principles built into the system

1. **A human sends every message**, in the platform's own app, from a real account they operate. The system drafts, validates, opens and pre-fills; it never presses Send. (`domain/channels.ts` declares each channel's mode; there are no `automated` sending channels today.)
2. **No scraping or evasion.** Discovery uses official APIs (Instagram Graph), openly licensed data (OpenStreetMap ODbL, Foursquare Apache 2.0), your own lists, and human capture. No CAPTCHA bypass, no stealth browsers, no fake accounts, no login automation.
3. **Human pace.** Per-sender daily caps with warm-up (Settings → Sender accounts), enforced server-side at mark-sent time and in the extension.
4. **Opt-outs are permanent and immediate.** Replies are checked by deterministic rules first; any "stop / don't contact / remove me / who gave you my number" moves the prospect to DO_NOT_CONTACT, writes suppression entries for every identifier, cancels follow-ups, and blocks drafts. Re-discovery or re-import of the same handle/phone/email is skipped.
5. **No deception.** The validator blocks fake familiarity, invented social proof and claims not supported by data. Messages say plainly who is writing and what Orbit is.
6. **Global kill switch.** *Pause all outreach* (top bar) blocks approvals and sending everywhere and returns approved messages to review.
7. **Audit trail.** Every approval, send, reply, status change, suppression and conversion is logged with who and when (Settings → Audit log).

## Platform rules (summary)

| Platform | Rule we follow |
|---|---|
| Instagram | No API for starting DMs → human sends. Keep volume human (80–100/day/account suggested). Graph API used only for reading public business profiles. |
| TikTok | No messaging/discovery API → human sends; many accounts only accept DMs from mutual follows. |
| WhatsApp | Cloud API needs prior opt-in → not used for first contact. `wa.me` click-to-chat with a human pressing send. Mass unsolicited messages risk a number ban. |
| Email | Only from your own mailbox via OAuth, 1:1, after human review. Every email gets a footer with sender name, business, postal address and a one-click unsubscribe link plus List-Unsubscribe headers. Country rules (Settings → Country rules) are checked before every send: Nigeria allowed under NDPA s.25 legitimate interest with a documented LIA; South Africa (POPIA s.69), Ghana (DPA s.40) and Kenya (DPA s.37) require consent, so cold email is blocked. Each campaign needs an admin-confirmed compliance checklist. Bounces, complaints and unsubscribes are suppressed workspace-wide. ESPs like Resend/Postmark are not used for cold email (their AUPs forbid it). |
| LinkedIn | Manual only. |

## Nigeria Data Protection Act 2023 (NDPA)

- **Lawful basis:** legitimate interest (s.25) for contacting businesses that publicly advertise their contact details for bookings. Requires a documented **Legitimate Interest Assessment** — template below.
- **Transparency:** if asked "where did you get my number?", answer honestly (e.g. "your Instagram bio") — the prospect page shows the source and evidence for every field.
- **Objection:** honoured immediately and permanently (DNC system).
- **Minimisation:** only business-relevant public fields are stored. Raw CSV files are deleted from job payloads after import. Captions fetched during discovery are analysed for signals, not stored.
- **Retention:** recommended — delete prospects with no engagement after 12 months (planned as a scheduled job; see roadmap).
- **Access/deletion requests:** find the prospect (search by handle/phone/email), export or delete; the suppression entry should be kept so they aren't re-added.

### Legitimate Interest Assessment (template)

| Question | Answer |
|---|---|
| Purpose | Offer a relevant business tool (Orbit) to service businesses that advertise bookings publicly. |
| Necessity | Contacting businesses through the channels they publish for enquiries is the least intrusive way to reach them; no sensitive data is processed. |
| Data | Business name, public handle(s), public business phone/email/website, city, category, public bio text, follower count, posting recency. |
| Reasonable expectations | Businesses that publish "DM to book" / a WhatsApp number expect business enquiries. |
| Safeguards | Human-sent, low volume, personalised, honest; immediate permanent opt-out; no sensitive data; audit log; access controls; encrypted secrets. |
| Balancing | Low impact on the individual; easy objection; clear benefit offered. Conclusion: legitimate interest applies, subject to the safeguards above. |
| Review | Re-assess every 6 months or when channels/volumes change materially. |
