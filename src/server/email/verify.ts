import { resolveMx, resolve4, resolve6, Resolver as DnsResolver } from "node:dns/promises";
import { normalizeAddress, isDisposable, isRoleAddress, domainOfEmail } from "./address";

/**
 * Email verification. Two tiers:
 *  1. Built-in (free): syntax, disposable domain, DNS MX/A lookup. This can
 *     prove an address is INVALID (no mail server) but can never prove it
 *     exists — passing results are "unknown", never "verified".
 *  2. ZeroBounce API (when ZEROBOUNCE_API_KEY is set): mailbox-level result,
 *     catch-all detection, risky classification.
 * We never send probe emails to discover validity.
 */

export type VerificationStatus = "verified" | "unknown" | "catch_all" | "risky" | "invalid";

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  provider: "dns" | "zerobounce";
  reason: string;
  checks: { syntax: boolean; disposable: boolean; role: boolean; mx: boolean | null };
  raw?: unknown;
  checkedAt: string;
}

export interface Resolver {
  mx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  a(domain: string): Promise<string[]>;
}

const systemResolver: Resolver = {
  mx: (d) => resolveMx(d),
  a: async (d) => {
    try {
      return await resolve4(d);
    } catch {
      return resolve6(d);
    }
  },
};

const pub = new DnsResolver({ timeout: 5000, tries: 2 });
pub.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
const publicResolver: Resolver = {
  mx: (d) => pub.resolveMx(d),
  a: async (d) => {
    try {
      return await pub.resolve4(d);
    } catch {
      return pub.resolve6(d);
    }
  },
};

const mxCache = new Map<string, { ok: boolean | null; at: number }>();

async function hasMailServer(domain: string, resolver: Resolver): Promise<boolean | null> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.ok;
  let ok: boolean | null;
  try {
    const mx = await resolver.mx(domain);
    // RFC 7505 null MX ("." exchange) means the domain accepts no mail.
    ok = mx.length > 0 && !mx.every((r) => r.exchange === "" || r.exchange === ".");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "ENONAME") {
      // No MX → RFC 5321 implicit MX: fall back to an A/AAAA record.
      try {
        ok = (await resolver.a(domain)).length > 0;
      } catch {
        ok = false;
      }
    } else if (resolver === systemResolver && (code === 'ECONNREFUSED' || code === 'ESERVFAIL' || code === 'ETIMEOUT' || code === 'ECONNRESET')) {
      // The OS resolver config isn't usable from Node (common on Windows/containers): ask public resolvers.
      ok = await hasMailServer(domain, publicResolver).catch(() => null);
      mxCache.delete(domain);
    } else ok = null; // timeout / SERVFAIL — we genuinely don't know
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

export async function verifyBasic(raw: string, resolver: Resolver = systemResolver): Promise<VerificationResult> {
  const now = new Date().toISOString();
  const email = normalizeAddress(raw);
  if (!email) return { email: raw, status: "invalid", provider: "dns", reason: "Not a valid email address", checks: { syntax: false, disposable: false, role: false, mx: null }, checkedAt: now };
  const disposable = isDisposable(email);
  const role = isRoleAddress(email);
  const mx = await hasMailServer(domainOfEmail(email), resolver);
  const checks = { syntax: true, disposable, role, mx };
  if (disposable) return { email, status: "risky", provider: "dns", reason: "Disposable email domain", checks, checkedAt: now };
  if (mx === false) return { email, status: "invalid", provider: "dns", reason: "Domain has no mail server", checks, checkedAt: now };
  return {
    email, status: "unknown", provider: "dns", checks, checkedAt: now,
    reason: mx === null ? "Couldn't reach DNS — deliverability unknown" : "Domain accepts email; mailbox not verified (deliverability unknown)",
  };
}

/** ZeroBounce v2 single validation. Docs: https://www.zerobounce.net/docs/email-validation-api-quickstart */
export async function verifyZeroBounce(email: string, apiKey: string): Promise<VerificationResult> {
  const u = new URL("https://api.zerobounce.net/v2/validate");
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("email", email);
  u.searchParams.set("ip_address", "");
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { status?: string; sub_status?: string; error?: string; domain?: string };
  if (!res.ok || body.error) throw new Error(`ZeroBounce: ${body.error ?? res.status}`);
  const map: Record<string, VerificationStatus> = {
    valid: "verified", invalid: "invalid", "catch-all": "catch_all", unknown: "unknown", spamtrap: "risky", abuse: "risky", do_not_mail: "risky",
  };
  const status = map[body.status ?? "unknown"] ?? "unknown";
  return {
    email, status, provider: "zerobounce", raw: body, checkedAt: new Date().toISOString(),
    reason: `ZeroBounce: ${body.status}${body.sub_status ? ` (${body.sub_status})` : ""}`,
    checks: { syntax: true, disposable: body.sub_status === "disposable", role: body.sub_status === "role_based", mx: body.status !== "invalid" || body.sub_status !== "no_dns_entries" },
  };
}

export async function zeroBounceCredits(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { Credits?: string };
    const n = Number(body.Credits);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Best available verification: basic checks first; provider only when basic didn't already prove invalid. */
export async function verifyEmail(raw: string, opts: { zeroBounceKey?: string | null; resolver?: Resolver } = {}): Promise<VerificationResult> {
  const basic = await verifyBasic(raw, opts.resolver);
  if (basic.status === "invalid" || basic.status === "risky" || !opts.zeroBounceKey) return basic;
  try {
    return await verifyZeroBounce(basic.email, opts.zeroBounceKey);
  } catch (e) {
    return { ...basic, reason: `${basic.reason}. Provider check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
