import { NextResponse } from "next/server";
import { withSystem, withWorkspace, sql } from "@/server/db";
import { destinationFor, isBot } from "@/server/services/links";
import { logEvent } from "@/server/services/audit";

/**
 * Public redirector for tracked links. Records the click (excluding link
 * previews/bots), marks the prospect as having visited, and redirects to the
 * product with UTM params + opaque ref code.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return new NextResponse("Not found", { status: 404 });
  const link = await withSystem((q) =>
    q.maybe<{ id: string; workspace_id: string; prospect_id: string | null; campaign_id: string | null; channel: string | null; destination_url: string; utm: Record<string, string>; code: string }>(
      sql`select id, workspace_id, prospect_id, campaign_id, channel, destination_url, utm, code from tracked_links where code = ${code}`,
    ),
  );
  if (!link) return new NextResponse("This link has expired.", { status: 404 });

  const ua = req.headers.get("user-agent");
  const bot = isBot(ua);
  let referrerHost: string | null = null;
  try {
    referrerHost = req.headers.get("referer") ? new URL(req.headers.get("referer")!).hostname : null;
  } catch {
    referrerHost = null;
  }
  try {
    await withWorkspace({ workspaceId: link.workspace_id }, async (q) => {
      await q.exec(sql`insert into link_clicks (workspace_id, link_id, referrer_host, is_bot) values (${link.workspace_id}, ${link.id}, ${referrerHost}, ${bot})`);
      if (!bot) {
        await q.exec(sql`update tracked_links set clicks = clicks + 1, first_clicked_at = coalesce(first_clicked_at, now()), last_clicked_at = now() where id = ${link.id}`);
        if (link.prospect_id) {
          await q.exec(sql`update prospects set visited_product = true where id = ${link.prospect_id}`);
          await logEvent(q, { workspaceId: link.workspace_id, actorType: "system" }, { type: "link.clicked", prospectId: link.prospect_id, campaignId: link.campaign_id, channel: link.channel });
        }
      }
    });
  } catch (e) {
    // Never block the redirect on tracking.
    console.error("[r] click tracking failed", e);
  }
  return NextResponse.redirect(destinationFor(link), 302);
}
