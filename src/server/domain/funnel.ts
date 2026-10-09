/** Funnel stage definitions (pure — safe for client components). */
export const FUNNEL_STAGES = [
  { key: "discovered", label: "Discovered", column: "p.discovered_at", where: "true" },
  { key: "qualified", label: "Qualified", column: "p.qualified_at", where: "p.qualified_at is not null" },
  { key: "contacted", label: "Contacted", column: "p.first_contacted_at", where: "p.first_contacted_at is not null" },
  { key: "replied", label: "Replied", column: "p.replied_at", where: "p.replied_at is not null" },
  { key: "interested", label: "Interested", column: "p.interested_at", where: "p.interested_at is not null" },
  { key: "signed_up", label: "Signed up", column: "p.signup_at", where: "p.signed_up" },
  { key: "activated", label: "Activated", column: "p.activation_at", where: "p.activated" },
  { key: "paid", label: "Paid", column: "p.paid_at", where: "p.paid" },
] as const;

export type FunnelKey = (typeof FUNNEL_STAGES)[number]["key"];
export type Funnel = Record<FunnelKey, number>;
