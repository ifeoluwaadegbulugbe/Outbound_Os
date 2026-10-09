import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { aiStatus } from "@/server/ai/providers";
import { appUrl } from "@/server/services/links";
import { PageHeader, Panel, Badge } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { timeAgo } from "@/lib/utils";
import { InstagramConnect, ExtensionSetup, WebhookSetup } from "./setup";
import { SendingAccounts, VerificationSetup } from "./email-setup";
import { senderUsage } from "@/server/services/email-metrics";
import { providerConfigured } from "@/server/email/oauth";
import { testSinkEnabled } from "@/server/email/providers";

export const metadata = { title: "Data Sources" };

type Tone = "success" | "warning" | "neutral" | "danger" | "info";
interface Card { key: string; name: string; what: string; mode: string; status: string; tone: Tone; note: string }

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const data = await asUser(user, async (q) => {
    const rows = await q.many<{ key: string; status: string; config: Record<string, unknown>; secret_ciphertext: string | null; last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(sql`
      select key, status, config, secret_ciphertext, last_success_at, last_error, last_error_at from integrations`);
    const logs = await q.many<{ id: number; integration_key: string; level: string; message: string; response_status: number | null; duration_ms: number | null; created_at: Date }>(sql`
      select id, integration_key, level, message, response_status, duration_ms, created_at from integration_logs order by created_at desc limit 15`);
    const hashtagBudget = await q.value<number>(sql`select count(*)::int from hashtag_queries where first_queried_at > now() - interval '7 days'`);
    const candidates = await q.one<{ pending: number; looked_up: number }>(sql`select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'looked_up')::int as looked_up from discovery_candidates`);
    const accounts = await senderUsage(q);
    const emailCoverage = await q.one<{ with_website: number; checked: number; found: number; verified: number }>(sql`
      select count(*) filter (where website is not null)::int as with_website, count(*) filter (where website_checked_at is not null)::int as checked,
        count(*) filter (where email_source = 'website')::int as found, count(*) filter (where email_status = 'verified')::int as verified
      from prospects where not is_demo and merged_into is null`);
    return { rows: new Map(rows.map((r) => [r.key, r])), logs, hashtagBudget, candidates, accounts, emailCoverage };
  });
  const ai = aiStatus();
  const ig = data.rows.get("instagram_graph");
  const ext = data.rows.get("browser_extension");
  const hook = data.rows.get("conversions_webhook");
  const zb = data.rows.get("zerobounce");
  const mailAccounts = data.accounts.filter((a) => a.provider === "gmail" || a.provider === "microsoft");
  const cov = data.emailCoverage;

  const cards: Card[] = [
    { key: "instagram_graph", name: "Instagram (official API)", what: "Discovery: hashtags → mentions → Business Discovery profile lookups", mode: "Automated (permitted)",
      status: ig?.status === "connected" ? `Connected · @${String(ig.config.username ?? "")}` : "Needs setup", tone: ig?.status === "connected" ? "success" : "warning",
      note: ig?.last_error ? `Last error ${timeAgo(ig.last_error_at)}: ${ig.last_error}` : `${data.hashtagBudget}/30 hashtags used this week · ${data.candidates.pending} handles queued · ${data.candidates.looked_up} looked up` },
    { key: "osm_overpass", name: "OpenStreetMap", what: "Discovery: mapped salons, barbers, spas, studios", mode: "Automated (permitted, ODbL)", status: "Ready", tone: "success",
      note: `Endpoint: ${process.env.OVERPASS_URL ?? "overpass-api.de (public, low volume)"}` },
    { key: "csv_import", name: "CSV / Foursquare Open Places", what: "Import your lists or open datasets", mode: "Automated", status: "Ready", tone: "success", note: "Discover → Import CSV" },
    { key: "manual_capture", name: "Quick capture + bookmarklet", what: "Add profiles you find while browsing", mode: "Assisted", status: "Ready", tone: "success", note: "Discover → Quick capture" },
    { key: "browser_extension", name: "Browser extension", what: "Opens Instagram/TikTok DMs with the message typed in; you press Send", mode: "Assisted (you send)",
      status: ext?.status === "connected" ? "Token created" : "Not installed", tone: ext?.status === "connected" ? "success" : "warning", note: "Never presses Send. Respects your daily caps." },
    { key: "whatsapp_link", name: "WhatsApp (click-to-chat)", what: "Opens the chat with your message pre-typed", mode: "Assisted (you send)", status: "Ready", tone: "success", note: "Uses wa.me links from your own WhatsApp" },
    { key: "gmail", name: "Gmail / Google Workspace", what: "Sends approved emails from your mailbox; reads replies and bounces", mode: "Automated send (you approve)",
      status: mailAccounts.some((a) => a.provider === "gmail") ? "Connected" : providerConfigured("gmail") ? "Ready to connect" : "Needs OAuth client", tone: mailAccounts.some((a) => a.provider === "gmail") ? "success" : "warning",
      note: "Free. About 500/day on a personal Gmail, 2,000 on Workspace. Google's own limits apply." },
    { key: "microsoft", name: "Outlook / Microsoft 365", what: "Sends approved emails via Microsoft Graph; reads replies", mode: "Automated send (you approve)",
      status: mailAccounts.some((a) => a.provider === "microsoft") ? "Connected" : providerConfigured("microsoft") ? "Ready to connect" : "Needs OAuth client", tone: mailAccounts.some((a) => a.provider === "microsoft") ? "success" : "warning",
      note: "Free. Outlook.com ~300/day; Microsoft 365 up to 10,000 recipients/day." },
    { key: "website_email_finder", name: "Website email finder", what: "Finds public emails on businesses' own websites, with source page", mode: "Automated", status: "Ready", tone: "success",
      note: `${cov.checked} of ${cov.with_website} websites checked · ${cov.found} emails found` },
    { key: "zerobounce", name: "ZeroBounce verification", what: "Mailbox-level verification (the only way to reach 'Verified')", mode: "Optional (100 free/month)",
      status: zb?.status === "connected" || process.env.ZEROBOUNCE_API_KEY ? "Connected" : "Off", tone: zb?.status === "connected" || process.env.ZEROBOUNCE_API_KEY ? "success" : "neutral",
      note: `${cov.verified} verified so far · without it, addresses get a free DNS check (max status: deliverability unknown)` },
    { key: "esp", name: "Resend / Postmark / SendGrid / SES / Brevo", what: "Bulk email services", mode: "Not used", status: "Unavailable", tone: "neutral", note: "Their terms prohibit cold outreach, so they aren't used for prospecting." },
    { key: "conversions_webhook", name: "Orbit conversions", what: "Signup / activation / paid events from Orbit", mode: "Automated (webhook)",
      status: hook?.secret_ciphertext ? "Secret set" : "Needs setup", tone: hook?.secret_ciphertext ? "success" : "warning", note: hook?.last_success_at ? `Last event ${timeAgo(hook.last_success_at)}` : "No events received yet" },
    { key: "ai", name: "AI writing & classification", what: "Drafts, briefs, reply suggestions", mode: "Optional",
      status: ai.enabled ? ai.providers.map((p) => `${p.name} (${p.model})`).join(", ") : "Templates & rules (no AI key)", tone: ai.enabled ? "success" : "info",
      note: ai.enabled ? "Validated output; falls back to templates on failure" : "Free options: Ollama (local), Groq or Gemini free tiers — set in .env.local" },
    { key: "brave_search", name: "Brave Search API", what: "Find Instagram/TikTok profiles via web search", mode: "Optional (paid)", status: "Off", tone: "neutral", note: "Storing results needs a paid storage-rights plan. Off to keep costs at zero." },
    { key: "tiktok", name: "TikTok", what: "No commercial discovery or messaging API exists", mode: "Not available", status: "Unavailable", tone: "neutral", note: "TikTok handles are picked up from Instagram bios; DMs are sent by you" },
    { key: "whatsapp_cloud", name: "WhatsApp Cloud API", what: "Business-initiated messages need prior opt-in", mode: "Not for cold outreach", status: "Unavailable", tone: "neutral", note: "Could be enabled later for prospects who message you first" },
    { key: "linkedin", name: "LinkedIn", what: "Partner-only API; scraping is prohibited", mode: "Manual only", status: "Unavailable", tone: "neutral", note: "Store a LinkedIn URL and send manually" },
    { key: "google_places", name: "Google Maps / Places", what: "Terms prohibit building lead lists from Places data", mode: "Not used", status: "Unavailable", tone: "neutral", note: "See docs/integration-feasibility.md" },
  ];
  const isAdmin = can(user, "admin");

  return (
    <>
      <PageHeader title="Data Sources" description="Where prospects and emails come from, the mailboxes that send, and exactly what's automated, assisted or manual." />
      <div className="space-y-4 p-4 md:p-6">
        <Panel padded={false}>
          <Table>
            <thead><tr><Th>Integration</Th><Th className="hidden md:table-cell">What it does</Th><Th>Mode</Th><Th>Status</Th><Th className="hidden lg:table-cell">Notes</Th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <Tr key={c.key} id={c.key}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="hidden max-w-[260px] text-[12px] text-fg-2 md:table-cell">{c.what}</Td>
                  <Td className="whitespace-nowrap text-[12px] text-fg-2">{c.mode}</Td>
                  <Td><Badge tone={c.tone}>{c.status}</Badge></Td>
                  <Td className="hidden max-w-[320px] text-[12px] text-fg-3 lg:table-cell">{c.note}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <SendingAccounts accounts={data.accounts} canEdit={isAdmin} configured={{ gmail: providerConfigured("gmail"), microsoft: providerConfigured("microsoft") }}
          testSink={testSinkEnabled()} flash={{ connected: sp.connected, error: sp.error }} />
        <VerificationSetup canEdit={isAdmin} envKey={Boolean(process.env.ZEROBOUNCE_API_KEY)}
          zb={{ connected: zb?.status === "connected", credits: (zb?.config.credits as number | undefined) ?? null, checkedAt: (zb?.config.checkedAt as string | undefined) ?? null }} />

        <div className="grid gap-4 xl:grid-cols-2">
          <InstagramConnect connected={ig?.status === "connected"} username={(ig?.config.username as string) ?? null} canEdit={isAdmin} />
          <div className="space-y-4">
            <ExtensionSetup hasToken={ext?.status === "connected"} appUrl={appUrl()} />
            <WebhookSetup endpoint={`${appUrl()}/api/v1/conversions`} hasSecret={Boolean(hook?.secret_ciphertext)} canEdit={isAdmin} />
          </div>
        </div>

        <Panel title="Recent integration calls" padded={false}>
          {data.logs.length === 0 ? <p className="p-4 text-[12.5px] text-fg-3">No external calls yet.</p> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Integration</Th><Th>Call</Th><Th>Time</Th></tr></thead>
              <tbody>{data.logs.map((l) => (
                <Tr key={l.id}>
                  <Td className="whitespace-nowrap text-[12px] text-fg-3">{timeAgo(l.created_at)}</Td>
                  <Td className="text-[12px]">{l.integration_key}</Td>
                  <Td className="max-w-[520px] truncate text-[12px]"><Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "neutral"} className="mr-1.5">{l.response_status ?? l.level}</Badge>{l.message}</Td>
                  <Td className="text-[12px] tabular text-fg-3">{l.duration_ms != null ? `${l.duration_ms} ms` : "—"}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
