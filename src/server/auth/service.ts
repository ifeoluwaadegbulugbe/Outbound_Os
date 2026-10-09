import type { Driver } from "../db/driver";
import { withSystem, withWorkspace, sql } from "../db";
import { hashPassword, verifyPassword, newToken, sha256 } from "./password";
import { audit } from "../services/audit";
import { seedWorkspaceDefaults } from "../services/workspace-defaults";

/**
 * Authentication core, framework-agnostic (testable without Next.js).
 * Sessions: random 256-bit token in an httpOnly cookie; only its SHA-256 is
 * stored, so a database leak doesn't leak usable sessions.
 */

export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  productName: string;
}

export const SESSION_TTL_DAYS = 30;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function hasAnyUser(driver?: Driver): Promise<boolean> {
  return withSystem((q) => q.value<boolean>(sql`select exists(select 1 from users)`), driver);
}

/** First-run setup: create workspace + owner. Refuses if any user exists. */
export async function setupFirstOwner(
  input: { workspaceName: string; productName: string; name: string; email: string; password: string },
  driver?: Driver,
): Promise<{ userId: string; workspaceId: string }> {
  const passwordHash = await hashPassword(input.password);
  const res = await withSystem(async (q) => {
    // Serialize concurrent setup attempts.
    await q.exec(sql`lock table users in exclusive mode`);
    if (await q.value<boolean>(sql`select exists(select 1 from users)`)) throw new AuthError("Setup has already been completed.");
    const slug = input.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
    const workspaceId = await q.value<string>(
      sql`insert into workspaces (name, slug, product_name) values (${input.workspaceName}, ${slug}, ${input.productName}) returning id`,
    );
    const userId = await q.value<string>(
      sql`insert into users (email, name, password_hash) values (${input.email.trim().toLowerCase()}, ${input.name}, ${passwordHash}) returning id`,
    );
    await q.exec(sql`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner')`);
    return { userId, workspaceId };
  }, driver);
  await withWorkspace({ workspaceId: res.workspaceId, userId: res.userId }, async (q) => {
    await seedWorkspaceDefaults(q, res.workspaceId);
    await audit(q, { workspaceId: res.workspaceId, actorType: "user", actorId: res.userId }, "workspace.created", "workspace", res.workspaceId);
  }, driver);
  return res;
}

export async function login(email: string, password: string, userAgent: string | null, driver?: Driver): Promise<{ token: string; user: SessionUser }> {
  const e = email.trim().toLowerCase();
  const recentFailures = await withSystem(
    (q) => q.value<number>(sql`select count(*)::int from login_attempts where lower(email) = ${e} and ok = false and created_at > now() - make_interval(mins => ${LOCKOUT_MINUTES})`),
    driver,
  );
  if (recentFailures >= MAX_FAILED_LOGINS) throw new AuthError(`Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);

  const user = await withSystem(
    (q) => q.maybe<{ id: string; password_hash: string; disabled_at: Date | null }>(sql`select id, password_hash, disabled_at from users where lower(email) = ${e}`),
    driver,
  );
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, DUMMY_HASH);
  await withSystem((q) => q.exec(sql`insert into login_attempts (email, ok) values (${e}, ${Boolean(ok && user && !user.disabled_at)})`), driver);
  if (!user || !ok) throw new AuthError("Email or password is incorrect.");
  if (user.disabled_at) throw new AuthError("This account has been disabled.");

  const membership = await withSystem(
    (q) => q.maybe<{ workspace_id: string }>(sql`select workspace_id from workspace_members where user_id = ${user.id} order by created_at limit 1`),
    driver,
  );
  if (!membership) throw new AuthError("You don't have access to any workspace yet. Ask an admin to add you.");

  const token = newToken();
  const sessionId = await withSystem(async (q) => {
    await q.exec(sql`update users set last_login_at = now() where id = ${user.id}`);
    return q.value<string>(
      sql`insert into sessions (token_hash, user_id, workspace_id, expires_at, user_agent)
          values (${sha256(token)}, ${user.id}, ${membership.workspace_id}, now() + make_interval(days => ${SESSION_TTL_DAYS}), ${userAgent?.slice(0, 300) ?? null})
          returning id`,
    );
  }, driver);
  const su = await sessionUserById(sessionId, driver);
  if (!su) throw new AuthError("Could not start session.");
  await withWorkspace({ workspaceId: su.workspaceId, userId: su.userId }, (q) =>
    audit(q, { workspaceId: su.workspaceId, actorType: "user", actorId: su.userId }, "auth.login", "user", su.userId), driver);
  return { token, user: su };
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

const SESSION_SELECT = sql`
  select s.id as "sessionId", u.id as "userId", u.email, u.name, m.role, w.id as "workspaceId",
         w.name as "workspaceName", w.product_name as "productName", s.last_seen_at
  from sessions s
  join users u on u.id = s.user_id and u.disabled_at is null
  join workspace_members m on m.user_id = u.id and m.workspace_id = s.workspace_id
  join workspaces w on w.id = s.workspace_id
  where s.expires_at > now()`;

async function sessionUserById(id: string, driver?: Driver): Promise<SessionUser | null> {
  return withSystem((q) => q.maybe<SessionUser>(sql`${SESSION_SELECT} and s.id = ${id}`), driver);
}

export async function sessionFromToken(token: string, driver?: Driver): Promise<SessionUser | null> {
  if (!token || token.length < 20) return null;
  return withSystem(async (q) => {
    const row = await q.maybe<SessionUser & { last_seen_at: Date }>(sql`${SESSION_SELECT} and s.token_hash = ${sha256(token)}`);
    if (!row) return null;
    // Touch at most every 10 minutes to avoid a write per request.
    if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60_000) {
      await q.exec(sql`update sessions set last_seen_at = now() where id = ${row.sessionId}`);
    }
    const { last_seen_at: _unused, ...user } = row;
    return user;
  }, driver);
}

export async function logout(token: string, driver?: Driver): Promise<void> {
  await withSystem((q) => q.exec(sql`delete from sessions where token_hash = ${sha256(token)}`), driver);
}

/** Add a teammate (admin action). Returns a one-time password if none supplied. */
export async function addMember(
  ctx: { workspaceId: string; actorId: string },
  input: { email: string; name: string; role: Role; password: string },
  driver?: Driver,
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const hash = await hashPassword(input.password);
  const userId = await withSystem(async (q) => {
    const existing = await q.maybe<{ id: string }>(sql`select id from users where lower(email) = ${email}`);
    const id = existing?.id ?? (await q.value<string>(sql`insert into users (email, name, password_hash) values (${email}, ${input.name}, ${hash}) returning id`));
    await q.exec(sql`insert into workspace_members (workspace_id, user_id, role) values (${ctx.workspaceId}, ${id}, ${input.role})
                     on conflict (workspace_id, user_id) do update set role = excluded.role`);
    return id;
  }, driver);
  await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.actorId }, (q) =>
    audit(q, { workspaceId: ctx.workspaceId, actorType: "user", actorId: ctx.actorId }, "team.member_added", "user", userId, { email, role: input.role }), driver);
  return userId;
}
