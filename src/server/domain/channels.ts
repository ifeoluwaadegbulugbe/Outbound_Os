import type { Channel } from "./taxonomy";

/**
 * Channel registry: the single source of truth for what the system is
 * allowed to do on each platform (see docs/integration-feasibility.md).
 *
 * mode:
 *   automated — the system may send through an official API (none today)
 *   assisted  — the system prepares + opens the conversation pre-filled;
 *               a human presses Send
 *   manual    — the system prepares the text; a human opens and sends
 */

export type SendMode = "automated" | "assisted" | "manual";

export interface ChannelSpec {
  key: Channel;
  label: string;
  mode: SendMode;
  /** Can the conversation be opened with the text already in the box? */
  prefill: "url" | "extension" | "none";
  maxChars: number;
  idealChars: number;
  defaultDailyCap: number;
  requiresOptOutLine: boolean;
  needs: "instagram_handle" | "tiktok_handle" | "phone" | "email" | "linkedin_url" | "facebook_url";
  note: string;
}

export const CHANNEL_SPECS: Record<Channel, ChannelSpec> = {
  instagram: {
    key: "instagram", label: "Instagram", mode: "assisted", prefill: "extension", maxChars: 1000, idealChars: 320,
    defaultDailyCap: 80, requiresOptOutLine: false, needs: "instagram_handle",
    note: "No official API for starting DMs. The browser extension opens the DM and fills the draft; you press Send.",
  },
  tiktok: {
    key: "tiktok", label: "TikTok", mode: "assisted", prefill: "extension", maxChars: 600, idealChars: 280,
    defaultDailyCap: 50, requiresOptOutLine: false, needs: "tiktok_handle",
    note: "No messaging API. The extension opens the profile; click Message and the draft fills in; you press Send.",
  },
  whatsapp: {
    key: "whatsapp", label: "WhatsApp", mode: "assisted", prefill: "url", maxChars: 1000, idealChars: 350,
    defaultDailyCap: 80, requiresOptOutLine: false, needs: "phone",
    note: "wa.me opens the chat with the message pre-typed; you press Send. The Cloud API needs opt-in, so it isn't used for first contact.",
  },
  email: {
    key: "email", label: "Email", mode: "automated", prefill: "url", maxChars: 2000, idealChars: 700,
    defaultDailyCap: 50, requiresOptOutLine: false, needs: "email",
    note: "Sent from your connected Gmail/Outlook mailbox after you approve it. Sender details and a one-click unsubscribe link are added automatically.",
  },
  linkedin: {
    key: "linkedin", label: "LinkedIn", mode: "manual", prefill: "none", maxChars: 300, idealChars: 280,
    defaultDailyCap: 20, requiresOptOutLine: false, needs: "linkedin_url",
    note: "Messaging API is partner-only. Copy the message, open the profile, send manually.",
  },
  facebook: {
    key: "facebook", label: "Facebook", mode: "manual", prefill: "none", maxChars: 1000, idealChars: 320,
    defaultDailyCap: 30, requiresOptOutLine: false, needs: "facebook_url",
    note: "Messenger API can't start conversations. Copy, open, send manually.",
  },
};

export interface ContactTarget {
  instagram_handle: string | null;
  tiktok_handle: string | null;
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  linkedin_url?: string | null;
  facebook_url?: string | null;
}

export function channelAvailable(ch: Channel, p: ContactTarget): boolean {
  switch (CHANNEL_SPECS[ch].needs) {
    case "instagram_handle":
      return Boolean(p.instagram_handle);
    case "tiktok_handle":
      return Boolean(p.tiktok_handle);
    case "phone":
      return Boolean(p.whatsapp || p.phone);
    case "email":
      return Boolean(p.email);
    case "linkedin_url":
      return Boolean(p.linkedin_url);
    case "facebook_url":
      return Boolean(p.facebook_url);
  }
}

/** Pick the best available channel from a preference list. */
export function pickChannel(preferred: readonly string[], p: ContactTarget): Channel | null {
  for (const c of preferred) if (c in CHANNEL_SPECS && channelAvailable(c as Channel, p)) return c as Channel;
  return null;
}

/** URL that opens the conversation (pre-filled where the platform allows it). */
export function openUrl(ch: Channel, p: ContactTarget, body: string, subject?: string | null): string | null {
  switch (ch) {
    case "whatsapp": {
      const num = (p.whatsapp || p.phone || "").replace(/\D/g, "");
      return num ? `https://wa.me/${num}?text=${encodeURIComponent(body)}` : null;
    }
    case "instagram":
      // ig.me/m/<handle> opens a DM thread; the extension fills the composer.
      return p.instagram_handle ? `https://ig.me/m/${p.instagram_handle}` : null;
    case "tiktok":
      return p.tiktok_handle ? `https://www.tiktok.com/@${p.tiktok_handle}` : null;
    case "email":
      return p.email
        ? `mailto:${p.email}?subject=${encodeURIComponent(subject ?? "")}&body=${encodeURIComponent(body)}`
        : null;
    case "linkedin":
      return p.linkedin_url ?? null;
    case "facebook":
      return p.facebook_url ?? null;
  }
}

export function profileUrl(ch: "instagram" | "tiktok", handle: string): string {
  return ch === "instagram" ? `https://www.instagram.com/${handle}/` : `https://www.tiktok.com/@${handle}`;
}

/**
 * Effective daily cap with warm-up: starts at startCap and grows by step
 * every 7 days until it reaches the account's configured cap.
 */
export function effectiveDailyCap(
  a: { daily_cap: number; warmup_enabled: boolean; warmup_start_cap: number; warmup_step: number; warmup_started_on: Date | string },
  today = new Date(),
): number {
  if (!a.warmup_enabled) return a.daily_cap;
  const start = new Date(a.warmup_started_on);
  const weeks = Math.max(0, Math.floor((today.getTime() - start.getTime()) / (7 * 86_400_000)));
  return Math.min(a.daily_cap, a.warmup_start_cap + weeks * a.warmup_step);
}
