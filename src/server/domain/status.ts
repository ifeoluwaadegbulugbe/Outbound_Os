import type { ProspectStatus } from "./taxonomy";

/**
 * Prospect lifecycle. Transitions are explicit so the pipeline can't drift
 * into impossible states (e.g. un-paying a customer, or silently resuming
 * outreach to someone who opted out).
 */

const PRE_CONTACT: ProspectStatus[] = ["NEW", "RESEARCHING", "QUALIFIED", "READY", "APPROVED"];
const CONVERTED: ProspectStatus[] = ["SIGNED_UP", "ACTIVATED", "PAID"];

const T: Record<ProspectStatus, ProspectStatus[]> = {
  NEW: ["RESEARCHING", "QUALIFIED", "READY", "LOST"],
  RESEARCHING: ["NEW", "QUALIFIED", "READY", "LOST"],
  QUALIFIED: ["NEW", "RESEARCHING", "READY", "APPROVED", "LOST"],
  READY: ["QUALIFIED", "APPROVED", "CONTACTED", "LOST"],
  APPROVED: ["READY", "QUALIFIED", "CONTACTED", "LOST"],
  CONTACTED: ["REPLIED", "FOLLOW_UP", "INTERESTED", "NOT_INTERESTED", "DEMO", "LOST"],
  FOLLOW_UP: ["CONTACTED", "REPLIED", "INTERESTED", "NOT_INTERESTED", "DEMO", "LOST"],
  REPLIED: ["INTERESTED", "NOT_INTERESTED", "FOLLOW_UP", "DEMO", "CONTACTED", "LOST"],
  INTERESTED: ["DEMO", "FOLLOW_UP", "NOT_INTERESTED", "REPLIED", "LOST"],
  DEMO: ["INTERESTED", "FOLLOW_UP", "NOT_INTERESTED", "LOST"],
  NOT_INTERESTED: ["FOLLOW_UP", "INTERESTED", "LOST", "REPLIED"],
  LOST: ["NEW", "QUALIFIED", "FOLLOW_UP"],
  SIGNED_UP: ["ACTIVATED", "PAID"],
  ACTIVATED: ["PAID"],
  PAID: [],
  DO_NOT_CONTACT: [],
};

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

/**
 * @param force admin override (e.g. restoring a prospect wrongly marked DNC)
 */
export function canTransition(from: ProspectStatus, to: ProspectStatus, opts: { force?: boolean } = {}): TransitionCheck {
  if (from === to) return { ok: true };
  // Opt-out / suppression is always allowed, from anywhere.
  if (to === "DO_NOT_CONTACT") return { ok: true };
  // Conversions come from the product (webhook) and can happen at any point
  // before conversion, but never move backwards.
  if (CONVERTED.includes(to)) {
    if (from === "DO_NOT_CONTACT" && !opts.force) {
      // A suppressed prospect can still sign up on their own — record it.
      return { ok: true };
    }
    const order = CONVERTED.indexOf(to);
    const fromOrder = CONVERTED.indexOf(from);
    if (fromOrder >= order) return { ok: false, reason: `Already ${from.toLowerCase().replace("_", " ")}` };
    return { ok: true };
  }
  if (from === "DO_NOT_CONTACT") {
    return opts.force && ["NEW", "QUALIFIED"].includes(to)
      ? { ok: true }
      : { ok: false, reason: "Prospect is on the do-not-contact list. An admin must restore it first." };
  }
  if (CONVERTED.includes(from)) return { ok: false, reason: "Converted prospects can't move back in the pipeline" };
  if (T[from].includes(to)) return { ok: true };
  if (opts.force) return { ok: true };
  return { ok: false, reason: `Can't move from ${from} to ${to}` };
}

export function isPreContact(s: ProspectStatus): boolean {
  return PRE_CONTACT.includes(s);
}

export function isConverted(s: ProspectStatus): boolean {
  return CONVERTED.includes(s);
}

/** Whether outreach (initial or follow-up) may be sent at all. */
export function outreachBlockReason(p: { status: ProspectStatus; do_not_contact: boolean }): string | null {
  if (p.do_not_contact || p.status === "DO_NOT_CONTACT") return "Prospect is on the do-not-contact list";
  if (isConverted(p.status)) return "Prospect has already converted";
  if (p.status === "LOST") return "Prospect is marked lost";
  if (p.status === "NOT_INTERESTED") return "Prospect said they're not interested";
  return null;
}
