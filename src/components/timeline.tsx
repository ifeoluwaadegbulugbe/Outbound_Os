import { CHANNEL_LABELS, type Channel, STATUS_LABELS, type ProspectStatus } from "@/server/domain/taxonomy";
import { INTENT_LABELS, type ReplyIntent } from "@/server/domain/classifier";

const ch = (c: string | null | undefined) => (c ? CHANNEL_LABELS[c as Channel] ?? c : "");

/** Human sentence for an outreach_events row. */
export function describeEvent(type: string, data: Record<string, unknown> | null, channel?: string | null): string {
  const d = data ?? {};
  switch (type) {
    case "prospect.discovered":
      return `was discovered via ${String(d.source ?? "a source").replace(/_/g, " ")}`;
    case "prospect.merged":
      return `was matched to an existing record (${String(d.source ?? "")})`;
    case "prospect.scored":
      return `was scored ${d.icp ?? ""}`;
    case "message.generated":
      return `— ${channel ? `${ch(channel)} ` : ""}message drafted${d.generator ? ` (${String(d.generator)})` : ""}`;
    case "message.edited":
      return "— message edited";
    case "message.approved":
      return "— message approved";
    case "message.rejected":
      return "— message rejected";
    case "message.blocked":
      return `— message blocked: ${String(d.reason ?? "failed validation")}`;
    case "message.sent":
      return `was contacted on ${ch(channel)}`;
    case "message.skipped":
      return "— skipped";
    case "followup.scheduled":
      return `— follow-up scheduled`;
    case "reply.received":
      return `replied on ${ch(channel)}`;
    case "reply.classified":
      return `— reply classified as ${INTENT_LABELS[d.intent as ReplyIntent] ?? String(d.intent)}`;
    case "status.changed":
      return `moved to ${STATUS_LABELS[d.to as ProspectStatus] ?? String(d.to)}`;
    case "link.clicked":
      return "clicked their tracked link";
    case "conversion.signup":
      return "signed up 🎉";
    case "conversion.activated":
      return "activated their account";
    case "conversion.paid":
      return `became a paying customer${d.plan ? ` (${String(d.plan)})` : ""}`;
    case "dnc.added":
      return `was added to do-not-contact (${String(d.reason ?? "").replace(/_/g, " ")})`;
    case "note.added":
      return "— note added";
    default:
      return type.replace(/[._]/g, " ");
  }
}
