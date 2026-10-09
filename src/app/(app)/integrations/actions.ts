"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { encryptSecret } from "@/server/auth/crypto";
import { newToken, sha256 } from "@/server/auth/password";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

const IG_VERSION = process.env.IG_GRAPH_VERSION ?? "v23.0";

/**
 * Connect Instagram: verify the token against the Graph API (reads the
 * account's own username), then store it encrypted. We never ask for an
 * Instagram password — only an access token from Meta's developer tools.
 */
export async function connectInstagramAction(input: { igUserId: string; token: string; callsPerHour: number }): Promise<ActionResult> {
  const user = await requireUser("admin");
  const igUserId = z.string().regex(/^\d{5,25}$/, "Instagram account ID is a long number").safeParse(input.igUserId.trim());
  if (!igUserId.success) return { ok: false, error: igUserId.error.issues[0].message };
  const token = input.token.trim();
  if (token.length < 30) return { ok: false, error: "That doesn't look like an access token." };
  let username: string | null = null;
  try {
    const u = new URL(`https://graph.facebook.com/${IG_VERSION}/${igUserId.data}`);
    u.searchParams.set("fields", "username,followers_count");
    u.searchParams.set("access_token", token);
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { username?: string; error?: { message?: string } };
    if (!res.ok || !body.username) return { ok: false, error: `Meta rejected the token: ${body.error?.message ?? res.status}` };
    username = body.username;
  } catch (e) {
    return { ok: false, error: `Couldn't reach Meta: ${e instanceof Error ? e.message : String(e)}` };
  }
  await asUser(user, async (q) => {
    await q.exec(sql`update integrations set status = 'connected', secret_ciphertext = ${encryptSecret(token)},
      config = ${json({ igUserId: igUserId.data, username, graphVersion: IG_VERSION, callsPerHour: Math.max(10, Math.min(1000, input.callsPerHour || 180)) })},
      last_error = null where key = 'instagram_graph'`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "integration.connected", "integration", "instagram_graph", { username });
  });
  revalidatePath("/integrations");
  return { ok: true, message: `Connected @${username}` };
}

export async function disconnectAction(key: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, async (q) => {
    await q.exec(sql`update integrations set status = 'needs_setup', secret_ciphertext = null, config = '{}'::jsonb where key = ${z.string().max(50).parse(key)}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "integration.disconnected", "integration", key);
  });
  revalidatePath("/integrations");
  return { ok: true, message: "Disconnected" };
}

/** Token the browser extension uses to read the queue and mark messages sent. Shown once. */
export async function createExtensionTokenAction(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const user = await requireUser("member");
  const token = `obx_${newToken(24)}`;
  await asUser(user, async (q) => {
    const cur = await q.one<{ config: { tokens?: { hash: string; userId: string; createdAt: string }[] } }>(sql`select config from integrations where key = 'browser_extension'`);
    const tokens = (cur.config.tokens ?? []).filter((t) => t.userId !== user.userId);
    tokens.push({ hash: sha256(token), userId: user.userId, createdAt: new Date().toISOString() });
    await q.exec(sql`update integrations set status = 'connected', config = ${json({ ...cur.config, tokens })} where key = 'browser_extension'`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "extension.token_created", "integration", "browser_extension");
  });
  revalidatePath("/integrations");
  return { ok: true, token };
}

/** HMAC secret for Orbit's conversion webhook. Shown once. */
export async function rotateWebhookSecretAction(): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const user = await requireUser("admin");
  const secret = `whsec_${newToken(32)}`;
  await asUser(user, async (q) => {
    await q.exec(sql`update integrations set status = 'connected', secret_ciphertext = ${encryptSecret(secret)} where key = 'conversions_webhook'`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "webhook.secret_rotated", "integration", "conversions_webhook");
  });
  revalidatePath("/integrations");
  return { ok: true, secret };
}
