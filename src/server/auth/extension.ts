import { withSystem, sql } from "../db";
import { sha256 } from "./password";

export interface ExtensionUser {
  userId: string;
  workspaceId: string;
  name: string;
  role: string;
}

/** Resolve the browser extension's bearer token (stored hashed in integrations.config). */
export async function extensionUser(req: Request): Promise<ExtensionUser | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("obx_") || token.length < 30) return null;
  const hash = sha256(token);
  return withSystem((q) => q.maybe<ExtensionUser>(sql`
    select (t->>'userId')::uuid as "userId", i.workspace_id as "workspaceId", u.name, m.role
    from integrations i
    cross join lateral jsonb_array_elements(coalesce(i.config->'tokens', '[]'::jsonb)) t
    join users u on u.id = (t->>'userId')::uuid and u.disabled_at is null
    join workspace_members m on m.user_id = u.id and m.workspace_id = i.workspace_id and m.role <> 'viewer'
    where i.key = 'browser_extension' and t->>'hash' = ${hash}
    limit 1`));
}
