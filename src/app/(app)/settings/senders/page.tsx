import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Panel } from "@/components/ui/display";
import { SenderEditor } from "../forms";
import type { Channel } from "@/server/domain/taxonomy";

export const metadata = { title: "Sender accounts" };

export default async function SenderSettings() {
  const user = await requireUser();
  const senders = await asUser(user, (q) => q.many<{ id: string; channel: Channel; label: string; daily_cap: number; warmup_enabled: boolean; warmup_start_cap: number; warmup_step: number; warmup_started_on: Date; is_active: boolean; sent_today: number }>(sql`
    select a.id, a.channel, a.label, a.daily_cap, a.warmup_enabled, a.warmup_start_cap, a.warmup_step, a.warmup_started_on, a.is_active,
      (select count(*)::int from outreach_messages m where m.sender_account_id = a.id and m.sent_at >= date_trunc('day', now())) as sent_today
    from sender_accounts a where a.channel <> 'email' order by a.channel, a.created_at`));
  return (
    <>
      <Panel title="Social sender accounts" description="Instagram, TikTok and WhatsApp accounts you send DMs from yourself. Email mailboxes are connected in Data Sources → Sending accounts. Caps stop the send queue for the day; warm-up raises the cap gradually so new accounts aren't flagged.">
        <div className="space-y-5">
          {senders.map((s) => (
            <div key={s.id} className="border-b border-border pb-5 last:border-0 last:pb-0">
              <SenderEditor sender={{ ...s, warmup_started_on: new Date(s.warmup_started_on).toISOString() }} />
            </div>
          ))}
          {senders.length === 0 ? <p className="text-[12.5px] text-fg-3">No sender accounts yet.</p> : null}
        </div>
      </Panel>
      <Panel title="Add a sender account">
        <SenderEditor sender={{ id: null, channel: "instagram", label: "", daily_cap: 80, warmup_enabled: true, warmup_start_cap: 30, warmup_step: 15, warmup_started_on: new Date().toISOString(), is_active: true }} />
        <p className="mt-3 text-[11.5px] text-fg-3">Suggested caps per account: Instagram 80–100 · TikTok 50 · WhatsApp 80–100. Platforms don&apos;t publish exact limits; these are conservative.</p>
      </Panel>
    </>
  );
}
