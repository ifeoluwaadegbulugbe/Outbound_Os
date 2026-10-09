import { sql, raw, and, or, textArray, type SqlFragment } from "../db/sql";
import { FIELD_DEFS, isGroup, isNot, type Condition, type FilterNode } from "./filters";

/**
 * Compile a FilterNode into a parameterized SQL predicate over `prospects p`.
 * Column expressions come only from this hard-coded map, values are always
 * bind parameters.
 */
const COLUMN: Record<string, string> = {
  business_name: "p.business_name",
  bio: "coalesce(p.bio, p.description, '')",
  category: "p.category",
  city: "p.city",
  state: "p.state",
  country: "p.country",
  area: "p.area",
  status: "p.status",
  source: "p.source",
  icp_score: "p.icp_score",
  priority_score: "p.priority_score",
  intent_score: "p.intent_score",
  fit_score: "p.fit_score",
  completeness_score: "p.completeness_score",
  follower_count: "p.follower_count",
  posting_frequency: "p.posting_frequency",
  days_since_post: "extract(day from now() - p.last_post_date)",
  contact_count: "p.contact_count",
  services: "p.services",
};

const BOOL: Record<string, string> = {
  active: "(p.last_post_date >= now() - interval '30 days')",
  accepts_bookings: "(p.accepts_bookings is true or (p.signals->'acceptsBookings'->>'value')::boolean is true)",
  has_booking_link: "(p.booking_url is not null or p.has_booking_link is true)",
  accepts_whatsapp_bookings: "(p.accepts_whatsapp_bookings is true or (p.signals->'whatsappBookings'->>'value')::boolean is true)",
  dm_bookings: "((p.signals->'dmBookings'->>'value')::boolean is true)",
  has_website: "(p.website is not null or p.has_website is true)",
  has_instagram: "(p.instagram_handle is not null)",
  has_tiktok: "(p.tiktok_handle is not null)",
  has_phone: "(p.phone is not null or p.whatsapp is not null)",
  has_email: "(p.email is not null)",
  uses_booking_software: "(p.has_client_management_system is true or p.signals ? 'schedulingTool')",
  contacted: "(p.contact_count > 0)",
  signed_up: "(p.signed_up)",
  activated: "(p.activated)",
  paid: "(p.paid)",
  do_not_contact: "(p.do_not_contact)",
  is_demo: "(p.is_demo)",
};

function ci(field: string): boolean {
  return ["city", "state", "country", "area", "source", "business_name", "bio"].includes(field);
}

function compileCondition(c: Condition): SqlFragment {
  const def = FIELD_DEFS[c.field];
  if (!def) throw new Error(`Unknown field ${c.field}`);
  if (def.type === "boolean") {
    const expr = raw(BOOL[c.field]);
    if (c.cmp === "is_false" || (c.cmp === "eq" && c.value === false)) return sql`(not coalesce(${expr}, false))`;
    return sql`coalesce(${expr}, false)`;
  }
  const col = raw(COLUMN[c.field]);
  const v = c.value;
  if (c.cmp === "is_set") return def.type === "array" ? sql`cardinality(${col}) > 0` : sql`${col} is not null`;
  if (c.cmp === "is_not_set") return def.type === "array" ? sql`cardinality(${col}) = 0` : sql`${col} is null`;

  if (def.type === "array") {
    const items = Array.isArray(v) ? v : [String(v ?? "")];
    if (c.cmp === "not_contains" || c.cmp === "not_in") return sql`not (${col} && ${textArray(items)})`;
    return sql`${col} && ${textArray(items)}`;
  }
  if (def.type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${def.label} needs a number`);
    const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[c.cmp as "eq"];
    if (!op) throw new Error(`Unsupported comparison for ${def.label}`);
    return sql`${col} ${raw(op)} ${n}`;
  }
  // text / enum
  const lowerCol = ci(c.field) ? sql`lower(${col})` : col;
  const norm = (x: unknown) => (ci(c.field) ? String(x).toLowerCase() : String(x));
  switch (c.cmp) {
    case "eq":
      return sql`${lowerCol} = ${norm(v)}`;
    case "neq":
      return sql`${lowerCol} is distinct from ${norm(v)}`;
    case "contains":
      return sql`${col} ilike ${"%" + String(v).replace(/[%_\\]/g, "\\$&") + "%"}`;
    case "not_contains":
      return sql`coalesce(${col}, '') not ilike ${"%" + String(v).replace(/[%_\\]/g, "\\$&") + "%"}`;
    case "in":
    case "not_in": {
      const items = (Array.isArray(v) ? v : [String(v)]).map(norm);
      const inExpr = sql`${lowerCol} = any(${textArray(items)})`;
      return c.cmp === "in" ? inExpr : sql`not coalesce(${inExpr}, false)`;
    }
    default:
      throw new Error(`Unsupported comparison ${c.cmp} for ${def.label}`);
  }
}

export function compileFilter(n: FilterNode | null | undefined): SqlFragment {
  if (!n) return sql`true`;
  if (isGroup(n)) {
    if (!n.children.length) return sql`true`;
    const parts = n.children.map(compileFilter);
    return n.op === "and" ? and(parts) : or(parts);
  }
  if (isNot(n)) return sql`(not coalesce(${compileFilter(n.child)}, false))`;
  return compileCondition(n);
}
