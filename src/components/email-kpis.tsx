import { Panel } from "@/components/ui/display";
import type { EmailStats } from "@/server/services/email-metrics";
import { cn, fmtNum } from "@/lib/utils";

const pct = (r: number | null, digits = 1) => (r == null ? "—" : `${(r * 100).toFixed(digits)}%`);
const money = (n: number | null, cur: string | null) => (n == null || !cur ? "—" : `${cur} ${Math.round(n).toLocaleString()}`);

export function EmailKpis({ es, title = "Email performance" }: { es: EmailStats; title?: string }) {
  const rows: [string, string, string, boolean?][] = [
    ["Emails sent", fmtNum(es.sent), "all time, real sends"],
    ["Delivered (no bounce)", pct(es.rates.delivery), `${fmtNum(es.delivered)} presumed delivered after 48h`],
    ["Bounce rate", pct(es.rates.bounce), `${fmtNum(es.bounced)} bounced`, (es.rates.bounce ?? 0) > 0.05],
    ["Reply rate", pct(es.rates.reply), `${fmtNum(es.replied)} replied (auto-replies excluded)`],
    ["Positive reply rate", pct(es.rates.positive), `${fmtNum(es.positive)} interested / asking questions`],
    ["Unsubscribe rate", pct(es.rates.unsubscribe, 2), `${fmtNum(es.unsubscribed)} unsubscribed`],
    ["Signed up → activated → paid", `${fmtNum(es.signedUp)} → ${fmtNum(es.activated)} → ${fmtNum(es.paid)}`, "emailed prospects, via Orbit webhook/CSV"],
    ["Cost per activated", money(es.costPer.activated, es.costPer.currency), es.costs.length ? es.costs.map((c) => `${c.currency} ${Math.round(c.amount).toLocaleString()}`).join(" + ") + " spent" : "add costs on a campaign"],
    ["Cost per paid", money(es.costPer.paid, es.costPer.currency), es.costs.length > 1 ? "mixed currencies, not combined" : ""],
  ];
  return (
    <Panel title={title} padded={false}>
      <dl className="divide-y divide-border">
        {rows.map(([k, v, hint, bad]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 px-4 py-2">
            <dt className="text-[12.5px] text-fg-2">{k}{hint ? <span className="block text-[11.5px] text-fg-3">{hint}</span> : null}</dt>
            <dd className={cn("text-[14px] font-semibold tabular", bad && "text-danger")}>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

