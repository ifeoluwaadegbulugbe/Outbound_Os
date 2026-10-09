import { Badge } from "./display";
import { STATUS_LABELS, type ProspectStatus, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { INTENT_LABELS, type ReplyIntent } from "@/server/domain/classifier";

const STATUS_TONE: Record<ProspectStatus, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  NEW: "neutral",
  RESEARCHING: "neutral",
  QUALIFIED: "info",
  READY: "info",
  APPROVED: "info",
  CONTACTED: "warning",
  FOLLOW_UP: "warning",
  REPLIED: "accent",
  INTERESTED: "accent",
  DEMO: "accent",
  NOT_INTERESTED: "neutral",
  SIGNED_UP: "success",
  ACTIVATED: "success",
  PAID: "success",
  LOST: "neutral",
  DO_NOT_CONTACT: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as ProspectStatus;
  return <Badge tone={STATUS_TONE[s] ?? "neutral"} dot>{STATUS_LABELS[s] ?? status}</Badge>;
}

const MSG_TONE: Record<string, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  draft: "neutral", needs_review: "warning", approved: "info", rejected: "neutral", scheduled: "info",
  sent: "success", skipped: "neutral", blocked: "danger", failed: "danger",
};
const MSG_LABEL: Record<string, string> = {
  draft: "Draft", needs_review: "Needs review", approved: "Approved", rejected: "Rejected", scheduled: "Scheduled",
  sent: "Sent", skipped: "Skipped", blocked: "Blocked", failed: "Failed",
};
export function MessageStatusBadge({ status }: { status: string }) {
  return <Badge tone={MSG_TONE[status] ?? "neutral"}>{MSG_LABEL[status] ?? status}</Badge>;
}

export function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return null;
  const tone = intent === "opt_out" ? "danger" : ["interested", "pricing", "signup_intent", "demo_request"].includes(intent) ? "accent" : intent === "not_interested" || intent === "competitor" ? "neutral" : "info";
  return <Badge tone={tone}>{INTENT_LABELS[intent as ReplyIntent] ?? intent}</Badge>;
}

export function ChannelLabel({ channel }: { channel: string | null }) {
  if (!channel) return <span className="text-fg-3">—</span>;
  return <span className="text-fg-2">{CHANNEL_LABELS[channel as Channel] ?? channel}</span>;
}
