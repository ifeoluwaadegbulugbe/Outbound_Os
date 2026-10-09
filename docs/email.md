# Email: setup, sending and deliverability

Email is the primary outreach channel. Messages are sent **from your own mailbox** (Gmail / Google Workspace or Outlook / Microsoft 365) through the provider's official API. You sign in on Google's or Microsoft's page. Outbound OS never sees or stores your password, only an encrypted OAuth refresh token kept server-side.

## Why your own mailbox (and not Resend, SendGrid, etc.)

Bulk email services (Resend, Postmark, SendGrid, Amazon SES, Brevo) prohibit cold outreach in their acceptable-use policies, and accounts get suspended for it. Sending one-to-one, human-reviewed emails from a real mailbox you own is permitted, and replies land in your normal inbox.

## Limits (the system enforces the lower of your cap and the provider's)

| Mailbox | Provider limit | Default cap in Outbound OS | Warm-up |
|---|---|---|---|
| Personal Gmail | ~500 recipients/day | 50/day | 10/day, +10 per week |
| Google Workspace | ~2,000 recipients/day | 100/day | 10/day, +10 per week |
| Outlook.com (free) | ~300/day (lower for new accounts) | 50/day | 10/day, +10 per week |
| Microsoft 365 | 10,000 recipients/day, 30/minute | 100/day | 10/day, +10 per week |

Every account also keeps at least 90 seconds between sends (with jitter), sends Mon–Sat 08:00–19:00 Africa/Lagos by default (configurable per campaign), and pauses itself automatically if bounces exceed 5% or complaints exceed 0.3% of recent sends (Settings → Email & sender).

The system does **not** rotate accounts to get around limits. If you want more volume, add more real mailboxes that real people own and monitor, each with its own cap and warm-up.

## 1. Connect Gmail / Google Workspace (free)

1. Go to <https://console.cloud.google.com/> → create a project (e.g. "Outbound OS").
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **Internal** if you use Google Workspace and only your team will connect (no verification needed). Otherwise **External**.
   - Add scopes: `openid`, `email`, `.../auth/gmail.send`, `.../auth/gmail.readonly`.
   - For External apps in **Testing** mode, add every mailbox that will connect under **Test users**. Tokens issued in Testing mode **expire after 7 days**, so you'll see "Reconnect needed" weekly. Publishing removes that, but `gmail.readonly` is a restricted scope, so publishing an External app requires Google's verification and security assessment.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   - Authorised redirect URI: `{APP_URL}/api/email/oauth/gmail/callback` (e.g. `http://localhost:3100/api/email/oauth/gmail/callback`).
5. Put the client ID and secret in `.env.local` (or your host's env):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
6. Restart, then go to **Data Sources → Sending accounts → Connect Gmail**.

## 2. Connect Outlook / Microsoft 365 (free)

1. <https://entra.microsoft.com/> → **App registrations → New registration**.
   - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (the app uses the `common` endpoint).
   - Redirect URI (Web): `{APP_URL}/api/email/oauth/microsoft/callback`.
2. **Certificates & secrets → New client secret**. Copy the value.
3. **API permissions → Microsoft Graph → Delegated**: `offline_access`, `openid`, `email`, `User.Read`, `Mail.Send`, `Mail.ReadWrite`. (Mail.ReadWrite is used to read replies/bounces on your own threads.)
4. In `.env.local`:
   ```
   MS_CLIENT_ID=...
   MS_CLIENT_SECRET=...
   ```
5. Restart → **Data Sources → Sending accounts → Connect Outlook**. Microsoft 365 tenants may require an admin to consent once.

## 3. Authenticate your domain (SPF, DKIM, DMARC)

Free-mail addresses (gmail.com, outlook.com) are authenticated by the provider; nothing to do. For your own domain (e.g. `you@getorbit.ng`) add these DNS records before scaling past a handful a day. **Check DNS** on each sending account shows what's present.

| Record | Google Workspace | Microsoft 365 |
|---|---|---|
| SPF (TXT on the root) | `v=spf1 include:_spf.google.com ~all` | `v=spf1 include:spf.protection.outlook.com ~all` |
| DKIM | Admin console → Apps → Gmail → Authenticate email → generate, then add the `google._domainkey` TXT record | Defender portal → Email authentication → DKIM → enable; add the `selector1`/`selector2` CNAMEs |
| DMARC (TXT on `_dmarc`) | `v=DMARC1; p=none; rua=mailto:you@yourdomain` to start, then move to `quarantine` | same |

Only one SPF record per domain is allowed. Merge includes if you already have one.

## 4. Sender identity and compliance

- **Settings → Email & sender**: your name, business name and a real postal address. Every email gets a footer with these and a one-click unsubscribe link (plus `List-Unsubscribe` / `List-Unsubscribe-Post` headers so Gmail shows its own unsubscribe button).
- **Settings → Country rules**: checked before every send. Defaults: Nigeria allowed (NDPA 2023 s.25 legitimate interest, which needs a documented LIA); South Africa (POPIA s.69), Ghana (DPA s.40) and Kenya (DPA s.37) are consent-required, so cold email to them is blocked. Unreviewed countries are treated as consent-required. Allowing a country requires an admin acknowledgement, recorded in the audit log. This is not legal advice.
- **Campaign → Compliance checklist**: four confirmations by an admin before any email in that campaign can send.

## How sending works

1. Drafts (AI or template) land in **Send Queue → Review**. Nothing is sent automatically by default.
2. Open a draft in the **composer**: edit, regenerate, copy, save, skip, **Send test** (to yourself, subject prefixed `[Test]`), or **Send**.
3. **Send** runs every check (pause, readiness, suppression, country, verification, validation, cap, no duplicate first email), atomically claims the message (so double-clicks or two workers can't double-send), then calls the provider. The message becomes **Sent** only after the provider returns a message id. On failure the draft stays, the real provider error is shown, and nothing is marked sent.
4. **Approve & queue** puts approved emails in the paced queue. The worker sends one per account per tick, honouring caps, intervals and the send window. Transient failures retry after 10 minutes; a send interrupted mid-flight is never blindly retried (it's flagged "check your Sent folder").
5. Every ~10 minutes each connected mailbox is polled for replies and bounces on its own threads:
   - Reply → classified in **Inbox & Replies**; follow-ups stop.
   - Out-of-office → follow-ups pushed back a week.
   - Bounce → address marked invalid and suppressed, follow-ups cancelled, account safety re-evaluated.
   - 48 hours with no bounce → "Delivered (no bounce)". Mailbox APIs don't return delivery receipts, so this is labelled as presumed.
6. Unsubscribe (link or one-click header) → address suppressed workspace-wide immediately; follow-ups cancelled.

## Testing without sending real email

In development (`NODE_ENV !== production`, or `ENABLE_TEST_SINK=true`) **Data Sources → Add test mailbox (dev)** creates a sending account that stores messages in the `test_outbox` table and never delivers anything. Addresses of the form `fail-<kind>@anything` (kinds: `auth`, `rate_limit`, `quota`, `invalid_recipient`, `transient`, `permanent`) simulate provider errors. The automated tests use only this sink.

## Email verification

| Status | Meaning | Source |
|---|---|---|
| Verified | Mailbox confirmed | ZeroBounce only |
| Deliverability unknown | Domain accepts mail (or DNS couldn't be reached); mailbox not confirmed | Free DNS check |
| Catch-all | Domain accepts every address | ZeroBounce |
| Risky | Disposable domain, spam trap, abuse, do-not-mail | DNS check / ZeroBounce |
| Invalid | Bad syntax, no mail server, null MX, or bounced | DNS check / ZeroBounce / bounce |
| No email found | Nothing public was found | Website finder |

The system never guesses addresses (no `firstname@domain` patterns) and never sends probe emails to test validity. ZeroBounce: 100 free checks/month with a business-domain signup, then pay-as-you-go. Set `ZEROBOUNCE_API_KEY` or paste the key in Data Sources.
