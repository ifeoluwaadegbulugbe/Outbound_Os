import { extractEmails, rankEmails, isRoleAddress } from "./address";
import { domainOf } from "../domain/normalize";

/**
 * Finds publicly listed business emails on a business's OWN website:
 * homepage + up to 4 contact/about/booking pages on the same host.
 * - Respects robots.txt (User-agent: * and our UA).
 * - One request at a time per site, short timeouts, small size cap.
 * - Never guesses addresses (no info@domain fabrication) — only what's published.
 * - Not used against social networks or directories whose terms forbid it.
 */

export const USER_AGENT = "OutboundOS-ContactFinder/0.1 (+business contact lookup; respects robots.txt)";
const MAX_PAGES = 5;
const MAX_BYTES = 1_500_000;
const BLOCKED_HOSTS = /(^|\.)(instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|twitter\.com|x\.com|google\.[a-z.]+|maps\.app\.goo\.gl|linktr\.ee|wa\.me|whatsapp\.com|youtube\.com)$/;

export interface FinderResult {
  emails: { email: string; sourceUrl: string; how: string; isRole: boolean }[];
  pagesFetched: string[];
  blockedByRobots: string[];
  error: string | null;
  bookingUrl: string | null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchText(url: string, fetcher: Fetcher): Promise<{ ok: boolean; status: number; text: string; finalUrl: string; type: string }> {
  const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !/text\/html|text\/plain|application\/xhtml/.test(type)) return { ok: false, status: res.status, text: "", finalUrl: res.url || url, type };
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const dec = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += dec.decode(value, { stream: true });
      if (total > MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } else text = await res.text();
  return { ok: true, status: res.status, text, finalUrl: res.url || url, type };
}

/** Minimal robots.txt evaluation for our UA and "*". */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of robotsTxt.split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim();
    if (!l) continue;
    const [k, ...rest] = l.split(":");
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === "allow" || key === "disallow")) {
      if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val });
      lastWasAgent = false;
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && USER_AGENT.toLowerCase().includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!mine) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of mine.rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp(`^${pattern}`).test(path) && (!best || r.path.length > best.len)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

const CONTACT_LINK = /contact|about|reach|enquir|inquir|book|appointment|get-in-touch|find-us|location|support|hello/i;

function candidateLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, label] = m;
    if (!CONTACT_LINK.test(href) && !CONTACT_LINK.test(label.replace(/<[^>]+>/g, ""))) continue;
    try {
      const u = new URL(href, base);
      if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      if (!out.includes(u.toString())) out.push(u.toString());
    } catch {
      /* bad href */
    }
  }
  return out;
}

function findBookingLink(html: string, base: URL): string | null {
  const m = /href\s*=\s*["'](https?:\/\/[^"']*(calendly\.com|fresha\.com|booksy\.com|setmore\.com|square\.site|acuityscheduling\.com|vagaro\.com|simplybook\.me|tidycal\.com|zcal\.co|getorbitcrm\.com)[^"']*)["']/i.exec(html);
  if (m) return m[1];
  for (const l of candidateLinks(html, base)) if (/book|appointment/i.test(l)) return l;
  return null;
}

export async function findEmailsOnWebsite(website: string, fetcher: Fetcher = fetch): Promise<FinderResult> {
  const result: FinderResult = { emails: [], pagesFetched: [], blockedByRobots: [], error: null, bookingUrl: null };
  let start: URL;
  try {
    start = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  } catch {
    return { ...result, error: "Invalid website URL" };
  }
  if (BLOCKED_HOSTS.test(start.hostname)) return { ...result, error: "Social/directory URL — not a business website" };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(start.hostname)) return { ...result, error: "Private address" };

  let robots = "";
  try {
    const r = await fetchText(`${start.origin}/robots.txt`, fetcher);
    if (r.ok) robots = r.text;
  } catch {
    /* no robots.txt → allowed */
  }
  const queue = [start.toString()];
  const seen = new Set<string>();
  const found = new Map<string, { sourceUrl: string; how: string }>();
  while (queue.length && result.pagesFetched.length < MAX_PAGES) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const path = new URL(url).pathname || "/";
    if (robots && !robotsAllows(robots, path)) {
      result.blockedByRobots.push(url);
      continue;
    }
    try {
      const page = await fetchText(url, fetcher);
      if (!page.ok) {
        if (result.pagesFetched.length === 0) result.error = `Website returned ${page.status}`;
        continue;
      }
      result.pagesFetched.push(page.finalUrl);
      for (const f of extractEmails(page.text)) if (!found.has(f.email)) found.set(f.email, { sourceUrl: page.finalUrl, how: f.how });
      const base = new URL(page.finalUrl);
      result.bookingUrl ??= findBookingLink(page.text, base);
      if (result.pagesFetched.length === 1) for (const l of candidateLinks(page.text, base).slice(0, MAX_PAGES - 1)) queue.push(l);
      await new Promise((r) => setTimeout(r, 400)); // be gentle
    } catch (e) {
      if (result.pagesFetched.length === 0) result.error = e instanceof Error ? (e.name === "TimeoutError" ? "Website timed out" : e.message) : String(e);
    }
  }
  const ranked = rankEmails([...found.keys()], domainOf(start.toString()));
  result.emails = ranked.slice(0, 5).map((email) => ({ email, ...found.get(email)!, isRole: isRoleAddress(email) }));
  if (result.pagesFetched.length && !result.emails.length) result.error = null;
  return result;
}
