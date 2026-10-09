import { sql, or, type Q } from "../db";
import { defaultPolicy } from "../domain/locations";
import { domainOfEmail } from "./address";

/**
 * Email sending policy: sender identity, which verification statuses may be
 * sent to, safety thresholds, campaign compliance checklist, and per-recipient
 * eligibility (suppression, country rules, verification).
 */

export interface EmailSettings {
  sender: { senderName: string; company: string; address: string | null };
  allowedStatuses: string[];
  autoVerifyBeforeSend: boolean;
  safety: { maxBounceRate: number; maxComplaintRate: number; minSample: number };
  defaultCountry: string;
  requireReviewForNew: boolean;
}

export const EMAIL_STATUS_LABELS: Record<string, string> = {
  none: "No email found",
  unverified: "Not verified yet",
  verified: "Verified",
  unknown: "Deliverability unknown",
  catch_all: "Catch-all domain",
  risky: "Risky",
  invalid: "Invalid",
};

export const DEFAULT_ALLOWED_STATUSES = ["verified", "unknown", "catch_all"];

export async function getEmailSettings(q: Q, workspaceId: string): Promise<EmailSettings> {
  const w = await q.one<{ name: string; product_name: string; settings: Record<string, unknown> }>(sql`select name, product_name, settings from workspaces where id = ${workspaceId}`);
  const s = (w.settings ?? {}) as Record<string, Record<string, unknown> | unknown>;
  const sender = (s.sender ?? {}) as Record<string, string | null>;
  const policy = (s.emailPolicy ?? {}) as Record<string, unknown>;
  const safety = (s.safety ?? {}) as Record<string, number>;
  return {
    sender: { senderName: (sender.senderName as string) || "", company: (sender.company as string) || w.product_name, address: (sender.address as string) || null },
    allowedStatuses: Array.isArray(policy.allowedStatuses) ? (policy.allowedStatuses as string[]) : DEFAULT_ALLOWED_STATUSES,
    autoVerifyBeforeSend: policy.autoVerifyBeforeSend !== false,
    safety: { maxBounceRate: safety.maxBounceRate ?? 0.05, maxComplaintRate: safety.maxComplaintRate ?? 0.003, minSample: safety.minSample ?? 20 },
    defaultCountry: (s.defaultCountry as string) || "NG",
    requireReviewForNew: policy.requireReviewForNew !== false,
  };
}

export interface CampaignCompliance {
  relevanceConfirmed?: boolean;
  sourcesPermitUse?: boolean;
  countryRulesReviewed?: boolean;
  liaDocumented?: boolean;
  by?: string;
  at?: string;
}

export const COMPLIANCE_ITEMS: { key: keyof CampaignCompliance; label: string; help: string }[] = [
  { key: "relevanceConfirmed", label: "The offer is relevant to every business in this campaign", help: "Targeted, business-to-business, about their operations — not generic marketing." },
  { key: "sourcesPermitUse", label: "Our data sources permit contacting these businesses", help: "Emails come from the business's own public site, open data, or lists we have the right to use." },
  { key: "countryRulesReviewed", label: "Country rules reviewed for every target country", help: "Consent-required countries (e.g. ZA, GH, KE) are blocked unless consent exists." },
  { key: "liaDocumented", label: "Legitimate Interest Assessment documented (Nigeria)", help: "Required by the NDPC for reliance on legitimate interest — see docs/outreach-compliance.md." },
];

export async function campaignReadiness(q: Q, campaignId: string | null, settings: EmailSettings): Promise<{ ready: boolean; missing: string[] }> {
  const missing: string[] = [];
  if (!settings.sender.senderName) missing.push("Sender name (Settings → Email & sender)");
  if (!settings.sender.address) missing.push("Business postal address for the email footer (Settings → Email & sender)");
  if (campaignId) {
    const c = await q.maybe<{ status: string; compliance: CampaignCompliance }>(sql`select status, compliance from campaigns where id = ${campaignId}`);
    if (c) {
      if (c.status !== "active") missing.push(`Campaign is ${c.status}`);
      for (const item of COMPLIANCE_ITEMS) if (!c.compliance?.[item.key]) missing.push(`Compliance check: ${item.label}`);
    }
  }
  return { ready: missing.length === 0, missing };
}

export interface RecipientCheck {
  ok: boolean;
  reasons: string[];
  needsVerification: boolean;
}

export async function recipientEligibility(
  q: Q,
  p: { id: string; email: string | null; email_status: string; country: string | null; do_not_contact: boolean; unsubscribed: boolean; bounced: boolean; status: string },
  settings: EmailSettings,
): Promise<RecipientCheck> {
  const reasons: string[] = [];
  if (!p.email) return { ok: false, reasons: ["No email address"], needsVerification: false };
  const email = p.email.toLowerCase();
  if (p.do_not_contact || p.status === "DO_NOT_CONTACT") reasons.push("Prospect is on the do-not-contact list");
  if (p.unsubscribed) reasons.push("Recipient unsubscribed");
  if (p.bounced) reasons.push("A previous email to this address bounced");
  if (["SIGNED_UP", "ACTIVATED", "PAID"].includes(p.status)) reasons.push("Already an Orbit user");
  const sup = await q.maybe<{ kind: string; reason: string }>(sql`
    select kind, reason from dnc_entries where ${or([sql`(kind = 'email' and value = ${email})`, sql`(kind = 'domain' and value = ${domainOfEmail(email)})`, sql`(kind = 'prospect' and value = ${p.id})`])} limit 1`);
  if (sup) reasons.push(`Suppressed (${sup.kind}: ${sup.reason.replace("_", " ")})`);
  const cc = (p.country ?? settings.defaultCountry).toUpperCase();
  const policy = await q.maybe<{ cold_email: string; legal_basis: string | null }>(sql`select cold_email, legal_basis from country_policies where country_code = ${cc}`) ?? defaultPolicy(cc);
  if (policy.cold_email !== "allowed") reasons.push(`Cold email is ${policy.cold_email === "blocked" ? "blocked" : "consent-only"} for ${cc} (${policy.legal_basis ?? "policy"}) — change it in Settings → Countries only after legal review`);
  const needsVerification = p.email_status === "unverified";
  if (!needsVerification && !settings.allowedStatuses.includes(p.email_status)) {
    reasons.push(`Email status is “${p.email_status.replace("_", " ")}” — not allowed by your sending policy`);
  }
  return { ok: reasons.length === 0, reasons, needsVerification };
}
