import type { SourceAdapter, NormalizedProspect, DiscoveryParams, DiscoveryContext } from "./types";
import { integrationFetch, IntegrationError, sleep } from "./http";
import { sql } from "../db";
import { decryptSecret } from "../auth/crypto";
import { extractSignals, normalizeHandle } from "../domain/normalize";
import { suggestHashtags } from "../domain/taxonomy";

/**
 * Instagram discovery through Meta's OFFICIAL Instagram Graph API — no
 * scraping. Flow ("snowball"):
 *   1. Hashtag Search (max 30 unique hashtags / rolling 7 days) → recent media
 *      captions → @mentions become candidate handles. (The API never returns
 *      the poster's username; only what captions mention.)
 *   2. Business Discovery looks up each candidate (professional accounts only):
 *      bio, website, followers, recent posts.
 *   3. Handles mentioned in those bios/captions become new candidates.
 * Requires a connected Instagram professional account (see Integrations).
 */

const DEFAULT_VERSION = process.env.IG_GRAPH_VERSION ?? "v23.0";
const MAX_HASHTAGS_PER_WEEK = 30;
const MAX_DEPTH = 2;

export interface IgConfig {
  igUserId: string;
  token: string;
  version: string;
  callsPerHour: number;
}

export async function loadConfig(ctx: DiscoveryContext): Promise<IgConfig> {
  const row = await ctx.ws((q) => q.maybe<{ status: string; config: { igUserId?: string; graphVersion?: string; callsPerHour?: number }; secret_ciphertext: string | null }>(
    sql`select status, config, secret_ciphertext from integrations where key = 'instagram_graph'`));
  if (!row?.secret_ciphertext || !row.config.igUserId) {
    throw new IntegrationError("Instagram isn't connected yet. Go to Integrations → Instagram and add your professional account ID and access token.", null, false);
  }
  return {
    igUserId: row.config.igUserId,
    token: decryptSecret(row.secret_ciphertext),
    version: row.config.graphVersion || DEFAULT_VERSION,
    callsPerHour: Math.max(10, Math.min(1000, row.config.callsPerHour ?? 180)),
  };
}

export async function graph<T>(ctx: DiscoveryContext, cfg: IgConfig, path: string, params: Record<string, string>): Promise<T> {
  const u = new URL(`https://graph.facebook.com/${cfg.version}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", cfg.token);
  const res = await integrationFetch(u.toString(), { method: "GET" }, {
    workspaceId: ctx.workspaceId,
    integration: "instagram_graph",
    minIntervalMs: Math.ceil(3_600_000 / cfg.callsPerHour),
    maxRetries: 2,
  });
  // Back off when Meta reports we're close to the limit.
  for (const h of ["x-app-usage", "x-business-use-case-usage"]) {
    const raw = res.headers.get(h);
    if (!raw) continue;
    try {
      const usage = JSON.stringify(JSON.parse(raw));
      const pct = Math.max(...(usage.match(/"(?:call_count|total_time|total_cputime)":(\d+)/g) ?? []).map((m) => Number(m.split(":")[1])), 0);
      if (pct >= 85) {
        await ctx.log("warn", `Instagram API usage at ${pct}% — pausing 10 minutes`);
        await sleep(10 * 60_000);
      }
    } catch {
      /* header format varies */
    }
  }
  return (await res.json()) as T;
}

async function addCandidates(ctx: DiscoveryContext, handles: string[], foundVia: string, depth: number) {
  if (!handles.length) return;
  await ctx.ws(async (q) => {
    for (const h of handles) {
      await q.exec(sql`insert into discovery_candidates (workspace_id, platform, handle, found_via, depth)
                       values (${ctx.workspaceId}, 'instagram', ${h}, ${foundVia}, ${depth}) on conflict do nothing`);
    }
  });
}

export interface BusinessDiscovery {
  business_discovery?: {
    id: string;
    username: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    media?: { data: { caption?: string; timestamp?: string; permalink?: string }[] };
  };
}

export function businessToProspect(b: NonNullable<BusinessDiscovery["business_discovery"]>): NormalizedProspect {
  const media = b.media?.data ?? [];
  const times = media.map((m) => (m.timestamp ? Date.parse(m.timestamp) : NaN)).filter((t) => !Number.isNaN(t));
  const last = times.length ? new Date(Math.max(...times)) : null;
  const recent = times.filter((t) => Date.now() - t < 28 * 86_400_000).length;
  return {
    business_name: b.name?.trim() || b.username,
    instagram_handle: b.username,
    bio: b.biography ?? null,
    website: b.website ?? null,
    follower_count: b.followers_count ?? null,
    following_count: b.follows_count ?? null,
    media_count: b.media_count ?? null,
    last_post_date: last,
    posting_frequency: times.length ? Math.round((recent / 4) * 10) / 10 : null,
    extra_text: media.map((m) => m.caption ?? "").join("\n").slice(0, 4000),
    source: "instagram_graph",
    source_url: `https://www.instagram.com/${b.username}/`,
    external_id: `ig:${b.id}`,
  };
}

export const instagramAdapter: SourceAdapter = {
  info: {
    key: "instagram_graph",
    label: "Instagram (official API)",
    description: "Finds Instagram business accounts via hashtags and mentions, then reads their public profile through Meta's Business Discovery API. No scraping.",
    mode: "automated",
    status: "needs_setup",
  },
  async *discover(params: DiscoveryParams, ctx: DiscoveryContext) {
    const cfg = await loadConfig(ctx);

    // 1. Seeds
    await addCandidates(ctx, (params.seedHandles ?? []).map((h) => normalizeHandle(h)).filter(Boolean) as string[], "seed", 0);

    // 2. Hashtags → caption mentions
    const wanted = params.hashtags?.length
      ? params.hashtags.map((h) => h.replace(/^#/, "").toLowerCase())
      : params.categories.flatMap((c) => params.cities.flatMap((city) => suggestHashtags(c, city))).slice(0, 10);
    const used = await ctx.ws((q) => q.many<{ hashtag: string }>(sql`select hashtag from hashtag_queries where first_queried_at > now() - interval '7 days'`));
    const usedSet = new Set(used.map((u) => u.hashtag));
    for (const tag of wanted) {
      if (!usedSet.has(tag) && usedSet.size >= MAX_HASHTAGS_PER_WEEK) {
        await ctx.log("warn", `Skipping #${tag}: Instagram allows ${MAX_HASHTAGS_PER_WEEK} unique hashtags per 7 days and that budget is used.`);
        continue;
      }
      if (!(await ctx.progress(0, null, `Searching #${tag}`))) return;
      try {
        const search = await graph<{ data?: { id: string }[] }>(ctx, cfg, "ig_hashtag_search", { user_id: cfg.igUserId, q: tag });
        const hashtagId = search.data?.[0]?.id;
        if (!hashtagId) continue;
        usedSet.add(tag);
        const media = await graph<{ data?: { caption?: string }[] }>(ctx, cfg, `${hashtagId}/recent_media`, { user_id: cfg.igUserId, fields: "caption,timestamp", limit: "50" });
        const mentions = new Set<string>();
        for (const m of media.data ?? []) for (const x of extractSignals(m.caption ?? "", "caption").mentions) mentions.add(x.value);
        await addCandidates(ctx, [...mentions], `hashtag:#${tag}`, 1);
        await ctx.ws((q) => q.exec(sql`insert into hashtag_queries (workspace_id, hashtag, hashtag_id, results) values (${ctx.workspaceId}, ${tag}, ${hashtagId}, ${mentions.size})
          on conflict (workspace_id, hashtag) do update set last_queried_at = now(), results = hashtag_queries.results + excluded.results`));
        await ctx.log("info", `#${tag}: ${mentions.size} handles mentioned in recent posts`);
      } catch (e) {
        await ctx.log("warn", `Hashtag #${tag} failed: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof IntegrationError && !e.retryable) break;
      }
    }

    // 3. Business Discovery lookups (snowball)
    let looked = 0;
    while (looked < params.limit) {
      const batch = await ctx.ws((q) => q.many<{ id: string; handle: string; depth: number }>(sql`
        select id, handle, depth from discovery_candidates where platform = 'instagram' and status = 'pending' and attempts < 3
        order by depth, created_at limit 20`));
      if (!batch.length) break;
      for (const c of batch) {
        if (looked >= params.limit) break;
        if (!(await ctx.progress(looked, params.limit, `Looking up @${c.handle}`))) return;
        looked++;
        try {
          const fields = "business_discovery.username(" + c.handle + "){id,username,name,biography,website,followers_count,follows_count,media_count,media.limit(12){caption,timestamp}}";
          const r = await graph<BusinessDiscovery>(ctx, cfg, cfg.igUserId, { fields });
          if (!r.business_discovery) {
            await ctx.ws((q) => q.exec(sql`update discovery_candidates set status = 'not_business', looked_up_at = now(), attempts = attempts + 1 where id = ${c.id}`));
            continue;
          }
          const p = businessToProspect(r.business_discovery);
          await ctx.ws((q) => q.exec(sql`update discovery_candidates set status = 'looked_up', looked_up_at = now(), attempts = attempts + 1 where id = ${c.id}`));
          if (c.depth < MAX_DEPTH) {
            const more = extractSignals(`${p.bio ?? ""}\n${p.extra_text ?? ""}`, "profile").mentions.map((m) => m.value).filter((h) => h !== c.handle);
            await addCandidates(ctx, more.slice(0, 15), `mention:@${c.handle}`, c.depth + 1);
          }
          yield p;
        } catch (e) {
          // Graph returns 400 for personal/non-existent accounts.
          const notFound = e instanceof IntegrationError && e.status === 400;
          await ctx.ws((q) => q.exec(sql`update discovery_candidates set status = ${notFound ? "not_found" : "error"}, attempts = attempts + 1,
            last_error = ${e instanceof Error ? e.message.slice(0, 300) : "error"}, looked_up_at = now() where id = ${c.id}`));
          if (e instanceof IntegrationError && (e.status === 401 || e.status === 403 || (e.status === 400 && /OAuthException.*(expired|session)/i.test(e.message)))) {
            throw new IntegrationError("Instagram access token is invalid or expired. Reconnect in Integrations.", e.status, false);
          }
        }
      }
    }
  },
};
