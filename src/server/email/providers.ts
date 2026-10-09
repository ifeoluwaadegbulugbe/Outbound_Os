import { sql, type Q } from "../db";

/** Opens a short workspace transaction. Providers never hold one across HTTP calls. */
export type Run = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
import { decryptSecret, encryptSecret } from "../auth/crypto";
import { buildMime, newMessageId, type OutgoingEmail } from "./mime";
import { domainOfEmail } from "./address";

/**
 * Email sending providers. Outbound prospecting is sent ONLY through the
 * user's own connected mailbox via official APIs (OAuth):
 *   - gmail      Gmail API users.messages.send   (scope gmail.send; replies need gmail.readonly)
 *   - microsoft  Microsoft Graph create+send      (Mail.ReadWrite, Mail.Send)
 *   - test_sink  development/test only — captures to test_outbox, never delivers
 * Transactional ESPs (Resend, Postmark, SendGrid, SES, Brevo) are not used for
 * prospecting: their acceptable-use policies forbid unsolicited outreach.
 */

export interface SenderAccount {
  id: string;
  workspace_id: string;
  provider: "gmail" | "microsoft" | "test_sink" | "manual";
  email_address: string | null;
  from_name: string | null;
  secret_ciphertext: string | null;
}

export interface SendResult {
  providerMessageId: string;
  threadId: string | null;
  rfcMessageId: string;
}

export interface InboundMessage {
  providerId: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: Date;
  isBounce: boolean;
  isAutoReply: boolean;
  bouncedRecipient?: string | null;
}

export class ProviderSendError extends Error {
  constructor(message: string, readonly kind: "auth" | "rate_limit" | "quota" | "invalid_recipient" | "transient" | "permanent") {
    super(message);
    this.name = "ProviderSendError";
  }
}

export function testSinkEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_TEST_SINK === "true";
}

// ── OAuth token handling ────────────────────────────────────────────────────

interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

async function accessToken(run: Run, a: SenderAccount): Promise<string> {
  if (!a.secret_ciphertext) throw new ProviderSendError("Account isn't connected — reconnect it in Data Sources → Sending accounts.", "auth");
  const tok = JSON.parse(decryptSecret(a.secret_ciphertext)) as StoredToken;
  if (tok.access_token && tok.expires_at && tok.expires_at > Date.now() + 60_000) return tok.access_token;
  const cfg = a.provider === "gmail"
    ? { url: "https://oauth2.googleapis.com/token", id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET }
    : { url: "https://login.microsoftonline.com/common/oauth2/v2.0/token", id: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET };
  if (!cfg.id || !cfg.secret) throw new ProviderSendError(`${a.provider === "gmail" ? "GOOGLE" : "MS"}_CLIENT_ID/SECRET are not configured.`, "auth");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, grant_type: "refresh_token", refresh_token: tok.refresh_token }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new ProviderSendError(`Couldn't refresh ${a.provider} access (${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ""}). Reconnect the account.`, "auth");
  }
  const next: StoredToken = { refresh_token: body.refresh_token ?? tok.refresh_token, access_token: body.access_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
  await run((q) => q.exec(sql`update sender_accounts set secret_ciphertext = ${encryptSecret(JSON.stringify(next))} where id = ${a.id}`));
  return body.access_token;
}

function classify(status: number, text: string): ProviderSendError["kind"] {
  if (status === 401 || status === 403 && /auth|token|scope|permission/i.test(text)) return "auth";
  if (status === 429) return /quota|limit exceeded|dailyLimit|sending limit/i.test(text) ? "quota" : "rate_limit";
  if (status === 400 && /recipient|address|invalid to/i.test(text)) return "invalid_recipient";
  if (status >= 500) return "transient";
  if (/daily|limit exceeded|quota/i.test(text)) return "quota";
  return "permanent";
}

// ── Senders ─────────────────────────────────────────────────────────────────

export async function sendEmail(run: Run, a: SenderAccount, e: OutgoingEmail, threadId?: string | null): Promise<SendResult> {
  const rfc = newMessageId(domainOfEmail(e.fromEmail));
  const mime = buildMime(e, rfc);
  if (a.provider === "test_sink") {
    if (!testSinkEnabled()) throw new ProviderSendError("The test sink is disabled in production.", "permanent");
    // Deterministic failures for testing error handling: fail-<kind>@<anything>.
    const fail = /^fail-(auth|rate_limit|quota|invalid_recipient|transient|permanent)@/.exec(e.to);
    if (fail) throw new ProviderSendError(`Test sink simulated ${fail[1].replace("_", " ")} error`, fail[1] as ProviderSendError["kind"]);
    const id = await run((q) => q.value<string>(sql`insert into test_outbox (workspace_id, sender_account_id, to_email, subject, raw_mime) values (${a.workspace_id}, ${a.id}, ${e.to}, ${e.subject}, ${mime}) returning id`));
    return { providerMessageId: `sink_${id}`, threadId: threadId ?? `sink_thread_${id}`, rfcMessageId: rfc };
  }
  if (a.provider === "gmail") {
    const token = await accessToken(run, a);
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderSendError(`Gmail ${res.status}: ${text.slice(0, 300)}`, classify(res.status, text));
    const body = JSON.parse(text) as { id: string; threadId: string };
    return { providerMessageId: body.id, threadId: body.threadId, rfcMessageId: rfc };
  }
  if (a.provider === "microsoft") {
    const token = await accessToken(run, a);
    // Create from MIME (keeps List-Unsubscribe headers), then send — this returns ids, sendMail doesn't.
    const create = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: Buffer.from(mime, "utf8").toString("base64"),
      signal: AbortSignal.timeout(30_000),
    });
    const ctext = await create.text();
    if (!create.ok) throw new ProviderSendError(`Outlook ${create.status}: ${ctext.slice(0, 300)}`, classify(create.status, ctext));
    const draft = JSON.parse(ctext) as { id: string; conversationId: string };
    const send = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${draft.id}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Length": "0" }, signal: AbortSignal.timeout(30_000) });
    if (!send.ok) {
      const t = await send.text();
      throw new ProviderSendError(`Outlook ${send.status}: ${t.slice(0, 300)}`, classify(send.status, t));
    }
    return { providerMessageId: draft.id, threadId: draft.conversationId, rfcMessageId: rfc };
  }
  throw new ProviderSendError("This account can't send email automatically (manual account).", "permanent");
}

// ── Reply / bounce sync ─────────────────────────────────────────────────────

function decodePart(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }

function gmailText(p: GmailPart): string {
  if (p.mimeType === "text/plain" && p.body?.data) return decodePart(p.body.data);
  for (const c of p.parts ?? []) {
    const t = gmailText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) return decodePart(p.body.data).replace(/<[^>]+>/g, " ");
  return "";
}

export function isBounceSender(from: string): boolean {
  return /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from);
}

export function isAutoReply(headers: Record<string, string>, subject: string): boolean {
  return /auto-replied|auto-generated/i.test(headers["auto-submitted"] ?? "") || /^(auto(matic)? reply|out of (the )?office|ooo\b|away from)/i.test(subject) || Boolean(headers["x-autoreply"]) || /^(bulk|auto_reply)$/i.test(headers["precedence"] ?? "");
}

export function bouncedRecipientFrom(text: string): string | null {
  const m = /(?:Final-Recipient|Original-Recipient):\s*rfc822;\s*([^\s]+)/i.exec(text) ?? /(?:delivery to|wasn't delivered to|couldn't be delivered to|could not be delivered to)\s+<?([^\s>]+@[^\s>]+)>?/i.exec(text);
  return m ? m[1].toLowerCase().replace(/[.,;]$/, "") : null;
}

/** New inbound messages (replies + bounces) on the given threads since a time. */
export async function fetchThreadReplies(run: Run, a: SenderAccount, threadIds: string[], since: Date): Promise<InboundMessage[]> {
  const me = (a.email_address ?? "").toLowerCase();
  const out: InboundMessage[] = [];
  if (a.provider === "test_sink") return out; // nothing arrives in the sink; tests inject replies directly
  const token = await accessToken(run, a);
  for (const tid of threadIds) {
    if (a.provider === "gmail") {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(tid)}?format=full`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) continue;
      if (!res.ok) throw new ProviderSendError(`Gmail sync ${res.status}: ${(await res.text()).slice(0, 200)}`, classify(res.status, ""));
      const t = (await res.json()) as { messages?: { id: string; internalDate: string; payload: GmailPart }[] };
      for (const m of t.messages ?? []) {
        const at = new Date(Number(m.internalDate));
        if (at <= since) continue;
        const h = Object.fromEntries((m.payload.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
        const from = h["from"] ?? "";
        if (from.toLowerCase().includes(me)) continue; // our own message
        const text = gmailText(m.payload);
        const bounce = isBounceSender(from) || /multipart\/report/i.test(h["content-type"] ?? "");
        out.push({ providerId: m.id, threadId: tid, from, subject: h["subject"] ?? "", text, receivedAt: at, isBounce: bounce, isAutoReply: isAutoReply(h, h["subject"] ?? ""), bouncedRecipient: bounce ? bouncedRecipientFrom(text) : null });
      }
    } else if (a.provider === "microsoft") {
      const u = new URL("https://graph.microsoft.com/v1.0/me/messages");
      u.searchParams.set("$filter", `conversationId eq '${tid.replace(/'/g, "''")}' and receivedDateTime gt ${since.toISOString()}`);
      u.searchParams.set("$select", "id,from,subject,body,receivedDateTime,internetMessageHeaders");
      const res = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new ProviderSendError(`Outlook sync ${res.status}: ${(await res.text()).slice(0, 200)}`, classify(res.status, ""));
      const body = (await res.json()) as { value: { id: string; from?: { emailAddress?: { address?: string; name?: string } }; subject: string; body?: { content?: string }; receivedDateTime: string; internetMessageHeaders?: { name: string; value: string }[] }[] };
      for (const m of body.value) {
        const from = m.from?.emailAddress?.address ?? "";
        if (from.toLowerCase() === me) continue;
        const h = Object.fromEntries((m.internetMessageHeaders ?? []).map((x) => [x.name.toLowerCase(), x.value]));
        const text = m.body?.content ?? "";
        const bounce = isBounceSender(`${m.from?.emailAddress?.name ?? ""} ${from}`);
        out.push({ providerId: m.id, threadId: tid, from, subject: m.subject, text, receivedAt: new Date(m.receivedDateTime), isBounce: bounce, isAutoReply: isAutoReply(h, m.subject), bouncedRecipient: bounce ? bouncedRecipientFrom(text) : null });
      }
    }
  }
  return out;
}

/** Bounce notifications that don't land in the original thread (Gmail search). */
export async function fetchRecentBounces(run: Run, a: SenderAccount, since: Date): Promise<InboundMessage[]> {
  if (a.provider !== "gmail") return [];
  const token = await accessToken(run, a);
  const query = `from:(mailer-daemon OR postmaster) after:${Math.floor(since.getTime() / 1000)}`;
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return [];
  const list = (await res.json()) as { messages?: { id: string; threadId: string }[] };
  const out: InboundMessage[] = [];
  for (const m of list.messages ?? []) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) continue;
    const msg = (await r.json()) as { id: string; threadId: string; internalDate: string; payload: GmailPart };
    const h = Object.fromEntries((msg.payload.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    const text = gmailText(msg.payload);
    out.push({ providerId: msg.id, threadId: msg.threadId, from: h["from"] ?? "", subject: h["subject"] ?? "", text, receivedAt: new Date(Number(msg.internalDate)), isBounce: true, isAutoReply: false, bouncedRecipient: bouncedRecipientFrom(text) });
  }
  return out;
}
