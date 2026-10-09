import { sql, raw, type Q } from "../db";
import { rescoreProspect } from "./scoring-service";
import { audit, logEvent, type ActorCtx } from "./audit";

const FILL_COLUMNS = [
  "owner_name", "first_name", "last_name", "category", "subcategory", "description", "bio", "business_size", "country", "state", "city", "area", "timezone",
  "lat", "lng", "tiktok_url", "tiktok_handle", "instagram_url", "instagram_handle", "linkedin_url", "facebook_url", "youtube_url", "email", "phone", "whatsapp",
  "website", "website_domain", "booking_url", "follower_count", "posting_frequency", "accepts_bookings", "has_booking_link", "accepts_whatsapp_bookings",
  "accepts_online_payments", "has_website", "has_client_management_system", "first_contacted_at", "replied_at", "interested_at", "signup_at", "activation_at", "paid_at",
];

/**
 * Merge `dropId` into `keepId` after a human confirmed they're the same
 * business. Fill-only for fields; all history moves to the kept record; the
 * dropped record stays as a tombstone (merged_into) for traceability.
 */
export async function mergeProspects(q: Q, actor: ActorCtx, keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) throw new Error("Can't merge a prospect into itself");
  const both = await q.many<{ id: string; merged_into: string | null }>(sql`select id, merged_into from prospects where id in (${keepId}, ${dropId})`);
  if (both.length !== 2 || both.some((b) => b.merged_into)) throw new Error("One of these prospects was already merged");

  // Uniqueness: a handle can only live on one live record — clear it from the dropped one first.
  const drop = await q.one<Record<string, unknown>>(sql`select * from prospects where id = ${dropId}`);
  await q.exec(sql`update prospects set instagram_handle = null, tiktok_handle = null where id = ${dropId}`);
  for (const col of FILL_COLUMNS) {
    if (drop[col] == null) continue;
    await q.exec(sql`update prospects set ${raw(col)} = coalesce(${raw(col)}, ${drop[col] as never}) where id = ${keepId}`);
  }
  await q.exec(sql`update prospects k set
      services = (select array(select distinct unnest(k.services || d.services))),
      signals = d.signals || k.signals,
      contact_count = k.contact_count + d.contact_count,
      last_contacted_at = greatest(k.last_contacted_at, d.last_contacted_at),
      last_post_date = greatest(k.last_post_date, d.last_post_date),
      signed_up = k.signed_up or d.signed_up, activated = k.activated or d.activated, paid = k.paid or d.paid,
      visited_product = k.visited_product or d.visited_product,
      do_not_contact = k.do_not_contact or d.do_not_contact,
      dnc_reason = coalesce(k.dnc_reason, d.dnc_reason),
      discovered_at = least(k.discovered_at, d.discovered_at)
    from prospects d where k.id = ${keepId} and d.id = ${dropId}`);
  // Move history
  for (const t of ["prospect_sources", "prospect_scores", "prospect_research", "prospect_notes", "outreach_messages", "outreach_events", "followups", "conversions", "tracked_links", "dnc_entries"]) {
    await q.exec(sql`update ${raw(t)} set prospect_id = ${keepId} where prospect_id = ${dropId}`);
  }
  await q.exec(sql`insert into campaign_prospects (workspace_id, campaign_id, prospect_id, added_at)
                   select workspace_id, campaign_id, ${keepId}, added_at from campaign_prospects where prospect_id = ${dropId} on conflict do nothing`);
  await q.exec(sql`delete from campaign_prospects where prospect_id = ${dropId}`);
  await q.exec(sql`insert into prospect_social_profiles (workspace_id, prospect_id, platform, handle, url, followers, following, posts, bio, last_post_at, posting_frequency, fetched_at, source)
                   select workspace_id, ${keepId}, platform, handle, url, followers, following, posts, bio, last_post_at, posting_frequency, fetched_at, source
                   from prospect_social_profiles where prospect_id = ${dropId} on conflict do nothing`);
  // Conversations: unique per (prospect, channel) — move messages into the kept thread when both exist.
  const convs = await q.many<{ id: string; channel: string }>(sql`select id, channel from conversations where prospect_id = ${dropId}`);
  for (const c of convs) {
    const target = await q.maybe<{ id: string }>(sql`select id from conversations where prospect_id = ${keepId} and channel = ${c.channel}`);
    if (target) {
      await q.exec(sql`update conversation_messages set conversation_id = ${target.id} where conversation_id = ${c.id}`);
      await q.exec(sql`delete from conversations where id = ${c.id}`);
    } else await q.exec(sql`update conversations set prospect_id = ${keepId} where id = ${c.id}`);
  }
  await q.exec(sql`update prospects set merged_into = ${keepId}, archived_at = now() where id = ${dropId}`);
  await q.exec(sql`update possible_duplicates set status = 'merged', resolved_by = ${actor.actorId ?? null}, resolved_at = now()
                   where (prospect_a = ${dropId} or prospect_b = ${dropId}) and status = 'pending'`);
  await rescoreProspect(q, keepId);
  await logEvent(q, actor, { type: "prospect.merged", prospectId: keepId, data: { merged: dropId, source: "manual merge" } });
  await audit(q, actor, "prospect.merged", "prospect", keepId, { dropped: dropId });
}
