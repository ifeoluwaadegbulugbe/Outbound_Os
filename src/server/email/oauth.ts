import { randomBytes } from "node:crypto";
import { sql, type Q } from "../db";
import { encryptSecret, decryptSecret } from "../auth/crypto";
import { appUrl } from "../services/links";

/**
 * OAuth 2.0 connection for sending mailboxes (authorization-code flow with
 * offline access). Only refresh tokens are stored, encrypted (AES-256-GCM).
 * Users never give us a mailbox password.
 */

export type MailProvider = "gmail" | "microsoft";

const SCOPES: Record<MailProvider, string[]> = {
  // gmail.readonly lets us detect replies and bounces on our own threads.
  gmail: ["openid", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
  microsoft: ["offline_access", "openid", "email", "User.Read", "Mail.Send", "Mail.ReadWrite"],
};

export function providerConfigured(p: MailProvider): boolean {
  return p === "gmail" ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) : Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

export function redirectUri(p: MailProvider): string {
  return `${appUrl()}/api/email/oauth/${p}/callback`;
}

export function buildAuthUrl(p: MailProvider, state: { workspaceId: string; userId: string }): string {
  const encState = encryptSecret(JSON.stringify({ ...state, p, exp: Date.now() + 10 * 60_000, n: randomBytes(8).toString("hex") }));
  if (p === "gmail") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
    u.searchParams.set("redirect_uri", redirectUri(p));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.gmail.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", encState);
    return u.toString();
  }
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.searchParams.set("client_id", process.env.MS_CLIENT_ID!);
  u.searchParams.set("redirect_uri", redirectUri(p));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", SCOPES.microsoft.join(" "));
  u.searchParams.set("state", encState);
  return u.toString();
}

export function readState(state: string): { workspaceId: string; userId: string; p: MailProvider } | null {
  try {
    const s = JSON.parse(decryptSecret(state)) as { workspaceId: string; userId: string; p: MailProvider; exp: number };
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function decodeJwtEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string; preferred_username?: string };
    return (payload.email ?? payload.preferred_username ?? null)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export async function exchangeCode(p: MailProvider, code: string): Promise<{ email: string; refreshToken: string; name: string | null }> {
  const cfg = p === "gmail"
    ? { url: "https://oauth2.googleapis.com/token", id: process.env.GOOGLE_CLIENT_ID!, secret: process.env.GOOGLE_CLIENT_SECRET! }
    : { url: "https://login.microsoftonline.com/common/oauth2/v2.0/token", id: process.env.MS_CLIENT_ID!, secret: process.env.MS_CLIENT_SECRET! };
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, code, grant_type: "authorization_code", redirect_uri: redirectUri(p), ...(p === "microsoft" ? { scope: SCOPES.microsoft.join(" ") } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) throw new Error(`Authorization failed: ${body.error_description ?? body.error ?? res.status}${!body.refresh_token && res.ok ? " (no refresh token — remove the app's access in your account settings and connect again)" : ""}`);
  let email = decodeJwtEmail(body.id_token);
  let name: string | null = null;
  if (p === "microsoft" && body.access_token) {
    const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", { headers: { Authorization: `Bearer ${body.access_token}` } });
    if (me.ok) {
      const j = (await me.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
      email = (j.mail ?? j.userPrincipalName ?? email)?.toLowerCase() ?? null;
      name = j.displayName ?? null;
    }
  }
  if (!email) throw new Error("Couldn't read the mailbox address from the provider.");
  return { email, refreshToken: body.refresh_token, name };
}

/** Provider-side limits (official docs, Oct 2026); the account's daily cap must stay at or below these. */
export const PROVIDER_LIMITS: Record<MailProvider, { consumer: number; business: number; note: string }> = {
  gmail: { consumer: 500, business: 2000, note: "Gmail: ~500/day for @gmail.com, ~2,000/day for Google Workspace (recipients count)." },
  microsoft: { consumer: 300, business: 10000, note: "Outlook.com free: ~300/day (lower for new accounts); Microsoft 365: 10,000 recipients/day, 30/minute." },
};

export async function saveConnectedAccount(q: Q, workspaceId: string, userId: string, p: MailProvider, r: { email: string; refreshToken: string; name: string | null }): Promise<string> {
  const free = /@(gmail|googlemail|outlook|hotmail|live)\./.test(r.email);
  const providerLimit = free ? PROVIDER_LIMITS[p].consumer : PROVIDER_LIMITS[p].business;
  const secret = encryptSecret(JSON.stringify({ refresh_token: r.refreshToken }));
  return q.value<string>(sql`
    insert into sender_accounts (workspace_id, user_id, channel, label, handle, provider, email_address, from_name, secret_ciphertext, provider_daily_limit,
                                 daily_cap, warmup_enabled, warmup_start_cap, warmup_step, warmup_started_on, status, min_interval_seconds)
    values (${workspaceId}, ${userId}, 'email', ${r.email}, ${r.email}, ${p}, ${r.email}, ${r.name}, ${secret}, ${providerLimit},
            ${free ? 50 : 100}, true, 10, 10, current_date, 'active', 90)
    on conflict (workspace_id, lower(email_address)) where email_address is not null do update set
      secret_ciphertext = excluded.secret_ciphertext, provider = excluded.provider, status = 'active', paused_reason = null, last_error = null, is_active = true
    returning id`);
}
