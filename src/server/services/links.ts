import { randomBytes } from "node:crypto";
import { sql, json, type Q } from "../db";

/**
 * Tracked links: /r/<code> → product signup URL with UTM params and an opaque
 * ref code. No personal data in the URL; the code maps to the prospect here.
 * The product (Orbit) echoes `ob_ref` back in its conversion webhook.
 */

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newCode(len = 8): string {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");
}

export function productSignupUrl(workspaceUrl: string | null | undefined): string {
  return workspaceUrl || process.env.PRODUCT_SIGNUP_URL || "https://app.getorbitcrm.com/signup";
}

export async function createTrackedLink(
  q: Q,
  o: { workspaceId: string; prospectId: string | null; campaignId: string | null; variantId: string | null; channel: string | null; destination: string | null },
): Promise<{ id: string; code: string; url: string }> {
  const meta = await q.maybe<{ slug: string | null; key: string | null }>(sql`
    select (select slug from campaigns where id = ${o.campaignId}) as slug, (select key from message_variants where id = ${o.variantId}) as key`);
  const utm: Record<string, string> = { utm_source: o.channel ?? "outbound", utm_medium: "outbound" };
  if (meta?.slug) utm.utm_campaign = meta.slug.replace(/-/g, "_");
  if (meta?.key) utm.utm_content = `message_${meta.key.toLowerCase()}`;
  // Reuse an existing link for the same prospect + campaign + channel.
  const existing = await q.maybe<{ id: string; code: string }>(sql`
    select id, code from tracked_links where prospect_id is not distinct from ${o.prospectId} and campaign_id is not distinct from ${o.campaignId}
      and channel is not distinct from ${o.channel} limit 1`);
  if (existing) return { ...existing, url: `${appUrl()}/r/${existing.code}` };
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const row = await q.maybe<{ id: string }>(sql`
      insert into tracked_links (workspace_id, code, campaign_id, prospect_id, variant_id, channel, destination_url, utm)
      values (${o.workspaceId}, ${code}, ${o.campaignId}, ${o.prospectId}, ${o.variantId}, ${o.channel}, ${productSignupUrl(o.destination)}, ${json(utm)})
      on conflict (code) do nothing returning id`);
    if (row) return { id: row.id, code, url: `${appUrl()}/r/${code}` };
  }
  throw new Error("Could not allocate a link code");
}

export function destinationFor(link: { destination_url: string; utm: Record<string, string>; code: string }): string {
  const u = new URL(link.destination_url);
  for (const [k, v] of Object.entries(link.utm ?? {})) u.searchParams.set(k, v);
  u.searchParams.set("ob_ref", link.code);
  return u.toString();
}

const BOT_UA = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|slackbot|telegram|twitterbot|linkedinbot|discord|curl|wget|python-requests|headless/i;

export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}
